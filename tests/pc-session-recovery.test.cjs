const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../timer_PC/PC/PCscripts.js'), 'utf8');
let generatedUuid = 0;

function makeStorage(initial) {
    const values = new Map(Object.entries(initial || {}));
    return {
        values,
        getItem(key) { return values.has(key) ? values.get(key) : null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

function makeElement(id) {
    return {
        id,
        textContent: '',
        dataset: {},
        style: {},
        children: [],
        hidden: false,
        scrollTop: 0,
        listeners: {},
        replaceChildren(...children) { this.children = children; },
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); },
        addEventListener(type, callback) { this.listeners[type] = callback; },
        click() { if (this.listeners.click) this.listeners.click(); }
    };
}

function boot(storage, options = {}) {
    const ids = [
        'status-message', 'connection-status', 'storage-status', 'session-notice',
        'session-code', 'qrcode', 'laps-list', 'laps-container', 'export-results',
        'export-history', 'new-session'
    ];
    const elements = Object.fromEntries(ids.map(id => [id, makeElement(id)]));
    const documentListeners = {};
    const windowListeners = {};
    const refs = new Map();
    const window = {
        crypto: { randomUUID: () => `10000000-0000-4000-8000-${String(++generatedUuid).padStart(12, '0')}` },
        confirm: () => options.confirm !== false,
        addEventListener(type, callback) { windowListeners[type] = callback; },
        removeEventListener() {}
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
    const context = {
        window,
        document,
        localStorage: storage,
        QRCode: class { constructor(target, config) { target.qrUrl = config.text; } },
        Blob: MockBlob,
        URL: { createObjectURL: () => 'blob:mock', revokeObjectURL() {} },
        console
    };
    if (options.firebase) {
        const firebase = {
            apps: [],
            initializeApp() { this.apps.push({}); },
            database() {
                return {
                    ref(path) {
                        if (!refs.has(path)) refs.set(path, {
                            handlers: {},
                            on(event, callback, errorCallback) {
                                this.handlers[event] = { callback, errorCallback };
                            },
                            off(event, callback) {
                                if (this.handlers[event] && this.handlers[event].callback === callback) delete this.handlers[event];
                            }
                        });
                        return refs.get(path);
                    }
                };
            }
        };
        window.firebase = firebase;
        context.firebase = firebase;
    }
    vm.runInNewContext(script, context, { filename: 'PCscripts.js' });
    documentListeners.DOMContentLoaded();
    return { elements, windowListeners, refs, blobs: generatedBlobs };
}

test('PC reload restores session id and confirmed offline history; new session retains archive', () => {
    const storage = makeStorage();
    const first = boot(storage, { firebase: true });
    const oldId = first.elements['session-code'].textContent.replace('Sesión actual: ', '');
    const resultRef = first.refs.get(`sessions/${oldId}/results`);
    resultRef.handlers.child_added.callback({
        key: 'r1',
        val: () => ({ id: 'r1', elapsed: 1234, method: 'manual', timestamp: '2026-01-01T00:00:00.000Z' })
    });
    const saved = JSON.parse(storage.getItem('pacetrack.pc-sessions.v1'));
    assert.equal(saved.sessions[oldId].results[0].id, 'r1');

    const reloaded = boot(storage);
    assert.equal(reloaded.elements['session-code'].textContent, `Sesión actual: ${oldId}`);
    assert.match(reloaded.elements['session-notice'].textContent, /Sesión anterior recuperada/);
    assert.equal(reloaded.elements['laps-list'].children.length, 1);
    assert.match(reloaded.elements['connection-status'].textContent, /SDK de Firebase/);

    const newSessionButton = reloaded.elements['new-session'];
    newSessionButton.click();
    const newId = reloaded.elements['session-code'].textContent.replace('Sesión actual: ', '');
    assert.notEqual(newId, oldId);
    const afterSwitch = JSON.parse(storage.getItem('pacetrack.pc-sessions.v1'));
    assert.equal(afterSwitch.currentSessionId, newId);
    assert.equal(afterSwitch.sessions[oldId].results[0].id, 'r1');
    reloaded.elements['export-history'].click();
    assert.match(reloaded.blobs[0].parts.join(''), new RegExp(oldId));
    assert.match(reloaded.blobs[0].parts.join(''), /r1/);
});

test('corrupt and unavailable local storage are reported and corrupt data is not overwritten', () => {
    const corrupt = makeStorage({ 'pacetrack.pc-sessions.v1': '{invalid json' });
    const recovered = boot(corrupt);
    assert.match(recovered.elements['storage-status'].textContent, /No se pudo recuperar/);
    assert.equal(corrupt.getItem('pacetrack.pc-sessions.v1'), '{invalid json');

    const unavailable = {
        getItem() { throw new Error('blocked'); },
        setItem() { throw new Error('blocked'); }
    };
    const temporary = boot(unavailable);
    assert.match(temporary.elements['storage-status'].textContent, /no permite leer|no se pudo recuperar|No se pudo guardar/i);
    assert.match(temporary.elements['session-notice'].textContent, /sesión temporal/i);
});