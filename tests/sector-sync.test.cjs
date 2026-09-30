const test = require('node:test');
const assert = require('node:assert/strict');
const SectorSync = require('../timing/sector-sync.js');

function pair({ offset = 0, latency = 4, duplicate = false, drop = () => false } = {}) {
    const base = Date.now();
    const received = [];
    let a;
    let b;
    const deliver = (to, raw, direction) => {
        if (drop(raw, direction)) return;
        setTimeout(() => {
            to.receive(raw);
            if (duplicate) to.receive(raw);
        }, latency);
    };
    a = new SectorSync({
        sessionId: 'test-room',
        now: () => performance.now() + base,
        transport: raw => deliver(b, raw, 'a-to-b'),
        onEvent: event => received.push(['a', event])
    });
    b = new SectorSync({
        sessionId: 'test-room',
        now: () => performance.now() + base + offset,
        transport: raw => deliver(a, raw, 'b-to-a'),
        onEvent: event => received.push(['b', event])
    });
    return { a, b, received };
}

test('NTP samples compensate clock offset and network round trip; reliable events deduplicate', async () => {
    const { a, b, received } = pair({ offset: 1250, latency: 5, duplicate: true });
    const [estimate] = await Promise.all([a.measureClock(), b.measureClock()]);
    assert.ok(Math.abs(estimate.offset - 1250) < 50);
    assert.ok(estimate.rtt >= 0 && estimate.rtt < 1000);
    assert.ok(estimate.uncertainty >= estimate.rtt / 2);
    assert.ok(estimate.driftAllowance > 0);
    assert.ok(estimate.driftAllowance <= estimate.freshnessLimitMs / 1000 * estimate.driftRateMsPerSecond);
    assert.ok(Math.abs(a.toLocalTime(10000) - (10000 - 1250)) < 50);

    await a.sendEvent('START', { runnerIndex: 0 });
    assert.equal(received.filter(item => item[1].kind === 'START').length, 1);
    assert.equal(received.find(item => item[1].kind === 'START')[0], 'b');
    assert.equal(received.find(item => item[1].kind === 'START')[1].timingReliable, true);
    a.close();
    b.close();
});

test('messages from another session and malformed payloads are rejected', () => {
    const { a } = pair();
    assert.equal(a.receive('{not-json'), false);
    assert.equal(a.receive({ v: 1, sessionId: 'other', eventId: 'x', type: 'ping', t0: 1 }), false);
    assert.equal(a.receive({ v: 1, sessionId: 'test-room', eventId: 'x', type: 'event', kind: 'START', sentAt: 1, payload: null }), false);
    a.close();
});

test('duplicate event resends its ACK after a lost first confirmation without processing twice', async () => {
    let droppedAck = false;
    const { a, b, received } = pair({
        latency: 2,
        drop: (raw, direction) => {
            const message = JSON.parse(raw);
            if (!droppedAck && direction === 'b-to-a' && message.type === 'ack') {
                droppedAck = true;
                return true;
            }
            return false;
        }
    });
    a.timeoutMs = b.timeoutMs = 5;
    a.maxRetries = 2;
    await Promise.all([a.measureClock(), b.measureClock()]);
    await a.sendEvent('READY', { runnerIndex: 0, round: 1 });
    assert.equal(droppedAck, true);
    assert.equal(received.filter(item => item[1].kind === 'READY').length, 1);
    a.close();
    b.close();
});

test('an event rejected while unready can never become a delayed start on retry', () => {
    let accept = false;
    let processed = 0;
    const sync = new SectorSync({
        sessionId: 'guarded',
        transport: () => {},
        now: () => 5000,
        validateEvent: () => accept,
        onEvent: () => processed++
    });
    const event = {
        v: 1, sessionId: 'guarded', eventId: 'old-start', type: 'event',
        kind: 'START', sentAt: 5000, payload: { runnerIndex: 0, round: 1 }
    };
    assert.equal(sync.receive(event), false);
    accept = true;
    assert.equal(sync.receive(event), false);
    assert.equal(processed, 0);
    sync.close();
});

test('an event is acknowledged only after adapter processing succeeds', () => {
    const outbound = [];
    let accept = false;
    let processed = 0;
    const sync = new SectorSync({
        sessionId: 'process-before-ack',
        transport: raw => outbound.push(JSON.parse(raw)),
        now: () => 5000,
        validateEvent: () => true,
        onEvent: () => {
            if (!accept) return false;
            processed++;
        }
    });
    const event = {
        v: 1, sessionId: 'process-before-ack', eventId: 'result-event',
        type: 'event', kind: 'RESULT', sentAt: 5000, payload: { attemptId: 'attempt-1' }
    };
    assert.equal(sync.receive(event), false);
    assert.equal(outbound.filter(message => message.type === 'ack').length, 0);
    assert.equal(processed, 0);

    const accepted = { ...event, eventId: 'result-retry' };
    accept = true;
    assert.equal(sync.receive(accepted), true);
    assert.equal(outbound.filter(message => message.type === 'ack' && message.ackId === 'result-retry').length, 1);
    assert.equal(processed, 1);
    sync.close();
});

