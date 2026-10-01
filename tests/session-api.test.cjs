'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const source = fs.readFileSync(require.resolve('../timing/session-api.js'), 'utf8');
const session = {
    id: 'a47a5d63-96f2-4fd7-85e9-222222222222',
    token: 't'.repeat(43),
    invite: 'a'.repeat(32),
    expiresAt: '2099-01-01T00:00:00.000Z'
};

function fixture(response, throwingStorage = false) {
    const calls = [];
    const values = new Map();
    const root = {
        fetch: async (url, options) => {
            calls.push({ url, options });
            return response;
        },
        localStorage: {
            getItem: key => values.get(key) || null,
            setItem: (key, value) => {
                if (throwingStorage) throw new Error('quota');
                values.set(key, value);
            }
        }
    };
    vm.runInNewContext(source, { window: root, AbortController, setTimeout, clearTimeout });
    return { api: root.PaceTrackSessionAPI, calls, values };
}

test('session client keeps capabilities in headers, same-origin paths and never redirects', async () => {
    const { api, calls } = fixture({ ok: true, status: 200, json: async () => [] });
    await api.request(session, '/results');
    assert.equal(calls[0].url, '/api/sessions/' + session.id + '/results');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer ' + session.token);
    assert.equal(calls[0].options.redirect, 'error');
    assert.equal(calls[0].options.cache, 'no-store');
    assert.equal(calls[0].url.includes(session.token), false);
});

test('session client rejects malformed capabilities and routes before any request', async () => {
    const { api, calls } = fixture({ ok: true, json: async () => ({}) });
    await assert.rejects(api.request({ id: session.id, token: 'weak' }, '/results'));
    await assert.rejects(api.request(session, '/../server'));
    await assert.rejects(api.join('pc', '../invalid'));
    assert.equal(calls.length, 0);
});

test('session client persists role-specific recovery credentials and reports failed storage', () => {
    const { api } = fixture({});
    assert.equal(api.save('owner', session), true);
    assert.equal(api.load('owner', session.id).id, session.id);
    assert.equal(api.load('guest', session.id), null);
    assert.equal(api.saveInvitation('sector', session.invite, session), true);
    assert.equal(api.loadInvitation('sector', session.invite).token, session.token);
    assert.equal(fixture({}, true).api.save('owner', session), false);
});

test('session client surfaces denied access and does not treat it as confirmation', async () => {
    const { api } = fixture({ ok: false, status: 403, json: async () => ({ error: 'internal detail' }) });
    await assert.rejects(api.request(session, '/results/a', { method: 'PUT', body: {} }), failure => {
        assert.equal(failure.status, 403);
        assert.equal(failure.message.includes('internal detail'), false);
        return true;
    });
});

test('session creation validates returned server-generated invitation and credentials', async () => {
    const { api, calls } = fixture({ ok: true, status: 201, json: async () => session });
    assert.equal((await api.create('pc')).id, session.id);
    assert.equal(calls[0].url, '/api/sessions');
    assert.equal(calls[0].options.body, '{"kind":"pc"}');
    await assert.rejects(fixture({ ok: true, status: 201, json: async () => ({ id: session.id }) }).api.create('pc'));
});

test('closing an owned sector session accepts an empty successful response', async () => {
    const { api } = fixture({ ok: true, status: 204, json: async () => { throw new Error('no body'); } });
    assert.equal(await api.request(session, '', { method: 'DELETE' }), null);
});