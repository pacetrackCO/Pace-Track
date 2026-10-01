const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const sessionApiSource = fs.readFileSync(require.resolve('../timing/session-api.js'), 'utf8');
const pcSource = fs.readFileSync(require.resolve('../timer_PC/PC/PCscripts.js'), 'utf8');
const mobileSource = fs.readFileSync(require.resolve('../timer_PC/Mobil/scripsttimer.js'), 'utf8');
const validSession = '10000000-0000-4000-8000-000000000001';
const validInvite = 'abcdef0123456789abcdef0123456789';
let nextUuid = 1;

function makeStorage(initial) {
    const values = new Map(Object.entries(initial || {}));
    const reads = [];
    return {
        values,
        reads,
        getItem(key) {
            reads.push(key);
            return values.has(key) ? values.get(key) : null;
        },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

function makeApi({ joinSessionId } = {}) {
    const sessions = new Map();
    const capabilities = new Map();
    const invitations = new Map();
    const calls = [];
    let created = 0;
    const api = {
        async create(kind) {
            calls.push(['create', kind]);
            if (!['pc', 'sector'].includes(kind)) throw new Error('invalid kind');
            created++;
            const id = `10000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}`;
            const invite = `${String(nextUuid++).padStart(32, 'a').slice(-32)}`;
            const owner = { id, token: `owner-${id}`, role: 'owner', invite, expiresAt: '2030-01-01T00:00:00.000Z' };
            sessions.set(id, { results: [], roles: { owner: owner.token, guest: null } });
            return { id, token: owner.token, invite, expiresAt: owner.expiresAt };
        },
        seed(id = validSession, invite = validInvite) {
            const owner = { id, token: `owner-${id}`, role: 'owner' };
            const guest = { id, token: `guest-${id}`, role: 'guest' };
            sessions.set(id, { results: [], roles: { owner: owner.token, guest: guest.token } });
            invitations.set(`pc:${invite}`, { id, invite });
            capabilities.set(`owner:${id}`, owner);
            return { owner, guest, invite };
        },
        save(role, session) {
            calls.push(['save', role, session.id]);
            capabilities.set(`${role}:${session.id}`, { ...session, role });
            return true;
        },
        async load(role, id) {
            calls.push(['load', role, id]);
            const capability = capabilities.get(`${role}:${id}`);
            return capability ? { ...capability } : null;
        },
        saveInvitation(kind, invite, session) {
            calls.push(['saveInvitation', kind, invite, session.id]);
            invitations.set(`${kind}:${invite}`, { ...session, invite });
            return true;
        },
        async loadInvitation(kind, invite) {
            calls.push(['loadInvitation', kind, invite]);
            const record = invitations.get(`${kind}:${invite}`);
            return record ? { ...record } : null;
        },
        async join(kind, invite) {
            calls.push(['join', kind, invite]);
            if (!['pc', 'sector'].includes(kind)) throw new Error('invalid kind');
            const invitation = invitations.get(`${kind}:${invite}`);
            if (!invitation) throw new Error('invalid invitation');
            const id = joinSessionId || invitation.id;
            const guest = { id, token: `guest-${id}`, role: 'guest' };
            if (id === invitation.id) sessions.get(id).roles.guest = guest.token;
            return { ...guest };
        },
        async request(capability, suffix, options = {}) {
            const method = options.method || 'GET';
            calls.push(['request', capability.id, suffix, method, options.body || null]);
            const session = sessions.get(capability.id);
            if (!session || session.roles[capability.role] !== capability.token) {
                const error = new Error('unauthorized');
                error.status = 401;
                throw error;
            }
            if (method === 'GET' && suffix === '') return { id: capability.id, kind: 'pc', role: capability.role };
            if (method === 'GET' && suffix === '/results' && capability.role === 'owner') {
                return session.results.map(record => ({ ...record }));
            }
            if (method === 'PUT' && suffix.startsWith('/results/') && capability.role === 'guest') {
                const pathId = suffix.slice('/results/'.length);
                const result = options.body;
                if (!result || result.id !== pathId || result.sessionId !== capability.id) throw new Error('invalid payload');
                const existing = session.results.find(record => record.id === pathId);
                if (existing) {
                    if (JSON.stringify(existing) !== JSON.stringify(result)) {
                        const error = new Error('conflicting result');
                        error.status = 409;
                        throw error;
                    }
                    return { ...existing };
                }
                session.results.push({ ...result });
                return { ...result };
            }
            throw new Error(`Unexpected mocked request: ${method} ${suffix}`);
        },
        addResult(id, result) { sessions.get(id).results.push({ ...result }); },
        calls,
        sessions,
        created: () => created
    };
    return api;
}

function makeElement(id) {
    return {
        id,
        textContent: '',
        dataset: {},
        style: {},
        hidden: false,
        children: [],
        listeners: {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        click() { return this.listeners.click && this.listeners.click(); }
    };
}

function makeResultSync() {
    const instances = [];
    return {
        instances,
        create(options) {
            const queue = [];
            const requests = [];
            let connected = false;
            let disposed = false;
            let flushing = false;
            const flush = async () => {
                if (!connected || disposed || flushing) return;
                flushing = true;
                try {
                    for (const record of queue) {
                        if (!connected || disposed || record.syncState === 'confirmed') continue;
                        options.onStatus({ state: 'pending', result: record });
                        try {
                            requests.push(Promise.resolve(options.transport(options.sessionId, { ...record })));
                            await requests[requests.length - 1];
                            record.syncState = 'confirmed';
                            options.onStatus({ state: 'confirmed', result: record });
                        } catch (error) {
                            record.syncState = 'error';
                            options.onStatus({ state: 'error', result: record, error: error.message });
                        }
                    }
                } finally {
                    flushing = false;
                }
            };
            const instance = {
                options,
                queue,
                requests,
                enqueue(result) {
                    let record = queue.find(item => item.id === result.id);
                    if (!record) {
                        record = { ...result, syncState: 'pending', attempts: 0 };
                        queue.push(record);
                    }
                    options.onStatus({ state: 'pending', result: record });
                    return flush();
                },
                reconcile(results) {
                    (results || []).forEach(result => {
                        if (result && result.sessionId === options.sessionId && result.syncState !== 'confirmed' &&
                            !queue.some(item => item.id === result.id)) {
                            queue.push({ ...result, syncState: 'pending', attempts: 0 });
                        }
                    });
                    return { queued: queue.length, confirmed: 0 };
                },
                getQueue() { return queue.map(item => ({ ...item })); },
                setConnected(value) { connected = Boolean(value); if (connected) return flush(); },
                flush,
                retry() {
                    queue.forEach(item => { if (item.syncState === 'error') item.syncState = 'pending'; });
                    return flush();
                },
                clearSession() { queue.length = 0; return { removedIds: [], inFlightIds: [], preservedConfirmedIds: [] }; },
                dispose() { disposed = true; }
            };
            instances.push(instance);
            return instance;
        }
    };
}

function bootPc({ storage = makeStorage(), api = makeApi() } = {}) {
    const ids = [
        'status-message', 'connection-status', 'storage-status', 'session-notice',
        'session-code', 'qrcode', 'laps-list', 'laps-container', 'export-results',
        'export-history', 'new-session'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, makeElement(id)]));
    const documentListeners = {};
    const windowListeners = {};
    const intervals = [];
    const window = {
        location: { href: 'https://example.test/timer_PC/PC/PC.html' },
        addEventListener(type, callback) { windowListeners[type] = callback; },
        setInterval(callback) { intervals.push(callback); return intervals.length; },
        clearInterval() {}
    };
    const document = {
        getElementById(id) { return elements[id]; },
        createElement(tag) { return makeElement(tag); },
        addEventListener(type, callback) { documentListeners[type] = callback; }
    };
    const generatedBlobs = [];
    class MockBlob {
        constructor(parts) { this.parts = parts; generatedBlobs.push(this); }
    }
    class MockURL extends URL {
        static createObjectURL() { return 'blob:mock'; }
        static revokeObjectURL() {}
    }
    window.PaceTrackSessionAPI = api;
    const context = {
        window,
        document,
        localStorage: storage,
        PaceTrackSessionAPI: api,
        QRCode: class { constructor(target, config) { target.qrUrl = config.text; } },
        Blob: MockBlob,
        URL: MockURL,
        console
    };
    vm.runInNewContext(pcSource, context, { filename: 'PCscripts.js' });
    documentListeners.DOMContentLoaded();
    return { elements, storage, windowListeners, intervals, api, blobs: generatedBlobs };
}

function bootMobile({ search = `?session=${validSession}`, hash = `#invite=${validInvite}`, storage = makeStorage(), api = makeApi() } = {}) {
    const ids = [
        'video', 'overlay-canvas', 'timer-display', 'status-message', 'sync-status',
        'reset-button', 'sensitivity-slider', 'laps-container', 'laps-list',
        'retry-sync-button', 'export-local-results', 'app-container', 'controls',
        'video-container'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, makeElement(id)]));
    const windowListeners = {};
    const resultSync = makeResultSync();
    const runtimeConfig = [];
    let replacedUrl = null;
    const window = {
        location: { search, hash, pathname: '/timer_PC/Mobil/timer.html' },
        crypto: { randomUUID: () => `20000000-0000-4000-8000-${String(nextUuid++).padStart(12, '0')}` },
        history: { replaceState(_state, _title, url) { replacedUrl = url; } },
        PaceTrackTiming: {
            create(options) {
                runtimeConfig.push(options);
                return {
                    setSync(text, kind) {
                        elements['sync-status'].textContent = text;
                        elements['sync-status'].dataset.kind = kind;
                    },
                    setTriggerLabel() {},
                    stop() {},
                    prepare() {}
                };
            }
        },
        PaceTrackResultSync: resultSync,
        PaceTrackSessionAPI: api,
        confirm: () => true,
        addEventListener(type, callback) { windowListeners[type] = callback; },
        removeEventListener() {}
    };
    const document = {
        getElementById(id) { return elements[id]; },
        createElement(tag) { return makeElement(tag); }
    };
    const context = {
        window,
        document,
        localStorage: storage,
        URLSearchParams,
        Date,
        console
    };
    vm.runInNewContext(mobileSource, context, { filename: 'scripsttimer.js' });
    return {
        elements, storage, api, resultSync, runtimeConfig, windowListeners,
        replacedUrl: () => replacedUrl
    };
}

