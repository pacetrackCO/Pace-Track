const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../timer_sector/scriptsSector.js'), 'utf8');
const sessionApiSource = fs.readFileSync(path.join(__dirname, '../timing/session-api.js'), 'utf8');

class Element {
    constructor() {
        this.style = {};
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.listeners = {};
    }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    replaceChildren() {}
    focus() { this.focused = true; }
    select() { this.selected = true; }
}

class FakePeerConnection {
    constructor(configuration) {
        this.configuration = configuration;
        this.connectionState = 'new';
        this.iceConnectionState = 'new';
        this.iceGatheringState = 'complete';
        this.instanceId = FakePeerConnection.instances.length;
        this.addedCandidates = [];
        this.closed = false;
        FakePeerConnection.instances.push(this);
    }
    createDataChannel(label) {
        return { label, readyState: 'connecting', close() { this.readyState = 'closed'; } };
    }
    async createOffer() { return { type: 'offer', sdp: `v=0\r\no=- offer-${this.instanceId}\r\n` }; }
    async createAnswer() { return { type: 'answer', sdp: `v=0\r\no=- answer-${this.instanceId}\r\n` }; }
    async setLocalDescription(description) { this.localDescription = description; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async addIceCandidate(candidate) { this.addedCandidates.push(candidate); }
    close() { this.closed = true; }
}
FakePeerConnection.instances = [];

class FakeSessionService {
    constructor({ deferredCreate = false } = {}) {
        this.sessions = new Map();
        this.requests = [];
        this.createCalls = [];
        this.joinCalls = [];
        this.nextSession = 1;
        this.nextCandidate = 1;
        this.deferredCreate = deferredCreate;
        this.pendingCreate = null;
        this.conflictOnAnswer = false;
    }

    createRecord() {
        const serial = String(this.nextSession++).padStart(12, '0');
        const id = `00000000-0000-4000-8000-${serial}`;
        const invite = this.nextSession.toString(16).padStart(32, 'b').slice(-32);
        const owner = { id, token: 'A'.repeat(43), expiresAt: '2099-01-01T00:00:00.000Z' };
        const record = {
            id, invite, owner, guest: null, used: false, closed: false,
            ownerDescription: null, guestDescription: null,
            ownerCandidates: [], guestCandidates: []
        };
        this.sessions.set(id, record);
        return { record, owner, invite };
    }

    async create(kind) {
        this.createCalls.push(kind);
        if (this.deferredCreate) {
            return new Promise(resolve => { this.pendingCreate = resolve; });
        }
        return this.createRecordResult();
    }

    createRecordResult() {
        const { record, owner, invite } = this.createRecord();
        return Promise.resolve({ ...owner, invite });
    }

    resolveCreate() {
        const created = this.createRecord();
        this.pendingCreate({ ...created.owner, invite: created.invite });
        return created;
    }

    async join(kind, invite) {
        this.joinCalls.push({ kind, invite });
        const record = [...this.sessions.values()].find(item => item.invite === invite);
        if (!record || record.used || record.closed) {
            const error = new Error('Invitation unavailable');
            error.status = 410;
            throw error;
        }
        record.used = true;
        record.guest = {
            id: record.id,
            token: 'B'.repeat(43),
            expiresAt: '2099-01-01T00:00:00.000Z'
        };
        return { ...record.guest };
    }

