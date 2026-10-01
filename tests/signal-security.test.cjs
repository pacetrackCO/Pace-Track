'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const signal = require('../netlify/functions/signal.js');
const poll = require('../netlify/functions/poll.js');
const security = require('../netlify/functions/lib/signal-security.js');

const TEST_SECRET = 'test-only-signal-secret-which-is-not-a-credential';

function createMemoryStore() {
    const values = new Map();
    let version = 0;
    return {
        values,
        atomicQueueContract: security.ATOMIC_QUEUE_CONTRACT,
        async getVersioned(key) {
            const record = values.get(key);
            return record ? {
                value: JSON.parse(JSON.stringify(record.value)),
                version: record.version
            } : null;
        },
        async createIfAbsent(key, value) {
            if (values.has(key)) return false;
            version += 1;
            values.set(key, {
                value: JSON.parse(JSON.stringify(value)),
                version: String(version)
            });
            return true;
        },
        async setIfVersion(key, expectedVersion, value) {
            const record = values.get(key);
            if (!record || record.version !== expectedVersion) return false;
            version += 1;
            values.set(key, {
                value: JSON.parse(JSON.stringify(value)),
                version: String(version)
            });
            return true;
        }
    };
}

function createBlobsApiStub() {
    const values = new Map();
    let etagSequence = 0;
    const api = {
        values,
        reads: [],
        writes: [],
        conditionalFailures: 0,
        beforeConditionalWrite: null,
        seed(key, value, etag = `etag-${++etagSequence}`) {
            values.set(key, { value: JSON.parse(JSON.stringify(value)), etag });
        },
        store: {
            async getWithMetadata(key, options = {}) {
                api.reads.push({ key, options });
                assert.equal(options.type, 'json');
                assert.equal(options.consistency, 'strong');
                const entry = values.get(key);
                return entry ? {
                    data: JSON.parse(JSON.stringify(entry.value)),
                    etag: entry.etag,
                    metadata: {}
                } : null;
            },
            async setJSON(key, value, options = {}) {
                api.writes.push({ key, options });
                const hasOnlyIfNew = options.onlyIfNew === true;
                const hasOnlyIfMatch = typeof options.onlyIfMatch === 'string';
                assert.notEqual(hasOnlyIfNew, hasOnlyIfMatch, 'each write must use one conditional');
                if (hasOnlyIfMatch && api.beforeConditionalWrite) {
                    const hook = api.beforeConditionalWrite;
                    api.beforeConditionalWrite = null;
                    await hook(key);
                }

                const existing = values.get(key);
                if ((hasOnlyIfNew && existing) ||
                    (hasOnlyIfMatch && (!existing || existing.etag !== options.onlyIfMatch))) {
                    if (hasOnlyIfMatch) api.conditionalFailures += 1;
                    return { modified: false };
                }
                const etag = `etag-${++etagSequence}`;
                values.set(key, { value: JSON.parse(JSON.stringify(value)), etag });
                return { modified: true, etag };
            }
        }
    };
    return api;
}

function createSignalHandler(options = {}) {
    return signal.createHandler(Object.assign({ signingSecret: TEST_SECRET }, options));
}

function createPollHandler(options = {}) {
    return poll.createHandler(Object.assign({ signingSecret: TEST_SECRET }, options));
}

function token(id, peer, options = {}) {
    return security.mintCapability({
        id,
        peer,
        secret: TEST_SECRET,
        ...options
    });
}

function postEvent(capability, body, extra = {}) {
    return {
        httpMethod: 'POST',
        headers: Object.assign({ authorization: `Bearer ${capability}` }, extra.headers),
        body,
        ...extra
    };
}

function getEvent(capability, id, extra = {}) {
    return {
        httpMethod: 'GET',
        headers: Object.assign({ authorization: `Bearer ${capability}` }, extra.headers),
        queryStringParameters: { id },
        ...extra
    };
}

function json(response) {
    return JSON.parse(response.body);
}

test('unauthorized requests are rejected before accessing shared storage', async () => {
    let storageCalls = 0;
    const signalHandler = createSignalHandler({
        resolveStore: async () => { storageCalls += 1; return createMemoryStore(); }
    });
    const pollHandler = createPollHandler({
        resolveStore: async () => { storageCalls += 1; return createMemoryStore(); }
    });

    const signalResponse = await signalHandler(postEvent('', JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0' }
    })));
    const pollResponse = await pollHandler({ httpMethod: 'GET', queryStringParameters: { id: 'alice' } });

    assert.equal(signalResponse.statusCode, 401);
    assert.equal(pollResponse.statusCode, 401);
    assert.equal(storageCalls, 0);
});

