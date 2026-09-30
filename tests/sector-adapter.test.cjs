const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const adapterSource = fs.readFileSync(path.join(__dirname, '../timer_sector/scriptsSector.js'), 'utf8');
const currentTime = () => performance.now();

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    return { promise, resolve, reject };
}

class Element {
    constructor(tagName = 'div') {
        this.tagName = tagName.toUpperCase();
        this.children = [];
        this.style = {};
        this.className = '';
        this.textContent = '';
        this.value = '';
        this.disabled = false;
        this.files = [];
        this.listeners = {};
    }

    append(...nodes) { this.children.push(...nodes); }
    appendChild(node) { this.children.push(node); return node; }
    replaceChildren(...nodes) { this.children = [...nodes]; }
    after(...nodes) { this.children.push(...nodes); }
    addEventListener(type, callback) { this.listeners[type] = callback; }
    setAttribute() {}
    click() { return this.onclick && this.onclick(); }
    querySelectorAll(selector) {
        const tag = selector.toUpperCase();
        const found = [];
        const visit = node => {
            for (const child of node.children || []) {
                if (child.tagName === tag) found.push(child);
                visit(child);
            }
        };
        visit(this);
        return found;
    }
}

class FakeSync {
    constructor(send = () => Promise.resolve()) {
        this.events = [];
        this.synced = true;
        this.send = send;
    }

    clockEstimate() {
        return {
            uncertainty: 1,
            driftAllowance: 0,
            driftRateMsPerSecond: 0.5,
            freshnessLimitMs: 30000,
            rtt: 2
        };
    }

    toLocalTime(value) { return value; }

    sendEvent(kind, payload, sentAt = currentTime()) {
        const event = { kind, payload: structuredClone(payload), sentAt };
        this.events.push(event);
        return this.send(event);
    }

    close() { this.closed = true; }
}

function makeHarness({
    readyBehavior,
    send = () => Promise.resolve(),
    storage: sharedStorage,
    failStorageWrites = false
} = {}) {
    const elements = new Map();
    const storage = sharedStorage || new Map([
        ['pt_sector_runners', JSON.stringify([{ id: 1, name: 'Ana' }, { id: 2, name: 'Luis' }])],
        ['pt_sector_currentRound', '1'],
        ['pt_sector_currentRunnerIndex', '0']
    ]);
    let storageWritesFail = failStorageWrites;
    const document = {
        readyState: 'complete',
        head: new Element('head'),
        getElementById(id) {
            if (!elements.has(id)) elements.set(id, new Element());
            return elements.get(id);
        },
        createElement(tag) { return new Element(tag); },
        addEventListener() {}
    };
    const readers = [];
    class FakeFileReader {
        readAsArrayBuffer() { readers.push(this); }
    }
    const xlsx = {
        read: () => ({ SheetNames: ['Roster'], Sheets: { Roster: {} } }),
        utils: { sheet_to_json: () => [['Carla']] }
    };
    const localStorage = {
        getItem(key) { return storage.has(key) ? storage.get(key) : null; },
        setItem(key, value) {
            if (storageWritesFail) throw new Error('storage unavailable');
            storage.set(key, String(value));
        },
        removeItem(key) { storage.delete(key); }
    };
    let callbacks;
    let runtimeOptions;
    const runtime = {
        armed: false,
        method: 'manual',
        state: 'setup',
        setSync() {},
        setTriggerLabel() {}
    };
    const window = {
        __PACETRACK_SECTOR_TEST_MODE__: true,
        XLSX: xlsx,
        addEventListener() {},
        PaceTrackTiming: {
            create(options) {
                callbacks = options;
                runtimeOptions = options;
                return runtime;
            }
        }
    };
    const context = {
        document,
        window,
        XLSX: xlsx,
        FileReader: FakeFileReader,
        localStorage,
        performance,
        Math,
        Date,
        JSON,
        Promise,
        Blob,
        URL,
        confirm: () => true,
        console,
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval
    };
    vm.runInNewContext(adapterSource, context, { filename: 'scriptsSector.js' });
    const api = window.__PACETRACK_SECTOR_TEST_API__;
    assert.ok(api, 'adapter test API should be enabled in test mode');
    const sync = new FakeSync(event => {
        if (event.kind === 'READY' && readyBehavior) return readyBehavior(event);
        return send(event);
    });
    return {
        api,
        callbacks,
        runtimeOptions,
        window,
        runtime,
        sync,
        storage,
        elements,
        setReady() {
            runtime.armed = true;
            runtime.state = 'manual';
            runtime.method = 'manual';
            callbacks.onReady({ method: 'manual' });
        },
        useSync(nextSync = sync, role = 'stop') {
            api.configurePairing(role, nextSync);
            return nextSync;
        },
        enableStorageWrites() { storageWritesFail = false; },
        completeExcelRead() {
            const reader = readers.at(-1);
            assert.ok(reader, 'an Excel read should have started');
            reader.onload({ target: { result: new ArrayBuffer(0) } });
        },
        event(kind, payload, extra = {}) {
            return { kind, payload, sentAt: currentTime(), ...extra };
        }
    };
}