    client() {
        const storage = new Map();
        const localStorage = {
            getItem(key) { return storage.has(key) ? storage.get(key) : null; },
            setItem(key, value) { storage.set(key, String(value)); },
            removeItem(key) { storage.delete(key); }
        };
        const fetch = async (path, options = {}) => {
            const method = options.method || 'GET';
            let body = null;
            try { body = options.body ? JSON.parse(options.body) : null; }
            catch (_) { return this.response(400, { error: 'invalid_json' }); }
            this.requests.push({ path, method, body });
            if (path === '/api/sessions' && method === 'POST') {
                const created = await this.create(body?.kind);
                return this.response(201, created);
            }
            if (path === '/api/sessions/join' && method === 'POST') {
                try { return this.response(200, await this.join(body?.kind, body?.invite)); }
                catch (error) { return this.response(error.status || 400, { error: 'invite_unavailable' }); }
            }
            const match = /^\/api\/sessions\/([a-f0-9-]+)(\/signals)?$/i.exec(path);
            if (!match) return this.response(404, { error: 'not_found' });
            const [, id, signalsPath] = match;
            const record = this.sessions.get(id);
            const token = options.headers?.Authorization?.replace(/^Bearer /, '');
            const owner = record && token === record.owner.token;
            const guest = record && record.guest && token === record.guest.token;
            if (!record || (!owner && !guest)) return this.response(401, { error: 'unauthorized' });
            if (method === 'DELETE' && !signalsPath) {
                if (!owner) return this.response(403, { error: 'forbidden' });
                record.closed = true;
                return this.response(200, { closed: true });
            }
            if (!signalsPath) return this.response(404, { error: 'not_found' });
            if (record.closed) return this.response(410, { error: 'session_closed' });
            if (method === 'GET') {
                return this.response(200, {
                    description: owner ? record.guestDescription : record.ownerDescription,
                    candidates: owner ? [...record.guestCandidates] : [...record.ownerCandidates],
                    closed: false,
                    answered: !!record.guestDescription
                });
            }
            if (method !== 'POST') return this.response(405, { error: 'method_not_allowed' });
            if (body?.type === 'offer' && owner) {
                if (record.ownerDescription && record.ownerDescription.sdp !== body.sdp) {
                    return this.response(409, { error: 'immutable_signal_conflict' });
                }
                if (!record.ownerDescription) record.ownerDescription = { type: 'offer', sdp: body.sdp };
                return this.response(200, { ok: true });
            }
            if (body?.type === 'answer' && guest) {
                if (this.conflictOnAnswer) {
                    this.conflictOnAnswer = false;
                    record.guestDescription = { type: 'answer', sdp: 'v=0\r\no=- concurrent-answer\r\n' };
                }
                if (record.guestDescription && record.guestDescription.sdp !== body.sdp) {
                    return this.response(409, { error: 'immutable_signal_conflict' });
                }
                if (!record.guestDescription) record.guestDescription = { type: 'answer', sdp: body.sdp };
                return this.response(200, { ok: true });
            }
            if (body?.type === 'candidate' && body.candidate) {
                const candidate = body.candidate;
                if (!Object.hasOwn(candidate, 'candidate') ||
                    !Object.hasOwn(candidate, 'sdpMid') ||
                    !Object.hasOwn(candidate, 'sdpMLineIndex')) {
                    return this.response(400, { error: 'invalid_candidate' });
                }
                const bucket = owner ? record.ownerCandidates : record.guestCandidates;
                if (bucket.length >= 128) return this.response(429, { error: 'candidate_limit' });
                bucket.push({ id: this.nextCandidate++, candidate });
                return this.response(201, { ok: true, candidate: bucket.at(-1) });
            }
            return this.response(403, { error: 'forbidden_signal' });
        };
        return {
            fetch,
            localStorage,
            storage
        };
    }

