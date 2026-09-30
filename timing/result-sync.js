(function (root, factory) {
    const api = factory();
    if (typeof module === 'object' && module.exports) module.exports = api;
    if (root) root.PaceTrackResultSync = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
    'use strict';

    const STORAGE_KEY = 'pacetrack.result-sync.v1';

    function create(options) {
        const config = options || {};
        const storage = config.storage || (typeof localStorage !== 'undefined' ? localStorage : null);
        const transport = config.transport;
        const onStatus = typeof config.onStatus === 'function' ? config.onStatus : function () {};
        const maxAttempts = Math.max(1, Number(config.maxAttempts) || 4);
        const delays = Array.isArray(config.retryDelays) ? config.retryDelays : [500, 1500, 4000];
        let connected = config.connected !== false;
        let disposed = false;
        let persistenceError = storage ? null : 'Almacenamiento local no disponible.';
        let activeFlush = null;
        let flushRequested = false;
        let inFlight = null;
        let retryTimer = null;
        const sessionGenerations = new Map();
        let data = read();
        if (persistenceError) status('error', null, persistenceError);

        function read() {
            if (!storage) return { sessions: {} };
            try {
                const parsed = JSON.parse(storage.getItem(config.storageKey || STORAGE_KEY) || '{"sessions":{}}');
                return parsed && parsed.sessions ? parsed : { sessions: {} };
            } catch (error) {
                persistenceError = 'No se pudo recuperar la cola local: ' + error.message;
                return { sessions: {} };
            }
        }

        function persist() {
            if (!storage) throw new Error(persistenceError || 'Almacenamiento local no disponible.');
            try {
                storage.setItem(config.storageKey || STORAGE_KEY, JSON.stringify(data));
            } catch (error) {
                persistenceError = 'No se pudo guardar la cola local: ' + error.message;
                throw error;
            }
        }

        function key(sessionId) {
            return String(sessionId || '');
        }

        function list(sessionId) {
            return data.sessions[key(sessionId)] || [];
        }

        function generation(sessionId) {
            return sessionGenerations.get(key(sessionId)) || 0;
        }

        function status(state, result, error) {
            onStatus({ state: state, result: result || null, error: error || null, sessionId: config.sessionId || null });
        }

        function enqueue(result, sessionId) {
            const targetSession = key(sessionId || config.sessionId);
            if (!targetSession) throw new Error('No se puede sincronizar sin una sesión de destino.');
            if (!result || !result.id) throw new Error('El resultado necesita un identificador estable.');
            if (persistenceError) throw new Error(persistenceError);
            data.sessions[targetSession] = data.sessions[targetSession] || [];
            const records = data.sessions[targetSession];
            const existing = records.find(function (item) { return item.id === result.id; });
            if (!existing) {
                records.push(Object.assign({}, result, { syncState: 'pending', attempts: 0 }));
                persist();
            }
            status(existing && existing.syncState === 'confirmed' ? 'confirmed' : 'pending', existing || result);
            if (targetSession === key(config.sessionId)) flush();
            return existing || records[records.length - 1];
        }

        function scheduleRetry(delay) {
            if (disposed || retryTimer !== null) return;
            retryTimer = setTimeout(function () {
                retryTimer = null;
                flush();
            }, delay);
        }

        function flush() {
            const targetSession = key(config.sessionId);
            if (disposed || !targetSession || !connected || typeof transport !== 'function') return Promise.resolve();
            if (persistenceError) {
                status('error', null, persistenceError);
                return Promise.resolve();
            }
            if (activeFlush) {
                flushRequested = true;
                return activeFlush;
            }
            activeFlush = Promise.resolve().then(async function () {
                const flushGeneration = generation(targetSession);
                try {
                    const records = list(targetSession);
                    for (const record of records) {
                        if (disposed || !connected || generation(targetSession) !== flushGeneration) break;
                        if (!list(targetSession).includes(record)) continue;
                        if (record.syncState === 'confirmed' || record.syncState === 'error') continue;
                        record.syncState = 'pending';
                        record.attempts = Number(record.attempts) || 0;
                        persist();
                        status('pending', record);
                        inFlight = { sessionId: targetSession, id: record.id, generation: flushGeneration };
                        try {
                            await transport(targetSession, Object.assign({}, record));
                            if (generation(targetSession) !== flushGeneration || !list(targetSession).includes(record)) break;
                            record.syncState = 'confirmed';
                            delete record.lastError;
                            persist();
                            status('confirmed', record);
                        } catch (error) {
                            if (generation(targetSession) !== flushGeneration || !list(targetSession).includes(record)) break;
                            record.attempts += 1;
                            record.syncState = record.attempts >= maxAttempts ? 'error' : 'pending';
                            record.lastError = error && error.message ? error.message : String(error || 'Error de conexión');
                            persist();
                            status(record.syncState, record, record.lastError);
                            if (record.syncState === 'pending' && delays.length) {
                                scheduleRetry(delays[Math.min(record.attempts - 1, delays.length - 1)]);
                            }
                            break;
                        } finally {
                            if (inFlight && inFlight.sessionId === targetSession && inFlight.id === record.id) inFlight = null;
                        }
                    }
                } catch (error) {
                    status('error', null, error && error.message ? error.message : String(error));
                } finally {
                    activeFlush = null;
                    const requested = flushRequested;
                    flushRequested = false;
                    if (requested && connected && !disposed && retryTimer === null) flush();
                }
            });
            return activeFlush;
        }

        function reconcile(results) {
            const targetSession = key(config.sessionId);
            if (!targetSession || !Array.isArray(results)) return { queued: 0, confirmed: 0 };
            let queued = 0;
            let confirmed = 0;
            results.forEach(function (result) {
                if (!result || result.sessionId !== targetSession || !result.id || result.legacy || result.syncState === 'confirmed') return;
                const existing = list(targetSession).find(function (item) { return item.id === result.id; });
                if (existing && existing.syncState === 'confirmed') {
                    confirmed += 1;
                    status('confirmed', existing);
                    return;
                }
                enqueue(result, targetSession);
                queued += 1;
            });
            return { queued: queued, confirmed: confirmed };
        }

        function clearSession(sessionId) {
            const targetSession = key(sessionId || config.sessionId);
            if (!targetSession) throw new Error('No se puede borrar una cola sin identificar la sesión.');
            const previous = list(targetSession);
            const preserved = previous.filter(function (record) { return record.syncState === 'confirmed'; });
            const removed = previous.filter(function (record) { return record.syncState !== 'confirmed'; });
            if (!removed.length) return { removedIds: [], inFlightIds: [], preservedConfirmedIds: preserved.map(function (record) { return record.id; }) };
            data.sessions[targetSession] = preserved;
            try {
                persist();
            } catch (error) {
                data.sessions[targetSession] = previous;
                throw error;
            }
            sessionGenerations.set(targetSession, generation(targetSession) + 1);
            const removedIds = removed.map(function (record) { return record.id; });
            const inFlightIds = inFlight && inFlight.sessionId === targetSession && removedIds.includes(inFlight.id)
                ? [inFlight.id] : [];
            return {
                removedIds: removedIds,
                inFlightIds: inFlightIds,
                preservedConfirmedIds: preserved.map(function (record) { return record.id; })
            };
        }

        function setConnected(value) {
            connected = Boolean(value);
            if (connected) flush();
        }

        function retry() {
            if (persistenceError) {
                status('error', null, persistenceError);
                return Promise.resolve();
            }
            if (retryTimer !== null) {
                clearTimeout(retryTimer);
                retryTimer = null;
            }
            list(config.sessionId).forEach(function (record) {
                if (record.syncState === 'error') {
                    record.syncState = 'pending';
                    record.attempts = 0;
                    delete record.lastError;
                    status('pending', record);
                }
            });
            persist();
            if (connected) return flush();
        }

        function getQueue(sessionId) {
            return list(sessionId || config.sessionId).map(function (record) { return Object.assign({}, record); });
        }

        function dispose() {
            disposed = true;
            if (retryTimer !== null) clearTimeout(retryTimer);
            retryTimer = null;
        }

        return {
            enqueue: enqueue,
            reconcile: reconcile,
            clearSession: clearSession,
            flush: flush,
            retry: retry,
            setConnected: setConnected,
            getQueue: getQueue,
            dispose: dispose
        };
    }

    return { create: create, STORAGE_KEY: STORAGE_KEY };
});