function resultEvent(sync) {
    return sync.events.find(event => event.kind === 'RESULT');
}

test('configuration is blocked during an active local lap and preserves the measured runner', async () => {
    const harness = makeHarness();
    harness.setReady();
    const startAt = currentTime();
    await harness.callbacks.onTrigger({ now: startAt, method: 'manual' });
    const before = harness.api.state();
    assert.equal(before.currentRunnerName, 'Ana');
    assert.equal(before.timerState, 'running');

    harness.api.openConfiguration();
    assert.equal(harness.elements.get('setup-modal').style.display, 'none');
    assert.equal(harness.api.applyRunners(['Corredor 1']), false);
    harness.elements.get('setup-without-names').click();
    harness.api.openConfiguration();

    const after = harness.api.state();
    assert.equal(after.timerState, 'running');
    assert.equal(after.startTime, startAt);
    assert.equal(after.currentRunnerName, 'Ana');
    assert.deepEqual(after.runners.map(runner => runner.name), ['Ana', 'Luis']);
    assert.match(harness.elements.get('message-content').textContent, /No se puede cambiar la lista/);

    await harness.callbacks.onTrigger({ now: startAt + 5000, method: 'manual' });
    const completed = harness.api.state();
    assert.equal(completed.roundLaps[0].runnerName, 'Ana');
    assert.equal(completed.roundLaps[0].time, 5000);
    assert.equal(completed.roundLaps[0].confirmed, true);
});

test('Excel parsing and submit recheck configuration eligibility after a lap starts', async () => {
    const asyncRead = makeHarness();
    asyncRead.setReady();
    asyncRead.api.openConfiguration();
    asyncRead.elements.get('setup-with-excel').click();
    asyncRead.elements.get('excel-file').files = [{}];
    asyncRead.elements.get('excel-file').listeners.change();
    const startAt = currentTime();
    await asyncRead.callbacks.onTrigger({ now: startAt, method: 'manual' });
    asyncRead.completeExcelRead();
    assert.equal(asyncRead.window.tempExcelNames, null);
    assert.equal(asyncRead.api.state().currentRunnerName, 'Ana');
    assert.equal(asyncRead.api.state().timerState, 'running');

    const submitRace = makeHarness();
    submitRace.setReady();
    submitRace.api.openConfiguration();
    submitRace.elements.get('setup-with-excel').click();
    submitRace.elements.get('excel-file').files = [{}];
    submitRace.elements.get('excel-file').listeners.change();
    submitRace.completeExcelRead();
    assert.deepEqual(submitRace.window.tempExcelNames, ['Carla']);
    const submitStart = currentTime();
    await submitRace.callbacks.onTrigger({ now: submitStart, method: 'manual' });
    submitRace.elements.get('process-excel').click();
    assert.deepEqual(submitRace.api.state().runners.map(runner => runner.name), ['Ana', 'Luis']);
    assert.equal(submitRace.api.state().currentRunnerName, 'Ana');
    assert.equal(submitRace.api.state().startTime, submitStart);
});