    response(status, data) {
        return { status, ok: status >= 200 && status < 300, async json() { return data; } };
    }
}

function loadSector(environment) {
    const elements = new Map();
    const document = {
        readyState: 'loading',
        head: new Element(),
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement() { return new Element(); },
        addEventListener() {}
    };
    const window = {
        __PACETRACK_SECTOR_TEST_MODE__: true,
        fetch: environment.fetch,
        localStorage: environment.localStorage,
        addEventListener() {}
    };
    const context = {
        document,
        window,
        navigator: {},
        AbortController,
        RTCPeerConnection: FakePeerConnection,
        RTCIceCandidate: class { constructor(candidate) { return candidate; } },
        RTCSessionDescription: class { constructor(description) { return description; } },
        performance,
        Date,
        Math,
        JSON,
        Promise,
        Uint8Array,
        Map,
        Set,
        Blob,
        URL,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        confirm: () => true
    };
    vm.runInNewContext(sessionApiSource, context, { filename: 'session-api.js' });
    vm.runInNewContext(source, context, { filename: 'scriptsSector.js' });
    return {
        api: window.__PACETRACK_SECTOR_TEST_API__,
        sessionApi: window.PaceTrackSessionAPI,
        localStorage: environment.localStorage,
        elements,
        element: id => document.getElementById(id)
    };
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, message) {
    for (let i = 0; i < 50; i++) {
        if (predicate()) return;
        await delay(2);
    }
    assert.fail(message);
}

function assertFreshInvitationMessage(element) {
    const status = element.textContent;
    assert.equal(status.split('\n')[0],
        'La sala ya fue enlazada; salida debe crear otra sala y compartir la nueva invitación.');
    assert.doesNotMatch(status, /recuperando|No se pudo abrir/i);
}

test('real sector flow uses immutable answer state and requires a fresh owner invitation after pairing', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService();
    const ownerStore = server.client();
    const owner = loadSector(ownerStore);
    owner.element('p2p-room-id').value = 'typed-value-must-be-ignored';
    await owner.api.createRoom();

    const invitation = owner.element('p2p-room-id').value;
    assert.equal(invitation.length, 32);
    assert.match(invitation, /^[a-f0-9]{32}$/);
    assert.deepEqual(server.createCalls, ['sector']);
    assert.equal(owner.api.state().sessionId, [...server.sessions.keys()][0]);
    assert.equal(server.requests.some(request => request.method === 'POST' && request.body?.type === 'offer'), true);
    assert.equal(owner.sessionApi.load('owner', owner.api.state().sessionId).id, owner.api.state().sessionId);

    const guestStore = server.client();
    const guest = loadSector(guestStore);
    await guest.api.joinRoom(invitation);
    const record = [...server.sessions.values()][0];
    await until(() => !!record.guestDescription, 'guest should receive offer and post its answer');
    assert.deepEqual(server.joinCalls, [{ kind: 'sector', invite: invitation }]);
    assert.equal(guest.api.state().sessionId, record.id);
    assert.equal(guest.sessionApi.loadInvitation('sector', invitation).answerPublished, true);
    assert.equal(server.requests.some(request => request.path.endsWith('/signals') &&
        request.method === 'GET'), true, 'the production browser library must accept the exact /signals suffix');

    await owner.api.pollNow();
    await until(() => FakePeerConnection.instances[0].remoteDescription?.type === 'answer',
        'owner should poll and apply the guest answer');

    const guestPeer = FakePeerConnection.instances[1];
    assert.equal(guestPeer.remoteDescription.type, 'offer');
    assert.equal(guestPeer.localDescription.type, 'answer');
    const localCandidate = {
        candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abcd'
    };
    FakePeerConnection.instances[0].onicecandidate({
        candidate: { toJSON: () => localCandidate }
    });
    await until(() => record.ownerCandidates.length === 1, 'owner candidate should be sent to the signals API');
    await delay(2);
    await guest.api.pollNow();
    assert.equal(guestPeer.addedCandidates.length, 1, 'guest should apply the candidate returned by the server');
    assert.deepEqual(
        JSON.parse(JSON.stringify(record.ownerCandidates[0].candidate)),
        localCandidate,
        'candidate JSON keeps the server-required mid and line fields'
    );

    guest.api.cleanupRTC({ keepRole: true });
    await guest.api.joinRoom(invitation);
    assertFreshInvitationMessage(guest.elements.get('p2p-sync-status'));
    assert.equal(guest.element('p2p-room-id').value, '');
    assert.equal(FakePeerConnection.instances.length, 2, 'a cached published answer must not create a new peer or SDP answer');
    assert.equal(server.joinCalls.length, 1, 'reconnect must not consume the one-time invitation again');
    assert.equal(guest.sessionApi.loadInvitation('sector', invitation), null, 'an already-paired invitation cache is cleared');

    await owner.api.createRoom();
    const freshInvitation = owner.element('p2p-room-id').value;
    const freshRecord = [...server.sessions.values()][1];
    assert.notEqual(freshInvitation, invitation);
    await guest.api.joinRoom(freshInvitation);
    await until(() => !!freshRecord.guestDescription, 'a new owner invitation should complete a fresh answer exchange');
    await owner.api.pollNow();
    await until(() => FakePeerConnection.instances[2].remoteDescription?.type === 'answer',
        'new owner should apply the new guest answer');
    assert.equal(server.joinCalls.length, 2);
    assert.equal(FakePeerConnection.instances.length, 4);
    guest.api.cleanupRTC();
    owner.api.cleanupRTC();
    await delay(0);
    assert.equal(record.closed, true, 'owner cleanup closes only its own server session');
    assert.equal(freshRecord.closed, true, 'the new owner session is also closed by its owner cleanup');
});

test('cached guest session can resume while the original owner answer is still unpublished', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService();
    const { record, invite } = server.createRecord();
    const guest = loadSector(server.client());

    await guest.api.joinRoom(invite);
    await until(() => FakePeerConnection.instances.length === 1, 'guest should wait for the owner offer');
    assert.equal(record.guestDescription, null);
    guest.api.cleanupRTC({ keepRole: true });

    record.ownerDescription = { type: 'offer', sdp: 'v=0\r\no=- pending-owner-offer\r\n' };
    await guest.api.joinRoom(invite);
    await until(() => !!record.guestDescription, 'cached unnegotiated session should apply the offer and publish an answer');
    assert.equal(server.joinCalls.length, 1, 'pending-session reconnect must not consume the invitation twice');
    assert.equal(guest.sessionApi.loadInvitation('sector', invite).answerPublished, true);
    assert.notEqual(record.guestDescription.sdp, 'v=0\r\no=- answer-0\r\n');
    guest.api.cleanupRTC();
});

