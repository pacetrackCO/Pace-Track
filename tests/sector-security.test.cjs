const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourcePath = path.join(__dirname, '../timer_sector/scriptsSector.js');
const source = fs.readFileSync(sourcePath, 'utf8');

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

function loadSector({ clipboard } = {}) {
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
        addEventListener() {}
    };
    const context = {
        window,
        document,
        navigator: { clipboard },
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
    document.getElementById('p2p-room-id');
    vm.runInNewContext(source, context, { filename: 'scriptsSector.js' });
    return { api: window.__PACETRACK_SECTOR_TEST_API__, elements, window };
}

test('server invitations require exactly 32 lowercase hex characters, without normalization', () => {
    const { api } = loadSector();
    assert.equal(api.invitationValid('a'.repeat(32)), true);
    assert.equal(api.invitationValid('0123456789abcdef'.repeat(2)), true);
    for (const invalid of [
        '', 'a'.repeat(31), 'a'.repeat(33), 'A'.repeat(32), 'g'.repeat(32),
        ` ${'a'.repeat(31)}`, `${'a'.repeat(31)} `, '../'.repeat(10) + 'aa',
        null, 123
    ]) {
        assert.equal(api.invitationValid(invalid), false);
    }
});

test('SDP descriptions require a supported type and stay below the byte-character cap', () => {
    const { api } = loadSector();
    const sdp = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n';
    assert.equal(api.descriptionValid({ type: 'offer', sdp }, 'offer'), true);
    assert.equal(api.descriptionValid({ type: 'answer', sdp }, 'answer'), true);
    assert.equal(api.descriptionValid({ type: 'offer', sdp }, 'answer'), false);
    assert.equal(api.descriptionValid({ type: 'pranswer', sdp }), false);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: '' }), false);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: 'not-sdp' }), false);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: 'v=0\0broken' }), false);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: 'x'.repeat(65537) }), false);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: `v=0\n${'x'.repeat(65531)}` }), true);
    assert.equal(api.descriptionValid({ type: 'offer', sdp: ['v=0'] }), false);
    assert.equal(api.descriptionValid(null), false);
});

test('ICE candidates reject malformed, oversized, control-character, and out-of-range fields', () => {
    const { api } = loadSector();
    const candidate = {
        candidate: 'candidate:1 1 udp 2122260223 192.0.2.1 5000 typ host',
        sdpMid: '0',
        sdpMLineIndex: 0,
        usernameFragment: 'abc'
    };
    assert.equal(api.candidateValid(candidate), true);
    assert.equal(api.candidateValid({ ...candidate, candidate: '' }), false);
    assert.equal(api.candidateValid({ ...candidate, candidate: 'not-an-ice-candidate' }), false);
    assert.equal(api.candidateValid({ ...candidate, candidate: `candidate:${'x'.repeat(2048)}` }), false);
    assert.equal(api.candidateValid({ ...candidate, candidate: 'candidate:1\nunsafe' }), false);
    assert.equal(api.candidateValid({ ...candidate, sdpMLineIndex: 256 }), false);
    assert.equal(api.candidateValid({ ...candidate, sdpMLineIndex: 1.5 }), false);
    assert.equal(api.candidateValid({ ...candidate, sdpMid: 'x'.repeat(129) }), false);
    assert.equal(api.candidateValid({ ...candidate, sdpMid: '', sdpMLineIndex: null }), false);
    assert.equal(api.candidateValid({ ...candidate, usernameFragment: 'x'.repeat(257) }), false);
    assert.equal(api.candidateValid({ ...candidate, sdpMid: null, sdpMLineIndex: null }), false);
    assert.equal(api.candidateValid(null), false);
});

test('ICE signal quotas stop both directions at the configured bound', () => {
    const { api } = loadSector();
    api.resetIceQuotas();
    for (let index = 0; index < 128; index++) {
        assert.equal(api.takeIceQuota('incoming'), true);
        assert.equal(api.takeIceQuota('outgoing'), true);
    }
    assert.equal(api.takeIceQuota('incoming'), false);
    assert.equal(api.takeIceQuota('outgoing'), false);
    assert.equal(api.takeIceQuota('unknown'), false);
});

test('room creation and entry require the shared Replit session API, not Firebase globals', async () => {
    const { api, elements } = loadSector();
    assert.deepEqual(JSON.parse(JSON.stringify(api.iceConfiguration().iceServers)), [
        { urls: 'stun:stun.relay.metered.ca:80' }
    ]);
    await api.createRoom();
    await api.joinRoom('a'.repeat(32));
    assert.match(elements.get('p2p-sync-status').textContent, /servicio de sesiones/);
    assert.match(elements.get('p2p-sync-status').textContent, /redes restrictivas/);
});

test('active sector script contains no TURN URLs or static TURN credentials', () => {
    const text = fs.readFileSync(sourcePath, 'utf8');
    assert.equal(/\bturns?:/i.test(text), false, 'the public sector script must not contain a TURN URL');
    assert.equal(/\b(?:username|credential)\s*:/i.test(text), false, 'the public sector script must not contain static ICE credentials');
});

test('sector HTML loads the shared session API and no Firebase SDK', () => {
    const html = fs.readFileSync(path.join(__dirname, '../timer_sector/timer_sector.html'), 'utf8');
    assert.equal(/firebase-(?:app|database)/i.test(html), false);
    assert.equal(/<script[^>]+timing\/session-api\.js/i.test(html), true);
    assert.match(html, /Si llegada debe reconectar después de responder o recargar, salida crea una sala nueva/);
    assert.equal(/\bfirebase(?:Config|\.database)|databaseURL|apiKey/i.test(source), false);
});

test('invitation copying preserves the exact value and falls back to selection', async () => {
    let copied;
    const { elements } = loadSector({ clipboard: { async writeText(value) { copied = value; } } });
    elements.get('p2p-room-id').value = 'a'.repeat(32);
    await elements.get('p2p-copy-code').onclick();
    assert.equal(copied, 'a'.repeat(32));
    assert.match(elements.get('p2p-status').textContent, /copiado/);

    const fallback = loadSector().elements;
    fallback.get('p2p-room-id').value = 'b'.repeat(32);
    await fallback.get('p2p-copy-code').onclick();
    assert.equal(fallback.get('p2p-room-id').selected, true);
    assert.match(fallback.get('p2p-status').textContent, /seleccionado/);

    copied = null;
    elements.get('p2p-room-id').value = '../invalid';
    await elements.get('p2p-copy-code').onclick();
    assert.equal(copied, null);
    assert.match(elements.get('p2p-sync-status').textContent, /invitación válida/);
});