test('configuration cannot replace a START attempt while its acknowledgment is pending', async () => {
    const startSend = deferred();
    const harness = makeHarness({
        send: event => event.kind === 'START' ? startSend.promise : Promise.resolve()
    });
    harness.useSync(harness.sync, 'start');
    harness.setReady();
    assert.equal(harness.api.dispatchEvent(harness.event('READY', {
        runnerIndex: 0,
        round: 1,
        runnerName: 'Ana',
        method: 'manual',
        readyId: 'ready-for-ana'
    })), true);

    const startPromise = harness.callbacks.onTrigger({ now: currentTime(), method: 'manual' });
    await new Promise(resolve => setImmediate(resolve));
    const before = harness.api.state();
    assert.equal(before.startPending, true);
    assert.equal(before.pendingAttemptMeta.runnerName, 'Ana');

    harness.api.openConfiguration();
    assert.equal(harness.api.applyRunners(['Corredor 1']), false);
    assert.equal(harness.api.state().pendingAttemptMeta.runnerName, 'Ana');
    assert.deepEqual(harness.api.state().runners.map(runner => runner.name), ['Ana', 'Luis']);

    startSend.resolve();
    await startPromise;
    assert.equal(harness.api.state().activeAttemptMeta.runnerName, 'Ana');
    assert.equal(harness.api.state().currentRunnerName, 'Ana');
});

test('a READY acknowledgment from an interrupted preparation cannot confirm a re-prepared station', async () => {
    const sends = [];
    const readyRequests = [];
    const harness = makeHarness({
        readyBehavior: event => {
            sends.push(event);
            const request = deferred();
            readyRequests.push(request);
            return request.promise;
        }
    });
    harness.useSync();
    harness.setReady();

    const oldReadyPromise = harness.api.ready();
    const oldReadyId = harness.sync.events.at(-1).payload.readyId;
    assert.equal(harness.api.state().pendingReadyId, oldReadyId);
    harness.api.openConfiguration();
    assert.equal(harness.api.applyRunners(['Corredor 1']), false);
    assert.equal(harness.api.state().pendingReadyId, oldReadyId);
    assert.deepEqual(harness.api.state().runners.map(runner => runner.name), ['Ana', 'Luis']);

    harness.runtime.armed = false;
    harness.callbacks.onInterrupt('camera preparation interrupted');
    harness.setReady();
    assert.ok(harness.sync.events.some(event =>
        event.kind === 'UNREADY' && event.payload.readyId === oldReadyId));

    readyRequests[0].resolve();
    await oldReadyPromise;
    assert.equal(harness.api.state().localReadyConfirmed, false);
    assert.equal(harness.api.state().localReadyId, null);
    assert.equal(harness.api.controls().readyDisplay, 'block');

    const freshReadyPromise = harness.api.ready();
    const freshReadyId = harness.sync.events.at(-1).payload.readyId;
    assert.notEqual(freshReadyId, oldReadyId);
    readyRequests[1].resolve();
    await freshReadyPromise;
    assert.equal(harness.api.state().localReadyConfirmed, true);
    assert.equal(harness.api.state().localReadyId, freshReadyId);
    assert.equal(sends.length, 2);
});

test('a RESULT that never reaches the source remains incomplete and does not advance arrival', async () => {
    const harness = makeHarness({
        send: event => event.kind === 'RESULT'
            ? Promise.reject(new Error('result delivery timed out'))
            : Promise.resolve()
    });
    harness.useSync();
    harness.setReady();
    await harness.api.ready();
    const readyId = harness.sync.events.find(event => event.kind === 'READY').payload.readyId;

    const startAt = currentTime() - 1000;
    assert.equal(harness.api.dispatchEvent(harness.event('START', {
        attemptId: 'attempt-never-delivered',
        readyId,
        runnerIndex: 0,
        round: 1,
        runnerName: 'Ana',
        method: 'manual'
    }, { sentAt: startAt, convertedAt: startAt, uncertainty: 1, timingReliable: true })), true);
    await harness.callbacks.onTrigger({ now: startAt + 5000, method: 'manual' });
    await new Promise(resolve => setImmediate(resolve));

    const state = harness.api.state();
    assert.equal(state.currentRunnerIndex, 0);
    assert.equal(state.currentRound, 1);
    assert.equal(state.timerState, 'paused');
    assert.equal(state.roundLaps.length, 1);
    assert.equal(state.roundLaps[0].confirmed, false);
    assert.equal(state.roundLaps[0].invalidated, undefined);
    assert.equal(state.pendingResult.attemptId, 'attempt-never-delivered');
    assert.equal(harness.api.controls().retryDisplay, 'block');
    harness.api.openConfiguration();
    assert.equal(harness.api.applyRunners(['Corredor 1']), false);
    assert.equal(harness.api.state().pendingResult.attemptId, 'attempt-never-delivered');
    assert.equal(harness.api.state().pendingResult.runnerName, 'Ana');
    assert.deepEqual(harness.api.state().runners.map(runner => runner.name), ['Ana', 'Luis']);
});