test('server answer state blocks cached peer recreation even without a local published-answer marker', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService();
    const { record, invite } = server.createRecord();
    record.ownerDescription = { type: 'offer', sdp: 'v=0\r\no=- prior-offer\r\n' };
    record.guest = {
        id: record.id,
        token: 'B'.repeat(43),
        expiresAt: '2099-01-01T00:00:00.000Z'
    };
    record.used = true;
    record.guestDescription = { type: 'answer', sdp: 'v=0\r\no=- prior-answer\r\n' };
    const guest = loadSector(server.client());
    guest.sessionApi.save('guest', record.guest);
    guest.sessionApi.saveInvitation('sector', invite, record.guest);

    await guest.api.joinRoom(invite);
    assert.equal(FakePeerConnection.instances.length, 0, 'authoritative answered state must be checked before creating a peer');
    assert.equal(server.requests.filter(request => request.method === 'GET' && request.path.endsWith('/signals')).length, 1);
    assert.equal(server.joinCalls.length, 0, 'cached access is reused for the check without consuming the invitation');
    assert.equal(guest.sessionApi.loadInvitation('sector', invite), null);
    assert.equal(guest.element('p2p-room-id').value, '');
    assertFreshInvitationMessage(guest.element('p2p-sync-status'));
});

test('a racing immutable-answer conflict requires a fresh invitation instead of a generic retry', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService();
    const owner = loadSector(server.client());
    await owner.api.createRoom();
    const invitation = owner.element('p2p-room-id').value;
    server.conflictOnAnswer = true;
    const guest = loadSector(server.client());

    await guest.api.joinRoom(invitation);
    await until(() => guest.elements.get('p2p-sync-status').textContent.includes('La sala ya fue enlazada'),
        'immutable answer conflict should request a fresh owner invitation');
    assertFreshInvitationMessage(guest.elements.get('p2p-sync-status'));
    assert.equal(guest.api.state().sessionId, null);
    assert.equal(guest.sessionApi.loadInvitation('sector', invitation), null);
    assert.equal(
        server.requests.filter(request => request.method === 'POST' && request.body?.type === 'answer').length,
        1,
        'the conflicting answer must not be retried with another generated SDP'
    );
    guest.api.cleanupRTC();
    owner.api.cleanupRTC();
});

test('an unauthorized cached guest session is cleared and requires a fresh invitation', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService();
    const { record, invite, owner } = server.createRecord();
    record.ownerDescription = { type: 'offer', sdp: 'v=0\r\no=- offer\r\n' };
    const guestStore = server.client();
    const cachedGuest = loadSector(guestStore);
    cachedGuest.sessionApi.save('guest', {
        id: owner.id,
        token: 'C'.repeat(43),
        expiresAt: '2099-01-01T00:00:00.000Z'
    });
    cachedGuest.sessionApi.saveInvitation('sector', invite, {
        id: owner.id,
        token: 'C'.repeat(43),
        expiresAt: '2099-01-01T00:00:00.000Z'
    });
    const guest = cachedGuest;

    await guest.api.joinRoom(invite);
    await until(() => guest.elements.get('p2p-sync-status').textContent.includes('invitación nueva'),
        'expired guest token should be reported');
    assert.equal(server.joinCalls.length, 0, 'cached guest recovery happens before invite consumption');
    assert.equal(guest.sessionApi.loadInvitation('sector', invite), null, 'expired invitation cache should be cleared');
    assert.equal(guest.sessionApi.load('guest', owner.id), null);
    assert.equal(guest.api.state().sessionId, null);
});

test('stale asynchronous owner creation deletes exactly its returned session', async () => {
    FakePeerConnection.instances = [];
    const server = new FakeSessionService({ deferredCreate: true });
    const owner = loadSector(server.client());
    const createPromise = owner.api.createRoom();
    await delay(0);
    owner.api.cleanupRTC({ keepRole: true });
    const stale = server.resolveCreate();
    await createPromise;
    await until(() => server.requests.some(request => request.method === 'DELETE'),
        'stale completion should clean up its created owner session');
    const deletes = server.requests.filter(request => request.method === 'DELETE');
    assert.equal(deletes.length, 1);
    assert.equal(deletes[0].path, `/api/sessions/${stale.owner.id}`);
    assert.equal(stale.record.closed, true);
    assert.equal(FakePeerConnection.instances.length, 0);
});

test('guest cannot delete the owner session even if its cached token is misused', async () => {
    const server = new FakeSessionService();
    const { record, owner, invite } = server.createRecord();
    const guest = await server.join('sector', invite);
    const browser = loadSector(server.client());
    await assert.rejects(
        browser.sessionApi.request(guest, '', { method: 'DELETE' }),
        error => error.status === 401 || error.status === 403
    );
    assert.equal(record.closed, false);
    assert.ok(owner.token);
});