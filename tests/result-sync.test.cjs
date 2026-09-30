const test = require('node:test');
const assert = require('node:assert/strict');
const ResultSync = require('../timing/result-sync.js');

function memoryStorage() {
    const values = new Map();
    return {
        getItem: key => values.has(key) ? values.get(key) : null,
        setItem: (key, value) => values.set(key, value)
    };
}

test('results are idempotent and scoped to their session', async () => {
    const storage = memoryStorage();
    const sent = [];
    const sync = ResultSync.create({
        sessionId: 'session-a',
        storage,
        transport: async (sessionId, result) => sent.push([sessionId, result.id]),
        retryDelays: []
    });
    sync.enqueue({ id: 'same-id', elapsed: 1200 });
    sync.enqueue({ id: 'same-id', elapsed: 9999 });
    sync.enqueue({ id: 'same-id', elapsed: 1200 }, 'session-b');
    await sync.flush();
    assert.deepEqual(sent, [['session-a', 'same-id']]);
    assert.equal(sync.getQueue('session-a').length, 1);
    assert.equal(sync.getQueue('session-b').length, 1);
    assert.equal(sync.getQueue('session-a')[0].syncState, 'confirmed');
    assert.equal(sync.getQueue('session-a')[0].elapsed, 1200, 'a stale duplicate cannot replace the stored result');
    sync.dispose();
});

test('bounded transport failures remain persisted and retry can confirm', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const states = [];
    const sync = ResultSync.create({
        sessionId: 'session-a',
        storage,
        maxAttempts: 2,
        retryDelays: [],
        onStatus: event => states.push(event.state),
        transport: async () => {
            calls += 1;
            if (calls <= 2) throw new Error('offline');
        }
    });
    sync.enqueue({ id: 'r-1', elapsed: 900 });
    await sync.flush();
    await sync.flush();
    assert.equal(sync.getQueue()[0].syncState, 'error');
    assert.equal(JSON.parse(storage.getItem(ResultSync.STORAGE_KEY)).sessions['session-a'][0].attempts, 2);
    await sync.retry();
    assert.equal(sync.getQueue()[0].syncState, 'confirmed');
    assert.ok(states.includes('pending'));
    assert.ok(states.includes('error'));
    assert.ok(states.includes('confirmed'));
    sync.dispose();
});

test('offline queue is persisted and does not send until reconnected', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const first = ResultSync.create({
        sessionId: 's1',
        storage,
        connected: false,
        transport: async () => { calls += 1; }
    });
    first.enqueue({ id: 'queued', elapsed: 500 });
    assert.equal(calls, 0);
    first.dispose();
    const resumed = ResultSync.create({
        sessionId: 's1',
        storage,
        transport: async (session, result) => {
            assert.equal(session, 's1');
            assert.equal(result.id, 'queued');
            calls += 1;
        }
    });
    await resumed.flush();
    assert.equal(calls, 1);
    assert.equal(resumed.getQueue()[0].syncState, 'confirmed');
    resumed.dispose();
});

test('a max-attempt error is not retried on reconnect until explicit retry', async () => {
    const storage = memoryStorage();
    let calls = 0;
    const sync = ResultSync.create({
        sessionId: 's-capped',
        storage,
        maxAttempts: 1,
        retryDelays: [],
        transport: async () => {
            calls += 1;
            if (calls === 1) throw new Error('offline');
        }
    });
    sync.enqueue({ id: 'limited', elapsed: 400 });
    await sync.flush();
    assert.equal(sync.getQueue()[0].syncState, 'error');
    sync.setConnected(false);
    sync.setConnected(true);
    await sync.flush();
    assert.equal(calls, 1, 'reconnect does not bypass the bounded retry limit');
    await sync.retry();
    assert.equal(calls, 2);
    assert.equal(sync.getQueue()[0].syncState, 'confirmed');
    sync.dispose();
});

test('empty startup flush does not prevent later reconciliation and idempotent enqueue', async () => {
    const storage = memoryStorage();
    const sent = [];
    const sync = ResultSync.create({
        sessionId: 's-reconcile',
        storage,
        connected: false,
        retryDelays: [],
        transport: async (session, result) => sent.push([session, result.id])
    });
    await sync.flush();
    const recovered = {
        id: 'saved-before-sync-init',
        sessionId: 's-reconcile',
        elapsed: 1700,
        method: 'manual',
        syncState: 'local'
    };
    assert.deepEqual(sync.reconcile([recovered, Object.assign({}, recovered, { sessionId: 'unrelated' })]), {
        queued: 1,
        confirmed: 0
    });
    sync.reconcile([recovered]);
    assert.equal(sync.getQueue().length, 1);
    sync.setConnected(true);
    await sync.flush();
    assert.deepEqual(sent, [['s-reconcile', 'saved-before-sync-init']]);
    assert.equal(sync.getQueue()[0].syncState, 'confirmed');
    sync.reconcile([Object.assign({}, recovered, { elapsed: 9999, syncState: 'confirmed' })]);
    assert.equal(sync.getQueue()[0].elapsed, 1700, 'a confirmed local record is never downgraded by reconciliation');
    sync.dispose();
});

test('reset clear is session-scoped and suppresses callbacks for an in-flight result', async () => {
    const storage = memoryStorage();
    storage.setItem(ResultSync.STORAGE_KEY, JSON.stringify({
        sessions: {
            'reset-session': [{ id: 'confirmed-before-reset', elapsed: 50, syncState: 'confirmed', attempts: 0 }],
            'other-session': [{ id: 'other-session', elapsed: 300, syncState: 'pending', attempts: 0 }]
        }
    }));
    let resolveWrite;
    const sent = [];
    const statuses = [];
    const sync = ResultSync.create({
        sessionId: 'reset-session',
        storage,
        connected: false,
        retryDelays: [],
        onStatus: event => statuses.push([event.state, event.result && event.result.id]),
        transport: (session, result) => {
            sent.push([session, result.id]);
            return new Promise(resolve => { resolveWrite = resolve; });
        }
    });
    sync.enqueue({ id: 'sending', elapsed: 100 }, 'reset-session');
    sync.enqueue({ id: 'queued', elapsed: 200 }, 'reset-session');
    sync.setConnected(true);
    const flushing = sync.flush();
    await Promise.resolve();
    assert.deepEqual(sent, [['reset-session', 'sending']]);

    const cleared = sync.clearSession('reset-session');
    assert.deepEqual(cleared.removedIds, ['sending', 'queued']);
    assert.deepEqual(cleared.inFlightIds, ['sending']);
    assert.deepEqual(cleared.preservedConfirmedIds, ['confirmed-before-reset']);
    assert.deepEqual(sync.getQueue('reset-session').map(item => item.id), ['confirmed-before-reset']);
    assert.equal(sync.getQueue('other-session').length, 1);
    const statusCountAfterClear = statuses.length;
    resolveWrite();
    await flushing;
    assert.deepEqual(sync.getQueue('reset-session').map(item => item.id), ['confirmed-before-reset'], 'completion of the old request cannot recreate a cleared record');
    assert.equal(statuses.length, statusCountAfterClear, 'the old request cannot emit a stale confirmation after reset');
    assert.equal(statuses.some(([state, id]) => state === 'confirmed' && id === 'sending'), false);
    sync.dispose();
});