async function settle() {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

test('shared Replit API library contract works against an isolated fake fetch', async () => {
    const storage = makeStorage();
    const sessions = new Map();
    const calls = [];
    const id = '10000000-0000-4000-8000-000000000099';
    const invite = '1234567890abcdef1234567890abcdef';
    const ownerToken = 'O'.repeat(43);
    const guestToken = 'G'.repeat(43);
    const mockFetch = async (path, options = {}) => {
        calls.push({ path, options });
        const method = options.method || 'GET';
        const body = options.body ? JSON.parse(options.body) : null;
        if (path === '/api/sessions' && method === 'POST') {
            if (body.kind !== 'pc') return { ok: false, status: 400, json: async () => ({ error: 'invalid_kind' }) };
            sessions.set(id, { results: [], ownerToken, guestToken });
            return { ok: true, status: 201, json: async () => ({ id, token: ownerToken, invite, expiresAt: '2030-01-01T00:00:00.000Z' }) };
        }
        if (path === '/api/sessions/join' && method === 'POST') {
            if (body.kind !== 'pc' || body.invite !== invite) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
            return { ok: true, status: 200, json: async () => ({ id, token: guestToken, expiresAt: '2030-01-01T00:00:00.000Z' }) };
        }
        const match = path.match(/^\/api\/sessions\/([^/]+)(\/results(?:\/[^/]+)?)?$/);
        if (!match || !sessions.has(match[1])) return { ok: false, status: 404, json: async () => ({ error: 'not_found' }) };
        const session = sessions.get(match[1]);
        const role = options.headers && options.headers.Authorization === `Bearer ${ownerToken}` ? 'owner'
            : options.headers && options.headers.Authorization === `Bearer ${guestToken}` ? 'guest' : null;
        if (!role) return { ok: false, status: 401, json: async () => ({ error: 'unauthorized' }) };
        if (!match[2] && method === 'GET') {
            return { ok: true, status: 200, json: async () => ({ id, role, kind: 'pc' }) };
        }
        if (match[2] === '/results' && method === 'GET' && role === 'owner') {
            return { ok: true, status: 200, json: async () => session.results.map(record => ({ ...record })) };
        }
        if (match[2] && match[2].startsWith('/results/') && method === 'PUT' && role === 'guest') {
            const resultId = decodeURIComponent(match[2].slice('/results/'.length));
            if (body.id !== resultId || body.sessionId !== id) return { ok: false, status: 400, json: async () => ({ error: 'invalid_result' }) };
            const existing = session.results.find(record => record.id === resultId);
            if (existing && JSON.stringify(existing) !== JSON.stringify(body)) {
                return { ok: false, status: 409, json: async () => ({ error: 'conflict' }) };
            }
            if (!existing) session.results.push(body);
            return { ok: true, status: 200, json: async () => ({ ...existing || body }) };
        }
        return { ok: false, status: 405, json: async () => ({ error: 'method_not_allowed' }) };
    };
    const window = { localStorage: storage, fetch: mockFetch };
    vm.runInNewContext(sessionApiSource, {
        window, AbortController, setTimeout, clearTimeout, URLSearchParams, console
    }, { filename: 'session-api.js' });
    const api = window.PaceTrackSessionAPI;

    await assert.rejects(api.create('timer'), /Tipo de sesión no válido/);
    await assert.rejects(api.join('timer', invite), /Código de invitación no válido/);
    const owner = await api.create('pc');
    assert.equal(owner.id, id);
    assert.equal(api.save('owner', owner), true);
    assert.equal(api.saveInvitation('pc', invite, owner), true);
    assert.equal((await api.loadInvitation('pc', invite)).id, id);
    const recoveredOwner = api.load('owner', id);
    assert.equal((await api.request(recoveredOwner, '', { method: 'GET' })).role, 'owner');
    assert.deepEqual(await api.request(recoveredOwner, '/results', { method: 'GET' }), []);

    const guest = await api.join('pc', invite);
    assert.equal(guest.id, id, 'the server, not the caller, selects the joined session');
    assert.equal(api.save('guest', guest), true);
    const recoveredGuest = api.load('guest', id);
    assert.equal((await api.request(recoveredGuest, '', { method: 'GET' })).role, 'guest');
    const result = {
        id: '20000000-0000-4000-8000-000000000001',
        sessionId: id,
        elapsed: 123,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    };
    assert.deepEqual(await api.request(recoveredGuest, `/results/${result.id}`, { method: 'PUT', body: result }), result);
    assert.equal(calls.at(-1).path, `/api/sessions/${id}/results/${result.id}`);
    assert.deepEqual(await api.request(recoveredOwner, '/results', { method: 'GET' }), [result]);
});

test('mobile invalid sessions stay local and never request/join or read compatibility aliases', async () => {
    const storage = makeStorage({
        'pt_pcmobil_recordedLaps': JSON.stringify([{ id: 'old', elapsed: 40 }]),
        recordedLaps: JSON.stringify([{ id: 'older', elapsed: 50 }])
    });
    const api = makeApi();
    const mobile = bootMobile({ search: '?session=not-a-uuid', hash: '#invite=malformed', storage, api });
    await settle();
    assert.equal(api.calls.length, 0);
    assert.deepEqual(storage.reads, ['pt_pcmobil_recordedLaps:local']);
    assert.match(mobile.elements['sync-status'].textContent, /no es válido.*no se sincronizará/i);
    assert.equal(mobile.resultSync.instances.length, 0);
});

test('valid mobile QR redeems only its invite, verifies returned binding, then submits bounded canonical results', async () => {
    const api = makeApi();
    const session = api.seed(validSession, validInvite);
    const mobile = bootMobile({ api });
    await settle();
    assert.ok(api.calls.some(call => call[0] === 'join' && call[1] === 'pc' && call[2] === validInvite));
    assert.ok(api.calls.some(call => call[0] === 'save' && call[1] === 'guest' && call[2] === validSession));
    assert.equal(mobile.replacedUrl(), `/timer_PC/Mobil/timer.html?session=${validSession}`);
    assert.ok(api.calls.some(call => call[0] === 'request' && call[1] === validSession && call[2] === '' && call[3] === 'GET'));

    const [runtime] = mobile.runtimeConfig;
    runtime.onTrigger({ now: 100, method: 'manual' });
    runtime.onTrigger({ now: 2345, method: 'manual' });
    await settle();
    assert.ok(api.calls.some(call => call[0] === 'request' && call[3] === 'PUT'), JSON.stringify(api.calls));
    const result = api.sessions.get(validSession).results[0];
    assert.equal(result.sessionId, validSession);
    assert.equal(result.elapsed, 2245);
    assert.deepEqual(Object.keys(result).sort(), ['elapsed', 'id', 'method', 'sessionId', 'timestamp']);
    assert.ok(mobile.resultSync.instances[0].queue.some(record => record.syncState === 'confirmed'));
    assert.match(mobile.elements['sync-status'].textContent, /confirmados por el servidor|confirmado por el servidor/i);

    const transport = mobile.resultSync.instances[0].options.transport;
    const requestCount = api.calls.filter(call => call[0] === 'request' && call[3] === 'PUT').length;
    await assert.rejects(transport('20000000-0000-4000-8000-000000000002', result), /destino no coincide/i);
    await assert.rejects(transport(validSession, { ...result, id: 'bad/id' }), /identificador seguro válido/i);
    await assert.rejects(transport(validSession, { ...result, sessionId: 'forged-session' }), /sesión vinculada/i);
    await assert.rejects(transport(validSession, { ...result, elapsed: Infinity }), /duración/i);
    assert.equal(api.calls.filter(call => call[0] === 'request' && call[3] === 'PUT').length, requestCount);
    assert.ok(api.calls.some(call => call[0] === 'request' && call[3] === 'PUT'));
    assert.equal(session.guest.id, validSession);
});

test('mobile rejects a mismatched server join before saving capability or sending results', async () => {
    const api = makeApi({ joinSessionId: '20000000-0000-4000-8000-000000000002' });
    api.seed(validSession, validInvite);
    const mobile = bootMobile({ api });
    await settle();
    assert.equal(api.calls.some(call => call[0] === 'save' && call[1] === 'guest'), false);
    assert.equal(api.calls.some(call => call[0] === 'request' && call[3] === 'PUT'), false);
    assert.match(mobile.elements['sync-status'].textContent, /no pertenece a la sesión indicada/i);
    assert.equal(mobile.resultSync.instances[0].queue.length, 0);
});

test('mobile keeps valid-session results queued when invite/capability is missing; secure UUID fallback remains', async () => {
    const storage = makeStorage();
    const api = makeApi();
    const mobile = bootMobile({
        search: `?session=${validSession}`,
        hash: '',
        storage,
        api
    });
    await settle();
    const [runtime] = mobile.runtimeConfig;
    runtime.onTrigger({ now: 1, method: 'manual' });
    runtime.onTrigger({ now: 101, method: 'manual' });
    await settle();
    assert.equal(api.calls.some(call => call[0] === 'request' && call[3] === 'PUT'), false);
    assert.match(mobile.elements['sync-status'].textContent, /Falta el código secreto de invitación/);
    const queue = mobile.resultSync.instances[0].queue;
    assert.equal(queue.length, 1);
    assert.equal(queue[0].syncState, 'pending');
    assert.match(queue[0].id, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i);
    assert.doesNotMatch(mobileSource, /Math\.random/);
    assert.doesNotMatch(pcSource, /window\.firebase|firebase\.database|Math\.random/i);
});

test('PC ingests only canonical bounded server records and does not load Firebase libraries', async () => {
    const api = makeApi();
    const pc = bootPc({ api });
    await settle();
    const sessionId = pc.elements['session-code'].textContent.replace('Sesión actual: ', '');
    api.addResult(sessionId, {
        id: 'good',
        sessionId,
        elapsed: 500,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    api.addResult(sessionId, {
        id: 'bad/segment',
        sessionId,
        elapsed: 700,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    api.addResult(sessionId, {
        id: 'bad-number',
        sessionId,
        elapsed: Infinity,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    api.addResult(sessionId, {
        id: 'foreign',
        sessionId: '20000000-0000-4000-8000-000000000002',
        elapsed: 500,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    await pc.intervals[0]();
    const owner = await api.load('owner', sessionId);
    const results = await api.request(owner, '/results', { method: 'GET' });
    assert.equal(results.length, 4, 'the mocked Replit service may return malformed data for client validation');
    const saved = JSON.parse(pc.storage.getItem('pacetrack.pc-sessions.v1'));
    assert.deepEqual(saved.sessions[sessionId].results.map(record => record.id), ['good']);
    assert.doesNotMatch(pcSource, /window\.firebase|firebase\.database/i);
    assert.doesNotMatch(fs.readFileSync(require.resolve('../timer_PC/PC/PC.html'), 'utf8'), /gstatic\.com\/firebase/i);
    assert.doesNotMatch(fs.readFileSync(require.resolve('../timer_PC/Mobil/timer.html'), 'utf8'), /gstatic\.com\/firebase/i);
});