test('storage failures remain visible and are reported to the core unsaved-data guard', async () => {
    const harness = makeHarness({
        failStorageWrites: true,
        send: event => event.kind === 'RESULT'
            ? Promise.reject(new Error('result delivery timed out'))
            : Promise.resolve()
    });
    harness.useSync();
    harness.setReady();
    await harness.api.ready();
    const readyId = harness.sync.events.find(event => event.kind === 'READY').payload.readyId;
    const startAt = currentTime() - 1000;
    harness.api.dispatchEvent(harness.event('START', {
        attemptId: 'attempt-unsaved',
        readyId,
        runnerIndex: 0,
        round: 1,
        runnerName: 'Ana',
        method: 'manual'
    }, { sentAt: startAt, convertedAt: startAt, uncertainty: 1, timingReliable: true }));
    await harness.callbacks.onTrigger({ now: startAt + 5000, method: 'manual' });
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(harness.runtimeOptions.hasUnsavedData(), true);
    assert.match(harness.api.controls().syncStatus, /ADVERTENCIA: No se pudo guardar/);
    assert.equal(harness.api.state().pendingResult.attemptId, 'attempt-unsaved');

    harness.enableStorageWrites();
    await harness.api.retryResult();
    assert.equal(harness.runtimeOptions.hasUnsavedData(), false);
    assert.doesNotMatch(harness.api.controls().syncStatus, /ADVERTENCIA:/);
});

test('an accepted RESULT with a lost ACK is idempotently reconciled after reconnect', async () => {
    const firstResultSend = deferred();
    const arrivalSync = new FakeSync(event => event.kind === 'RESULT'
        ? firstResultSend.promise
        : Promise.resolve());
    const arrival = makeHarness();
    arrival.useSync(arrivalSync, 'stop');
    arrival.setReady();
    await arrival.api.ready();
    const readyId = arrivalSync.events.find(event => event.kind === 'READY').payload.readyId;

    const sourceSync = new FakeSync();
    const source = makeHarness();
    source.useSync(sourceSync, 'start');
    source.setReady();
    assert.equal(source.api.dispatchEvent(source.event('READY', {
        runnerIndex: 0,
        round: 1,
        runnerName: 'Ana',
        method: 'manual',
        readyId
    })), true);
    const startAt = currentTime();
    await source.callbacks.onTrigger({ now: startAt, method: 'manual' });
    const startEvent = sourceSync.events.find(event => event.kind === 'START');
    assert.ok(startEvent);

    assert.equal(arrival.api.dispatchEvent(arrival.event('START', startEvent.payload, {
        sentAt: startEvent.sentAt,
        convertedAt: startEvent.sentAt,
        uncertainty: 1,
        timingReliable: true
    })), true);
    await arrival.callbacks.onTrigger({ now: startEvent.sentAt + 5000, method: 'manual' });
    const initialResult = resultEvent(arrivalSync);
    assert.ok(initialResult);
    assert.equal(arrival.api.state().currentRunnerIndex, 0);

    const acceptedResultMessage = source.event('RESULT', initialResult.payload);
    assert.equal(source.api.dispatchEvent(acceptedResultMessage), true);
    assert.equal(source.api.state().currentRunnerIndex, 1);
    assert.equal(source.api.state().roundLaps.filter(lap => lap.attemptId === initialResult.payload.attemptId).length, 1);

    arrival.runtime.armed = false;
    arrival.callbacks.onInterrupt('camera interrupted while RESULT ACK was pending');
    assert.equal(arrival.api.state().currentRunnerIndex, 0);
    assert.equal(arrival.api.state().pendingResult.invalidated, undefined);
    assert.equal(arrivalSync.events.some(event => event.kind === 'ABORT'), false);
    firstResultSend.reject(new Error('ACK was lost after source acceptance'));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(arrival.api.state().currentRunnerIndex, 0);
    assert.equal(arrival.api.state().pendingResult.confirmed, false);

    arrival.api.disconnected();
    source.api.disconnected();
    const retrySync = new FakeSync();
    arrival.useSync(retrySync, 'stop');
    source.useSync(new FakeSync(), 'start');
    arrival.setReady();
    source.setReady();
    assert.equal(arrival.api.controls().retryDisplay, 'block');
    await arrival.api.retryResult();

    const retry = resultEvent(retrySync);
    assert.deepEqual(retry.payload, initialResult.payload);
    assert.equal(source.api.dispatchEvent(source.event('RESULT', retry.payload)), true);
    assert.equal(source.api.state().currentRunnerIndex, 1);
    assert.equal(source.api.state().roundLaps.filter(lap => lap.attemptId === retry.payload.attemptId).length, 1);
    assert.equal(arrival.api.state().currentRunnerIndex, 1);
    assert.equal(arrival.api.state().roundLaps.filter(lap => lap.attemptId === retry.payload.attemptId).length, 1);
    assert.equal(arrival.api.state().roundLaps[0].confirmed, true);
});

