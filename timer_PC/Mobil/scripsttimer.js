(function () {
    'use strict';

    const byId = id => document.getElementById(id);
    const video = byId('video');
    const overlayCanvas = byId('overlay-canvas');
    const timerDisplay = byId('timer-display');
    const statusMessage = byId('status-message');
    const syncStatus = byId('sync-status');
    const resetButton = byId('reset-button');
    const sensitivitySlider = byId('sensitivity-slider');
    const lapsContainer = byId('laps-container');
    const lapsList = byId('laps-list');
    const urlParams = new URLSearchParams(window.location.search);
    const requestedSessionId = urlParams.get('session');
    const invalidSession = requestedSessionId !== null && !validSessionId(requestedSessionId);
    const sessionId = validSessionId(requestedSessionId) ? requestedSessionId : null;
    const SESSION_KIND = 'pc';
    const fragmentParams = new URLSearchParams(String(window.location.hash || '').replace(/^#/, ''));
    const requestedInvite = fragmentParams.get('invite');
    const validRequestedInvite = validInvite(requestedInvite) ? requestedInvite : null;
    const storageKey = sessionId ? `pt_pcmobil_recordedLaps:${sessionId}` : 'pt_pcmobil_recordedLaps:local';
    const queueStorageKey = 'pacetrack.result-sync.v1';
    let api = null;
    let guestSession = null;
    let backendReady = false;
    let setupGeneration = 0;
    let setupInFlight = false;
    let capabilityMessage = null;
    let runtime = null;
    let fallbackFrame = 0;
    let runStartedAt = null;
    let currentMethod = null;
    let lastElapsed = 0;
    let recordedLaps = [];
    let localSaveFailed = false;
    let sync = null;
    let networkListenersAttached = false;
    let fallbackPaused = false;

    function formatTime(milliseconds) {
        const safe = Math.max(0, Number(milliseconds) || 0);
        const minutes = Math.floor(safe / 60000);
        const seconds = Math.floor((safe % 60000) / 1000);
        const ms = Math.floor(safe % 1000);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
    }

    function validSessionId(value) {
        return typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value);
    }

    function validInvite(value) {
        return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
    }

    function validResultId(value) {
        return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value);
    }

    function utf8ByteLength(value) {
        try {
            return encodeURIComponent(value).replace(/%[0-9A-F]{2}/gi, 'x').length;
        } catch (_) {
            return Infinity;
        }
    }

    function safeTransportResult(targetSession, result) {
        if (!validSessionId(sessionId) || targetSession !== sessionId || !validSessionId(targetSession)) {
            throw new Error('La sesión de destino no coincide con la sesión móvil válida.');
        }
        if (!result || typeof result !== 'object' || Array.isArray(result) ||
            result.sessionId !== targetSession || !validResultId(result.id)) {
            throw new Error('El resultado no tiene una sesión vinculada o un identificador seguro válido.');
        }
        if (typeof result.elapsed !== 'number' || !Number.isFinite(result.elapsed) ||
            result.elapsed < 0 || result.elapsed > 2592000000) {
            throw new Error('La duración del resultado no está dentro de los límites permitidos.');
        }
        if (!['manual', 'automatic'].includes(result.method)) {
            throw new Error('El método del resultado no es válido.');
        }
        if (typeof result.timestamp !== 'string' || result.timestamp.length > 40 ||
            !Number.isFinite(Date.parse(result.timestamp))) {
            throw new Error('La fecha del resultado no es válida.');
        }
        const safeResult = {
            id: result.id,
            elapsed: result.elapsed,
            method: result.method,
            timestamp: result.timestamp,
            sessionId: targetSession
        };
        if (utf8ByteLength(JSON.stringify(safeResult)) > 2048) {
            throw new Error('El resultado supera el tamaño máximo permitido.');
        }
        return safeResult;
    }

    function setSync(text, kind) {
        if (runtime && typeof runtime.setSync === 'function') {
            runtime.setSync(text, kind || 'local');
            return;
        }
        if (syncStatus) {
            syncStatus.textContent = text;
            syncStatus.dataset.kind = kind || 'local';
        }
    }

    function makeId() {
        const secureCrypto = window.crypto;
        if (secureCrypto && typeof secureCrypto.randomUUID === 'function') {
            const generated = secureCrypto.randomUUID();
            if (validSessionId(generated)) return generated;
            throw new Error('No se pudo crear un identificador de resultado seguro.');
        }
        if (!secureCrypto || typeof secureCrypto.getRandomValues !== 'function') {
            throw new Error('Este navegador no ofrece aleatoriedad criptográfica segura; no se puede crear el resultado.');
        }
        try {
            const bytes = new Uint8Array(16);
            secureCrypto.getRandomValues(bytes);
            bytes[6] = (bytes[6] & 0x0f) | 0x40;
            bytes[8] = (bytes[8] & 0x3f) | 0x80;
            const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
            return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
        } catch (error) {
            throw new Error(`No se pudo obtener aleatoriedad criptográfica segura: ${error.message}`);
        }
    }

    function saveLocal() {
        try {
            localStorage.setItem(storageKey, JSON.stringify(recordedLaps));
            localSaveFailed = false;
            return true;
        } catch (error) {
            localSaveFailed = true;
            setSync('No se pudo guardar en este dispositivo: ' + error.message, 'error');
            return false;
        }
    }

    function loadLocal() {
        try {
            let data = localStorage.getItem(storageKey);
            if (!data && requestedSessionId === null) {
                data = localStorage.getItem('pt_pcmobil_recordedLaps') || localStorage.getItem('recordedLaps');
            }
            const parsed = data ? JSON.parse(data) : [];
            if (!Array.isArray(parsed)) throw new Error('El historial guardado no tiene un formato válido.');
            let migrated = false;
            recordedLaps = parsed.map((item, index) => {
                if (typeof item === 'number' && Number.isFinite(item)) {
                    migrated = true;
                    return {
                        id: `legacy-${index}-${Math.round(item)}`,
                        elapsed: item,
                        method: 'legacy',
                        timestamp: new Date().toISOString(),
                        legacy: true,
                        syncState: 'local'
                    };
                }
                if (item && Number.isFinite(Number(item.elapsed))) return item;
                return null;
            }).filter(Boolean);
            if (migrated) saveLocal();
        } catch (error) {
            recordedLaps = [];
            setSync('No se pudo recuperar el historial: ' + error.message, 'error');
        }
        displayLaps();
    }

    function displayLaps() {
        lapsList.replaceChildren();
        lapsContainer.style.display = recordedLaps.length ? 'block' : 'none';
        recordedLaps.forEach((result, index) => {
            const li = document.createElement('li');
            const label = document.createElement('span');
            const time = document.createElement('span');
            const method = document.createElement('small');
            label.textContent = `P${index + 1}:`;
            time.textContent = formatTime(result.elapsed);
            method.textContent = result.method === 'manual' ? 'Manual' :
                result.method === 'automatic' ? 'Automático' : 'Importado';
            method.className = 'lap-method';
            li.append(label, time, method);
            lapsList.appendChild(li);
        });
        lapsList.scrollTop = lapsList.scrollHeight;
    }

    function updateClock(now) {
        if (runStartedAt !== null) {
            lastElapsed = Math.max(0, now - runStartedAt);
            timerDisplay.textContent = formatTime(lastElapsed);
            timerDisplay.style.color = '#00FFFF';
        }
    }

    function updateTriggerLabel() {
        const label = runStartedAt === null ? 'Iniciar' : 'Registrar vuelta';
        if (runtime && typeof runtime.setTriggerLabel === 'function') runtime.setTriggerLabel(label);
        const fallback = byId('mobile-manual-trigger');
        if (fallback) fallback.textContent = label;
    }

    function onTrigger(event) {
        const now = Number(event && event.now);
        const method = event && event.method === 'automatic' ? 'automatic' : 'manual';
        if (!Number.isFinite(now)) return;
        if (runStartedAt === null) {
            runStartedAt = now;
            currentMethod = method;
            lastElapsed = 0;
            statusMessage.textContent = 'Cronómetro en marcha. Registra el siguiente paso para guardar el tiempo.';
            updateTriggerLabel();
            updateClock(now);
            return;
        }

        const elapsed = Math.max(0, now - runStartedAt);
        let resultId;
        try {
            resultId = makeId();
        } catch (error) {
            setSync(error.message, 'error');
            statusMessage.textContent = error.message;
            return;
        }
        const result = {
            id: resultId,
            elapsed: elapsed,
            method: currentMethod === method ? method : 'manual',
            timestamp: new Date().toISOString(),
            sessionId: sessionId || null,
            syncState: sessionId ? 'pending' : 'local'
        };
        recordedLaps.push(result);
        const stored = saveLocal();
        displayLaps();
        runStartedAt = null;
        lastElapsed = elapsed;
        currentMethod = null;
        timerDisplay.textContent = formatTime(elapsed);
        timerDisplay.style.color = '#e2e8f0';
        statusMessage.textContent = stored
            ? `Paso ${recordedLaps.length} guardado (${result.method === 'manual' ? 'manual' : 'automático'}). Listo para el siguiente.`
            : 'Paso cronometrado, pero no se pudo guardar localmente. Comprueba el almacenamiento del dispositivo.';
        updateTriggerLabel();
        if (!stored) return;
        if (!sessionId) {
            if (invalidSession) {
                setSync('El código de sesión del enlace no es válido. El resultado se guardó solo en este dispositivo y no se sincronizará.', 'error');
            } else {
                setSync('Sesión local: resultado guardado solo en este dispositivo.', 'local');
            }
            return;
        }
        if (!sync) {
            setSync('Resultado guardado localmente; el módulo de sincronización no está disponible. Reintenta cuando se cargue.', 'error');
            return;
        }
        try {
            sync.enqueue(result);
            if (!backendReady) {
                setSync(`Resultado guardado en la cola local. ${capabilityMessage || 'Falta validar la vinculación Replit.'}`, 'pending');
            }
        } catch (error) {
            setSync('Resultado guardado en el dispositivo; no se pudo crear la cola de envío: ' + error.message, 'error');
        }
    }

    function onInterrupt(reason) {
        if (runStartedAt !== null) {
            runStartedAt = null;
            currentMethod = null;
            timerDisplay.textContent = formatTime(lastElapsed);
            updateTriggerLabel();
        }
        statusMessage.textContent = reason || 'La detección se interrumpió. Revisa la cámara y vuelve a preparar.';
    }

    function updateSyncSummary(event) {
        const queue = sync ? sync.getQueue(sessionId) : [];
        const pendingCount = queue.filter(item => item.syncState === 'pending').length;
        const errorCount = queue.filter(item => item.syncState === 'error').length;
        if (event && event.error && !queue.length) {
            setSync('No se pudo sincronizar: ' + event.error + '. Reintenta cuando sea posible.', 'error');
        } else if (errorCount && pendingCount) {
            setSync(`${pendingCount} resultado(s) pendiente(s) y ${errorCount} con error. Reintenta la sincronización.`, 'error');
        } else if (errorCount) {
            setSync(`${errorCount} resultado(s) con error de sincronización. Reintenta el envío.`, 'error');
        } else if (pendingCount) {
            setSync(`${pendingCount} resultado(s) pendiente(s) de confirmación del servidor.`, 'pending');
        } else if (queue.length && queue.every(item => item.syncState === 'confirmed')) {
            setSync('Todos los resultados de esta sesión están confirmados por el servidor.', 'confirmed');
        } else if (event && event.error) {
            setSync('No se pudo sincronizar: ' + event.error + '. Reintenta cuando sea posible.', 'error');
        }
    }

    function handleOnline() {
        if (sessionId) setupSession(true);
    }

    function handleOffline() {
        backendReady = false;
        if (sync) sync.setConnected(false);
        setSync('Sin conexión. Los resultados siguen guardados y en cola local.', 'pending');
    }

    function attachNetworkListeners() {
        if (networkListenersAttached) return;
        window.addEventListener('online', handleOnline);
        window.addEventListener('offline', handleOffline);
        networkListenersAttached = true;
    }

    function detachNetworkListeners() {
        if (!networkListenersAttached) return;
        window.removeEventListener('online', handleOnline);
        window.removeEventListener('offline', handleOffline);
        networkListenersAttached = false;
    }

    function handleFallbackBeforeUnload(event) {
        if (runStartedAt !== null) {
            event.preventDefault();
            event.returnValue = '';
        }
    }

    function reconcileLocalResults() {
        if (!sync || !sessionId) return;
        try {
            sync.reconcile(recordedLaps);
        } catch (error) {
            setSync('No se pudieron recuperar resultados locales en la cola: ' + error.message, 'error');
        }
    }

    function createSyncQueue() {
        if (sync || !window.PaceTrackResultSync) return;
        sync = window.PaceTrackResultSync.create({
            sessionId: sessionId,
            storageKey: queueStorageKey,
            connected: false,
            transport: function (targetSession, result) {
                let safeResult;
                try {
                    safeResult = safeTransportResult(targetSession, result);
                } catch (error) {
                    return Promise.reject(error);
                }
                if (!backendReady || !api || !guestSession) {
                    return Promise.reject(new Error('No hay una capacidad Replit de invitado validada para esta sesión.'));
                }
                return api.request(guestSession, `/results/${encodeURIComponent(safeResult.id)}`, {
                    method: 'PUT',
                    body: safeResult
                });
            },
            onStatus: function (event) {
                if (event.state === 'confirmed' && event.result) {
                    const local = recordedLaps.find(item => item.id === event.result.id);
                    if (local) {
                        local.syncState = 'confirmed';
                        saveLocal();
                    }
                }
                updateSyncSummary(event);
            }
        });
    }

    function validGuestCapability(candidate) {
        return Boolean(candidate && candidate.id === sessionId && validSessionId(candidate.id) &&
            typeof candidate.token === 'string' && candidate.token.length > 0);
    }

    function removeInvitationFromUrl() {
        if (!validRequestedInvite || !window.history || typeof window.history.replaceState !== 'function') return;
        const cleanUrl = `${window.location.pathname}${window.location.search}`;
        window.history.replaceState(null, '', cleanUrl);
    }

    async function setupSession(manualRetry) {
        if (!sessionId) {
            const message = invalidSession
                ? 'El código de sesión del enlace no es válido. Se usará únicamente el almacenamiento local; no se sincronizará.'
                : 'Sesión local: no se ha recibido un QR. Los resultados quedan en este dispositivo.';
            setSync(message, invalidSession ? 'error' : 'local');
            if (invalidSession) statusMessage.textContent = message;
            return;
        }
        attachNetworkListeners();
        if (setupInFlight) return;
        const generation = ++setupGeneration;
        backendReady = false;
        byId('retry-sync-button').hidden = false;
        if (!window.PaceTrackResultSync) {
            setSync('Módulo de sincronización no disponible; los resultados permanecen guardados localmente.', 'error');
            return;
        }
        createSyncQueue();
        reconcileLocalResults();
        if (sync) sync.setConnected(false);
        setupInFlight = true;
        try {
            api = window.PaceTrackSessionAPI;
            if (!api || typeof api.request !== 'function' || typeof api.load !== 'function') {
                throw new Error('La API de sesiones Replit no está disponible; los resultados quedan en cola local.');
            }
            let capability = await api.load('guest', sessionId);
            if (generation !== setupGeneration) return;
            if (capability && !validGuestCapability(capability)) {
                throw new Error('La capacidad guardada no pertenece a la sesión de este QR.');
            }
            if (!capability) {
                if (!validRequestedInvite) {
                    throw new Error('Falta el código secreto de invitación. Escanea el QR actual para vincular esta sesión; no se ha enviado ningún resultado.');
                }
                if (typeof api.join !== 'function') throw new Error('La vinculación segura Replit no está disponible.');
                capability = await api.join(SESSION_KIND, validRequestedInvite);
                if (generation !== setupGeneration) return;
                if (!validGuestCapability(capability)) {
                    throw new Error('La invitación no pertenece a la sesión indicada por este QR; no se guardó ninguna capacidad.');
                }
                if (api.save('guest', capability) === false) {
                    throw new Error('La sesión se vinculó, pero la capacidad no se pudo guardar para reintentos.');
                }
                if (typeof api.saveInvitation === 'function') {
                    api.saveInvitation(SESSION_KIND, validRequestedInvite, capability);
                }
                guestSession = Object.assign({}, capability, { role: 'guest' });
                removeInvitationFromUrl();
            } else {
                guestSession = Object.assign({}, capability, { role: 'guest' });
            }
            const info = await api.request(guestSession, '', { method: 'GET' });
            if (generation !== setupGeneration) return;
            if (!info || info.id !== sessionId || info.kind !== SESSION_KIND || info.role !== 'guest') {
                throw new Error('El servidor no confirmó la capacidad de invitado para la sesión del QR.');
            }
            backendReady = true;
            capabilityMessage = null;
            if (sync) {
                sync.setConnected(true);
                if (manualRetry) await sync.retry();
                else await sync.flush();
            }
            removeInvitationFromUrl();
            if (sync && sync.getQueue(sessionId).length) updateSyncSummary();
            else setSync('Sesión Replit validada; los resultados nuevos se enviarán con la capacidad de invitado.', 'local');
        } catch (error) {
            if (generation === setupGeneration) {
                backendReady = false;
                if (sync) sync.setConnected(false);
                capabilityMessage = error.message;
                setSync(`No se pudo validar la sesión Replit: ${error.message}. Los resultados permanecen guardados en cola local.`, 'error');
            }
        } finally {
            if (generation === setupGeneration) setupInFlight = false;
        }
    }

    function confirmReset() {
        const currentQueue = sync && sessionId ? sync.getQueue(sessionId) : [];
        const hasData = recordedLaps.length > 0 || runStartedAt !== null || currentQueue.length > 0;
        const warning = sessionId
            ? '¿Borrar el historial local y descartar los envíos pendientes de esta sesión? Los resultados ya confirmados en el PC no se borran. Un envío que haya empezado puede completarse en el servidor aunque se borre aquí.'
            : '¿Reiniciar el cronómetro y borrar el historial guardado en este dispositivo?';
        if (hasData && !window.confirm(warning)) return;

        const previousHistory = JSON.stringify(recordedLaps);
        try {
            localStorage.setItem(storageKey, '[]');
        } catch (error) {
            setSync('No se pudo borrar el historial local: ' + error.message, 'error');
            statusMessage.textContent = 'No se reinició la sesión porque no se pudo guardar el cambio en el dispositivo.';
            return;
        }
        let clearedQueue = { removedIds: [], inFlightIds: [], preservedConfirmedIds: [] };
        if (sync && sessionId) {
            try {
                clearedQueue = sync.clearSession(sessionId);
            } catch (error) {
                try { localStorage.setItem(storageKey, previousHistory); } catch (_) {}
                setSync('No se pudo limpiar la cola de esta sesión: ' + error.message, 'error');
                statusMessage.textContent = 'No se reinició la sesión; la cola de sincronización no pudo limpiarse.';
                return;
            }
        }
        if (runtime) runtime.stop();
        runStartedAt = null;
        currentMethod = null;
        lastElapsed = 0;
        recordedLaps = [];
        displayLaps();
        timerDisplay.textContent = '00:00.000';
        timerDisplay.style.color = '#e2e8f0';
        statusMessage.textContent = 'Historial local reiniciado. Elige cámara o modo manual para continuar.';
        updateTriggerLabel();
        if (clearedQueue.inFlightIds.length) {
            setSync('Historial local borrado. Un envío ya iniciado podría aparecer en el PC; los resultados confirmados no se pueden borrar desde aquí.', 'pending');
        } else if (clearedQueue.preservedConfirmedIds.length) {
            setSync('Historial local borrado. Los resultados ya confirmados siguen visibles en el PC.', 'confirmed');
        } else if (sessionId) {
            setSync('Historial local y envíos pendientes de esta sesión borrados.', 'local');
        }
        if (runtime) runtime.prepare();
    }

    function exportHistory() {
        const rows = [['Paso', 'Milisegundos', 'Tiempo', 'Método', 'Fecha', 'ID', 'Sincronización']];
        recordedLaps.forEach((result, index) => rows.push([
            index + 1,
            Number(result.elapsed),
            formatTime(result.elapsed),
            result.method || 'legacy',
            result.timestamp || '',
            result.id || '',
            result.syncState || 'local'
        ]));
        const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `pacetrack-historial-${sessionId || 'local'}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function installRuntime() {
        if (window.PaceTrackTiming && typeof window.PaceTrackTiming.create === 'function') {
            runtime = window.PaceTrackTiming.create({
                mode: 'mobilepc',
                video: video,
                canvas: overlayCanvas,
                status: statusMessage,
                display: timerDisplay,
                slider: sensitivitySlider,
                mount: byId('app-container'),
                onTrigger: onTrigger,
                onFrame: updateClock,
                onInterrupt: onInterrupt,
                onReady: function (event) {
                    statusMessage.textContent = event && event.method === 'manual'
                        ? 'Modo manual listo. Pulsa Iniciar cuando estés preparado.'
                        : 'Detección lista. El siguiente paso iniciará el cronómetro.';
                    updateTriggerLabel();
                },
                getActivity: function () { return runStartedAt !== null; },
                hasUnsavedData: function () { return localSaveFailed && recordedLaps.length > 0; }
            });
            if (syncStatus) {
                runtime.setSync(syncStatus.textContent, syncStatus.dataset.kind || 'local');
                syncStatus.hidden = true;
            }
            return;
        }

        statusMessage.textContent = 'Preparación automática no disponible. El modo manual permanece disponible; no se ha solicitado la cámara.';
        const fallbackButton = document.createElement('button');
        fallbackButton.id = 'mobile-manual-trigger';
        fallbackButton.type = 'button';
        fallbackButton.textContent = 'Iniciar';
        byId('controls').appendChild(fallbackButton);
        fallbackButton.addEventListener('click', () => onTrigger({ now: performance.now(), method: 'manual' }));
        const fallbackStatus = document.createElement('p');
        fallbackStatus.textContent = 'El componente de cámara no está disponible en esta página. Puedes cronometrar manualmente.';
        byId('video-container').appendChild(fallbackStatus);
        window.addEventListener('beforeunload', handleFallbackBeforeUnload);
        function frame(now) {
            updateClock(now);
            fallbackFrame = requestAnimationFrame(frame);
        }
        fallbackFrame = requestAnimationFrame(frame);
    }

    loadLocal();
    installRuntime();
    setupSession(false);
    resetButton.addEventListener('click', confirmReset);
    byId('export-local-results').addEventListener('click', exportHistory);
    byId('retry-sync-button').addEventListener('click', () => {
        try {
            setupSession(true);
        } catch (error) {
            setSync('No se pudo reintentar el envío: ' + error.message, 'error');
        }
    });
    window.addEventListener('pagehide', event => {
        // PaceTrackTiming owns camera teardown and must deliver interruption before BFCache suspension.
        if (fallbackFrame) {
            cancelAnimationFrame(fallbackFrame);
            fallbackFrame = 0;
            fallbackPaused = true;
        }
        setupGeneration += 1;
        setupInFlight = false;
        backendReady = false;
        if (sync) {
            if (event.persisted) sync.setConnected(false);
            else sync.dispose();
        }
        if (!event.persisted) {
            detachNetworkListeners();
        }
    });
    window.addEventListener('pageshow', event => {
        if (!event.persisted) return;
        setupSession(false);
        if (fallbackPaused && !runtime) {
            fallbackPaused = false;
            function frame(now) {
                updateClock(now);
                fallbackFrame = requestAnimationFrame(frame);
            }
            fallbackFrame = requestAnimationFrame(frame);
        }
    });
})();