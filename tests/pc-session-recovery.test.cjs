const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../timer_PC/PC/PCscripts.js'), 'utf8');
const SESSION_ID = '10000000-0000-4000-8000-000000000001';
let nextId = 1;

function makeStorage(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

function makeApi({ failCreate = false } = {}) {
    const sessions = new Map();
    const capabilities = new Map();
    const invitations = new Map();
    const calls = [];
    const api = {
        async create(kind) {
            calls.push(['create', kind]);
            if (!['pc', 'sector'].includes(kind)) throw new Error('invalid kind');
            if (failCreate) throw new Error('offline');
            const id = `10000000-0000-4000-8000-${String(nextId++).padStart(12, '0')}`;
            const session = {
                id,
                token: `owner-token-${id}`,
                role: 'owner',
                invite: `${String(nextId).padStart(32, 'a').slice(-32)}`,
                expiresAt: new Date(Date.now() + 86400000).toISOString()
            };
            sessions.set(id, { results: [], capabilities: { owner: session } });
            return { ...session };
        },
        save(role, session) {
            capabilities.set(`${role}:${session.id}`, { ...session, role });
            return true;
        },
        async load(role, id) {
            return capabilities.get(`${role}:${id}`) ? { ...capabilities.get(`${role}:${id}`) } : null;
        },
        saveInvitation(kind, invite, session) {
            invitations.set(`${kind}:${invite}`, { ...session });
            return true;
        },
        async loadInvitation(kind, invite) {
            const session = invitations.get(`${kind}:${invite}`);
            return session ? { ...session } : null;
        },
        async request(capability, suffix, options = {}) {
            calls.push(['request', capability.id, suffix, options.method || 'GET']);
            const entry = sessions.get(capability.id);
            if (!entry || entry.capabilities[capability.role]?.token !== capability.token) {
                const error = new Error('unauthorized');
                error.status = 401;
                throw error;
            }
            if ((options.method || 'GET') === 'GET' && suffix === '') {
                return { id: capability.id, kind: 'pc', role: capability.role };
            }
            if ((options.method || 'GET') === 'GET' && suffix === '/results' && capability.role === 'owner') {
                return entry.results.map(record => ({ ...record }));
            }
            throw new Error(`Unexpected mocked request: ${options.method || 'GET'} ${suffix}`);
        },
        addResult(id, record) {
            sessions.get(id).results.push({ ...record });
        },
        calls,
        sessions,
        capabilities
    };
    return api;
}

function makeElement(id) {
    return {
        id,
        textContent: '',
        dataset: {},
        style: {},
        children: [],
        hidden: false,
        disabled: false,
        listeners: {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        click() { return this.listeners.click && this.listeners.click(); }
    };
}

function boot(storage, api, options = {}) {
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
        confirm: () => options.confirm !== false,
        addEventListener(type, callback) { windowListeners[type] = callback; },
        setInterval(callback, delay) { intervals.push({ callback, delay }); return intervals.length; },
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
    window.PaceTrackSessionAPI = api;
    vm.runInNewContext(script, context, { filename: 'PCscripts.js' });
    documentListeners.DOMContentLoaded();
    return { elements, storage, windowListeners, intervals, blobs: generatedBlobs, api };
}

async function settle() {
    for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve));
}

test('fresh PC session is created asynchronously, polls Replit, and recovers owner capability on reload', async () => {
    const api = makeApi();
    const storage = makeStorage();
    const first = boot(storage, api);
    await settle();
    const id = first.elements['session-code'].textContent.replace('Sesión actual: ', '');
    assert.match(id, /^[a-f0-9-]{36}$/i);
    assert.ok(storage.getItem('pacetrack.pc-owner-session.v1'), 'owner metadata is persisted separately from result archives');
    assert.equal(JSON.parse(storage.getItem('pacetrack.pc-sessions.v1')).currentSessionId, id);
    assert.match(first.elements['qrcode'].qrUrl, /^https:\/\/example\.test\/timer_PC\/Mobil\/timer\.html\?session=/);
    assert.match(first.elements['qrcode'].qrUrl, /#invite=[a-f0-9]{32}$/i);

    api.addResult(id, {
        id: 'result-a',
        sessionId: id,
        elapsed: 1234,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    api.addResult(id, {
        id: 'unsafe/id',
        sessionId: id,
        elapsed: 100,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    api.addResult(id, {
        id: 'too-long',
        sessionId: id,
        elapsed: 99999999999,
        method: 'manual',
        timestamp: '2026-01-01T00:00:00.000Z'
    });
    await first.intervals[0].callback();
    assert.equal(JSON.parse(storage.getItem('pacetrack.pc-sessions.v1')).sessions[id].results[0].id, 'result-a');
    assert.equal(JSON.parse(storage.getItem('pacetrack.pc-sessions.v1')).sessions[id].results.length, 1);

    const reloaded = boot(storage, api);
    await settle();
    assert.match(reloaded.elements['session-notice'].textContent, /Sesión Replit recuperada/);
    assert.equal(reloaded.elements['laps-list'].children.length, 1);
    assert.ok(api.calls.some(call => call[0] === 'request' && call[1] === id && call[2] === ''));

    await reloaded.elements['new-session'].click();
    await settle();
    const newId = reloaded.elements['session-code'].textContent.replace('Sesión actual: ', '');
    assert.notEqual(newId, id);
    const saved = JSON.parse(storage.getItem('pacetrack.pc-sessions.v1'));
    assert.equal(saved.currentSessionId, newId);
    assert.equal(saved.sessions[id].results[0].id, 'result-a');
    reloaded.elements['export-history'].click();
    assert.match(reloaded.blobs[0].parts.join(''), new RegExp(id));
    assert.match(reloaded.blobs[0].parts.join(''), /result-a/);
});

test('legacy local PC archives remain visible/exportable and are not treated as server-authorized sessions', async () => {
    const legacyId = '30000000-0000-4000-8000-000000000001';
    const storage = makeStorage({
        'pacetrack.pc-sessions.v1': JSON.stringify({
            version: 1,
            currentSessionId: legacyId,
            sessions: {
                [legacyId]: {
                    results: [{
                        id: 'old-result',
                        elapsed: 800,
                        method: 'manual',
                        timestamp: '2026-01-01T00:00:00.000Z'
                    }]
                }
            }
        })
    });
    const api = makeApi();
    const pc = boot(storage, api);
    await settle();
    assert.equal(pc.elements['session-code'].textContent, `Sesión local: ${legacyId}`);
    assert.match(pc.elements['session-notice'].textContent, /no tiene una capacidad propietaria/);
    assert.equal(api.calls.some(call => call[0] === 'create'), false);
    assert.equal(pc.elements['laps-list'].children.length, 1);

    await pc.elements['new-session'].click();
    await settle();
    const newId = pc.elements['session-code'].textContent.replace('Sesión actual: ', '');
    assert.notEqual(newId, legacyId);
    const saved = JSON.parse(storage.getItem('pacetrack.pc-sessions.v1'));
    assert.equal(saved.sessions[legacyId].results[0].id, 'old-result');
    pc.elements['export-history'].click();
    assert.match(pc.blobs[0].parts.join(''), /old-result/);
});

test('offline Replit create failure does not synthesize a session UUID or overwrite archived state', async () => {
    const storage = makeStorage();
    const api = makeApi({ failCreate: true });
    const pc = boot(storage, api);
    await settle();
    assert.equal(pc.elements['session-code'].textContent, 'Sin sesión Replit activa');
    assert.match(pc.elements['connection-status'].textContent, /offline/);
    assert.equal(storage.getItem('pacetrack.pc-sessions.v1'), null);
});