test('a never-received RESULT can be retried against the source attempt retained across reconnect', async () => {
    const arrival = makeHarness();
    const arrivalSync = new FakeSync(event => event.kind === 'RESULT'
        ? Promise.reject(new Error('connection lost before RESULT delivery'))
        : Promise.resolve());
    arrival.useSync(arrivalSync, 'stop');
    arrival.setReady();
    await arrival.api.ready();
    const readyId = arrivalSync.events.find(event => event.kind === 'READY').payload.readyId;

    const source = makeHarness();
    const sourceSync = new FakeSync();
    source.useSync(sourceSync, 'start');
    source.setReady();
    source.api.dispatchEvent(source.event('READY', {
        runnerIndex: 0, round: 1, runnerName: 'Ana', method: 'manual', readyId
    }));
    const startAt = currentTime();
    await source.callbacks.onTrigger({ now: startAt, method: 'manual' });
    const start = sourceSync.events.find(event => event.kind === 'START');
    arrival.api.dispatchEvent(arrival.event('START', start.payload, {
        sentAt: start.sentAt, convertedAt: start.sentAt, uncertainty: 1, timingReliable: true
    }));
    await arrival.callbacks.onTrigger({ now: start.sentAt + 5000, method: 'manual' });
    await new Promise(resolve => setImmediate(resolve));
    const incomplete = arrival.api.state().pendingResult;
    assert.ok(incomplete);
    assert.equal(arrival.api.state().currentRunnerIndex, 0);
    assert.equal(source.api.state().currentRunnerIndex, 0);
    arrival.runtime.armed = false;
    arrival.callbacks.onInterrupt('camera interrupted after measured RESULT delivery failed');
    assert.equal(arrival.api.state().pendingResult.attemptId, start.payload.attemptId);
    assert.equal(arrival.api.state().pendingResult.invalidated, undefined);
    assert.equal(source.api.state().currentRunnerIndex, 0);
    assert.equal(arrivalSync.events.some(event => event.kind === 'ABORT'), false);

    arrival.api.disconnected();
    source.api.disconnected();
    const arrivalAfterReload = makeHarness({ storage: arrival.storage });
    const sourceAfterReload = makeHarness({ storage: source.storage });
    assert.equal(sourceAfterReload.api.state().recoverableAttempt.attemptId, start.payload.attemptId);
    assert.equal(arrivalAfterReload.api.state().pendingResult.attemptId, start.payload.attemptId);
    const retrySync = new FakeSync();
    arrivalAfterReload.useSync(retrySync, 'stop');
    sourceAfterReload.useSync(new FakeSync(), 'start');
    arrivalAfterReload.setReady();
    sourceAfterReload.setReady();
    await arrivalAfterReload.api.retryResult();

    const retry = resultEvent(retrySync);
    assert.equal(retry.payload.attemptId, start.payload.attemptId);
    assert.equal(sourceAfterReload.api.dispatchEvent(sourceAfterReload.event('RESULT', retry.payload)), true);
    assert.equal(sourceAfterReload.api.state().currentRunnerIndex, 1);
    assert.equal(sourceAfterReload.api.state().recoverableAttempt, null);
    assert.equal(arrivalAfterReload.api.state().currentRunnerIndex, 1);
    assert.equal(arrivalAfterReload.api.state().roundLaps[0].confirmed, true);
});