test('capabilities cannot be replayed for another peer or session id', async () => {
    let storageCalls = 0;
    const store = createMemoryStore();
    const signalHandler = createSignalHandler({
        resolveStore: async () => { storageCalls += 1; return store; }
    });
    const pollHandler = createPollHandler({
        resolveStore: async () => { storageCalls += 1; return store; }
    });
    const aliceToken = token('alice', 'bob');

    const sendResponse = await signalHandler(postEvent(aliceToken, JSON.stringify({
        id: 'alice',
        target: 'mallory',
        data: { type: 'offer', sdp: 'v=0' }
    })));
    const pollResponse = await pollHandler(getEvent(token('bob', 'alice'), 'mallory'));

    assert.equal(sendResponse.statusCode, 403);
    assert.equal(pollResponse.statusCode, 403);
    assert.equal(storageCalls, 0);
    assert.equal(store.values.size, 0);
});

test('expired and malformed signed capabilities are rejected', async () => {
    let storageCalls = 0;
    const handler = createSignalHandler({
        resolveStore: async () => { storageCalls += 1; return createMemoryStore(); }
    });
    const expired = token('alice', 'bob', { now: Date.now() - 60 * 60 * 1000 });
    const body = JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0' }
    });

    const expiredResponse = await handler(postEvent(expired, body));
    const malformedResponse = await handler(postEvent('not-a-signed-capability', body));

    assert.equal(expiredResponse.statusCode, 401);
    assert.equal(malformedResponse.statusCode, 401);
    assert.equal(storageCalls, 0);
});

test('invalid JSON and oversized request bodies have explicit client errors', async () => {
    const handler = createSignalHandler({ resolveStore: async () => createMemoryStore() });
    const capability = token('alice', 'bob');

    const invalidJson = await handler(postEvent(capability, '{"id":'));
    const tooLarge = await handler(postEvent(capability, 'x'.repeat(security.MAX_REQUEST_BYTES + 1)));

    assert.equal(invalidJson.statusCode, 400);
    assert.match(json(invalidJson).error, /JSON/);
    assert.equal(tooLarge.statusCode, 413);
});

test('only supported WebRTC payload shapes are accepted', async () => {
    let storageCalls = 0;
    const handler = createSignalHandler({
        resolveStore: async () => { storageCalls += 1; return createMemoryStore(); }
    });
    const capability = token('alice', 'bob');
    const base = { id: 'alice', target: 'bob' };

    const unknownType = await handler(postEvent(capability, JSON.stringify({
        ...base,
        data: { type: 'renegotiate', sdp: 'v=0' }
    })));
    const malformedCandidate = await handler(postEvent(capability, JSON.stringify({
        ...base,
        data: { candidate: 'candidate:1', unexpected: true }
    })));

    assert.equal(unknownType.statusCode, 400);
    assert.equal(malformedCandidate.statusCode, 400);
    assert.equal(storageCalls, 0);
});

test('cross-origin browser requests and unsupported methods are rejected without wildcard CORS', async () => {
    let storageCalls = 0;
    const handler = createSignalHandler({
        resolveStore: async () => { storageCalls += 1; return createMemoryStore(); }
    });
    const capability = token('alice', 'bob');
    const body = JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0' }
    });

    const crossOrigin = await handler(postEvent(capability, body, {
        headers: { origin: 'https://attacker.invalid', host: 'app.example.test', 'x-forwarded-proto': 'https' }
    }));
    const options = await handler({ httpMethod: 'OPTIONS', headers: { host: 'app.example.test' } });

    assert.equal(crossOrigin.statusCode, 403);
    assert.equal(options.statusCode, 405);
    assert.equal(Object.hasOwn(crossOrigin.headers, 'Access-Control-Allow-Origin'), false);
    assert.equal(storageCalls, 0);
});