test('unsolicited and duplicate pongs cannot manufacture five fresh clock samples', async () => {
    const outbound = [];
    const sync = new SectorSync({
        sessionId: 'pong-guard',
        transport: raw => outbound.push(JSON.parse(raw)),
        now: () => 10000
    });
    for (let i = 0; i < 5; i++) {
        sync.receive({
            v: 1, sessionId: 'pong-guard', eventId: `unsolicited-${i}`,
            type: 'pong', replyTo: `ping-${i}`, t0: 9000, t1: 9001, t2: 9002
        });
    }
    assert.equal(sync.samples.length, 0);
    assert.equal(sync.synced, false);

    const pingPromise = sync._request(sync._message('ping', { t0: 10000 }));
    const ping = outbound.find(message => message.type === 'ping');
    const pong = {
        v: 1, sessionId: 'pong-guard', eventId: ping.eventId,
        type: 'pong', replyTo: ping.eventId, t0: ping.t0, t1: 10000, t2: 10000
    };
    assert.equal(sync.receive(pong), true);
    for (let i = 0; i < 5; i++) assert.equal(sync.receive(pong), false);
    await pingPromise;
    assert.equal(sync.samples.length, 1);
    assert.equal(sync.synced, false);
    sync.close();
});

test('stale UNREADY and ABORT identities do not alter current readiness or attempt', () => {
    let readyId = 'ready-current';
    let attemptId = 'attempt-current';
    let invalidations = 0;
    const sync = new SectorSync({
        sessionId: 'identity-guard',
        transport: () => {},
        now: () => 5000,
        validateEvent: message => {
            const p = message.payload;
            if (message.kind === 'UNREADY') return p.readyId === readyId;
            if (message.kind === 'ABORT') return p.readyId === readyId && p.attemptId === attemptId;
            return true;
        },
        onEvent: message => {
            if (message.kind === 'UNREADY') invalidations++;
            if (message.kind === 'ABORT') invalidations++;
        }
    });
    const event = (kind, payload, eventId) => ({
        v: 1, sessionId: 'identity-guard', eventId, type: 'event',
        kind, sentAt: 5000, payload
    });
    assert.equal(sync.receive(event('UNREADY', { readyId: 'ready-old' }, 'old-unready')), false);
    assert.equal(sync.receive(event('ABORT', {
        readyId: 'ready-current', attemptId: 'attempt-old'
    }, 'old-abort')), false);
    assert.equal(invalidations, 0);
    assert.equal(readyId, 'ready-current');
    assert.equal(attemptId, 'attempt-current');
    assert.equal(sync.receive(event('ABORT', {
        readyId: 'ready-current', attemptId: 'attempt-current'
    }, 'current-abort')), true);
    assert.equal(invalidations, 1);
    sync.close();
});

test('identity-bound UNREADY and ABORT can be sent without a fresh clock estimate', async () => {
    const outbound = [];
    const sync = new SectorSync({
        sessionId: 'emergency-events',
        transport: raw => outbound.push(JSON.parse(raw)),
        now: () => 10000
    });
    for (const kind of ['UNREADY', 'ABORT']) {
        const send = sync.sendEvent(kind, {
            readyId: 'ready-1', attemptId: 'attempt-1', runnerIndex: 0, round: 1
        });
        const message = outbound.at(-1);
        assert.equal(message.kind, kind);
        assert.equal(sync.synced, false);
        sync.receive({
            v: 1, sessionId: 'emergency-events', eventId: `ack-${kind}`,
            type: 'ack', ackId: message.eventId
        });
        await send;
    }
    sync.close();
});

test('unconfirmed sends fail after bounded retries', async () => {
    const { a, b } = pair({ drop: () => true });
    a.timeoutMs = 5;
    a.maxRetries = 1;
    await assert.rejects(a.sendEvent('READY', {}), /referencia horaria/);
    // A ping cannot be answered when transport is unavailable.
    await assert.rejects(a.measureClock(), /No se confirmó ping/);
    a.close();
    b.close();
});

test('old clock estimates become unusable', async () => {
    let now = 10000;
    const a = new SectorSync({ sessionId: 'fresh', transport: () => {}, now: () => now, minSamples: 1, maxAgeMs: 20 });
    a.samples.push({ offset: 4, rtt: 2, at: now });
    assert.equal(a.synced, true);
    now += 21;
    assert.equal(a.clockEstimate(), null);
    a.close();
});