test('storage failures and an unadapted SDK store fail explicitly without memory fallback', async () => {
    const capability = token('alice', 'bob');
    const body = JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0' }
    });
    const unavailable = createSignalHandler({
        resolveStore: async () => { throw new Error('backend unavailable'); }
    });
    const brokenStore = createMemoryStore();
    brokenStore.createIfAbsent = async () => { throw new Error('write failed'); };
    const writeFailure = createSignalHandler({ resolveStore: async () => brokenStore });
    let rawSdkWriteCalls = 0;
    const rawSdkLikeStore = {
        async get() { return null; },
        async setJSON() { rawSdkWriteCalls += 1; },
        async delete() {}
    };
    const unsupportedStore = createSignalHandler({ resolveStore: async () => rawSdkLikeStore });

    assert.equal((await unavailable(postEvent(capability, body))).statusCode, 503);
    assert.equal((await writeFailure(postEvent(capability, body))).statusCode, 503);
    assert.equal((await unsupportedStore(postEvent(capability, body))).statusCode, 503);
    assert.equal(rawSdkWriteCalls, 0, 'raw SDK methods cannot bypass the audited adapter');
    assert.equal(brokenStore.values.size, 0);
});

test('short-lived scoped capabilities support the authenticated offer/candidate/poll flow', async () => {
    const store = createMemoryStore();
    const send = createSignalHandler({ resolveStore: async () => store });
    const receive = createPollHandler({ resolveStore: async () => store });
    const aliceToken = token('alice', 'bob');
    const bobToken = token('bob', 'alice');

    const offerResponse = await send(postEvent(aliceToken, JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0\r\n' }
    })));
    const candidateResponse = await send(postEvent(aliceToken, JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: {
            candidate: 'candidate:1 1 udp 1 192.0.2.1 1234 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0
        }
    })));
    const pollResponse = await receive(getEvent(bobToken, 'bob'));

    assert.equal(offerResponse.statusCode, 200);
    assert.equal(candidateResponse.statusCode, 200);
    assert.equal(pollResponse.statusCode, 200);
    assert.deepEqual(json(pollResponse).map(message => message.data), [
        { type: 'offer', sdp: 'v=0\r\n' },
        {
            candidate: 'candidate:1 1 udp 1 192.0.2.1 1234 typ host',
            sdpMid: '0',
            sdpMLineIndex: 0
        }
    ]);
    assert.equal(Object.hasOwn(pollResponse.headers, 'Access-Control-Allow-Origin'), false);
    assert.equal(store.values.size, 2, 'consumed slots remain as bounded CAS tombstones');
    assert.ok([...store.values.values()].every(record => record.value.tombstone === true));
});

test('pair-scoped queues keep another peer from filling or draining this conversation', async () => {
    const store = createMemoryStore();
    const send = createSignalHandler({ resolveStore: async () => store });
    const receive = createPollHandler({ resolveStore: async () => store });
    const aliceToken = token('alice', 'bob');
    const carolToken = token('carol', 'bob');
    const bobAliceToken = token('bob', 'alice');
    const bodyFor = (id, target, sdp) => JSON.stringify({
        id,
        target,
        data: { type: 'offer', sdp }
    });

    assert.equal((await send(postEvent(aliceToken, bodyFor('alice', 'bob', 'v=0\r\nalice')))).statusCode, 200);
    for (let index = 0; index < security.MAX_QUEUE_ITEMS; index += 1) {
        assert.equal((await send(postEvent(carolToken, bodyFor('carol', 'bob', `v=0\r\ncarol:${index}`)))).statusCode, 200);
    }

    const alicePoll = await receive(getEvent(bobAliceToken, 'bob'));
    assert.deepEqual(json(alicePoll).map(message => message.data.sdp), ['v=0\r\nalice']);
    assert.equal(store.values.size, security.MAX_QUEUE_ITEMS + 1);
});

test('atomic storage-adapter slots enforce the configured per-pair bound', async () => {
    const store = createMemoryStore();
    const send = createSignalHandler({ resolveStore: async () => store });
    const capability = token('alice', 'bob');

    for (let index = 0; index < security.MAX_QUEUE_ITEMS; index += 1) {
        const response = await send(postEvent(capability, JSON.stringify({
            id: 'alice',
            target: 'bob',
            data: { type: 'offer', sdp: `v=0\r\nx-index:${index}` }
        })));
        assert.equal(response.statusCode, 200);
    }
    const overflow = await send(postEvent(capability, JSON.stringify({
        id: 'alice',
        target: 'bob',
        data: { type: 'offer', sdp: 'v=0\r\nx-index:overflow' }
    })));

    assert.equal(overflow.statusCode, 429);
    assert.equal(store.values.size, security.MAX_QUEUE_ITEMS);
});

test('the v11 API-shaped adapter uses strong reads and conditional writes under concurrent quota pressure', async () => {
    const api = createBlobsApiStub();
    const store = security.createBlobsQueueAdapter(api.store);
    const send = createSignalHandler({ resolveStore: async () => store });
    const capability = token('alice', 'bob');
    const requests = Array.from({ length: security.MAX_QUEUE_ITEMS + 8 }, (_, index) => send(postEvent(
        capability,
        JSON.stringify({
            id: 'alice',
            target: 'bob',
            data: { type: 'offer', sdp: `v=0\r\nconcurrent:${index}` }
        })
    )));
    const responses = await Promise.all(requests);

    assert.equal(responses.filter(response => response.statusCode === 200).length, security.MAX_QUEUE_ITEMS);
    assert.equal(responses.filter(response => response.statusCode === 429).length, 8);
    assert.equal(api.values.size, security.MAX_QUEUE_ITEMS);
    assert.ok(api.reads.length > 0);
    assert.ok(api.reads.every(read => read.options.consistency === 'strong'));
    assert.ok(api.writes.every(write =>
        write.options.onlyIfNew === true || typeof write.options.onlyIfMatch === 'string'));
    assert.equal(Object.hasOwn(api.store, 'delete'), false, 'adapter never depends on physical deletes');

    const receive = createPollHandler({ resolveStore: async () => store });
    const polled = await receive(getEvent(token('bob', 'alice'), 'bob'));
    assert.equal(polled.statusCode, 200);
    assert.equal(json(polled).length, security.MAX_QUEUE_ITEMS);
    assert.equal(api.values.size, security.MAX_QUEUE_ITEMS, 'poll replaces slots with tombstones');
    assert.ok([...api.values.values()].every(entry => entry.value.tombstone === true));
});

test('a failed SDK ETag CAS cannot delete a concurrently replaced slot', async () => {
    const api = createBlobsApiStub();
    const oldMessage = {
        from: 'alice',
        data: { type: 'offer', sdp: 'v=0\r\nold' },
        timestamp: Date.now(),
        expiresAt: Date.now() + 300000
    };
    const newMessage = {
        from: 'alice',
        data: { type: 'offer', sdp: 'v=0\r\nnew' },
        timestamp: Date.now(),
        expiresAt: Date.now() + 300000
    };
    const firstKey = security.inboxSlotKey('bob', 'alice', 0);
    api.seed(firstKey, oldMessage, 'old-etag');
    api.beforeConditionalWrite = async key => {
        assert.equal(key, firstKey);
        api.seed(firstKey, newMessage, 'new-etag');
    };
    const store = security.createBlobsQueueAdapter(api.store);

    const firstPoll = await security.pollSignals(store, 'bob', 'alice');
    assert.deepEqual(firstPoll, []);
    assert.deepEqual(api.values.get(firstKey).value, newMessage);
    assert.ok(api.writes.some(write => write.options.onlyIfMatch === 'old-etag'));
    assert.equal(api.conditionalFailures, 1);

    const secondPoll = await security.pollSignals(store, 'bob', 'alice');
    assert.deepEqual(secondPoll.map(message => message.data.sdp), ['v=0\r\nnew']);
    assert.equal(api.values.get(firstKey).value.tombstone, true);
});

test('expired queue data is never polled and its bounded slot is reused via a tombstone CAS', async () => {
    const api = createBlobsApiStub();
    const key = security.inboxSlotKey('bob', 'alice', 0);
    const expiredAt = Date.now() - 1000;
    api.seed(key, {
        from: 'alice',
        data: { type: 'offer', sdp: 'v=0\r\nexpired' },
        timestamp: expiredAt - 300000,
        expiresAt: expiredAt
    });
    const store = security.createBlobsQueueAdapter(api.store);

    assert.deepEqual(await security.pollSignals(store, 'bob', 'alice'), []);
    assert.equal(api.values.get(key).value.tombstone, true);

    const timestamp = Date.now();
    const accepted = await security.enqueueSignal(store, 'bob', 'alice', {
        from: 'alice',
        data: { type: 'offer', sdp: 'v=0\r\nfresh' },
        timestamp,
        expiresAt: timestamp + 300000
    });
    assert.equal(accepted, true);
    assert.equal(api.values.get(key).value.data.sdp, 'v=0\r\nfresh');
    assert.equal(api.values.size, 1, 'a pair reuses its fixed key instead of creating per-message blobs');
});