(function () {
    'use strict';

    const firebaseConfig = {
        apiKey: "AIzaSyC_IPrOClJF0uIkQB_yIEMdZZ28AgCE4k",
        authDomain: "pacetrack-579ef.firebaseapp.com",
        databaseURL: "https://pacetrack-579ef-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "pacetrack-579ef",
        storageBucket: "pacetrack-579ef.firebasestorage.app",
        messagingSenderId: "997850928548",
        appId: "1:997850928548:web:ce6bf324a6a2c42d4bdd31",
        measurementId: "G-M7E0JYMVGX"
    };

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
    const sessionId = urlParams.get('session');
    const storageKey = sessionId ? `pt_pcmobil_recordedLaps:${sessionId}` : 'pt_pcmobil_recordedLaps:local';
    const queueStorageKey = 'pacetrack.result-sync.v1';
    let database = null;
    let firebaseReady = false;
    let runtime = null;
    let fallbackFrame = 0;
    let runStartedAt = null;
    let currentMethod = null;
    let lastElapsed = 0;
    let recordedLaps = [];
    let localSaveFailed = false;
    let sync = null;
    let firebaseConnectionRef = null;
    let firebaseConnectionHandler = null;
    let firebaseListenersAttached = false;
    let networkListenersAttached = false;
    let fallbackPaused = false;

    function formatTime(milliseconds) {
        const safe = Math.max(0, Number(milliseconds) || 0);
        const minutes = Math.floor(safe / 60000);
        const seconds = Math.floor((safe % 60000) / 1000);
        const ms = Math.floor(safe % 1000);
        return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
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
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
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
            if (!data) {
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
        const result = {
            id: makeId(),
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
            setSync('Sesión local: resultado guardado solo en este dispositivo.', 'local');
            return;
        }
        if (!sync) {
            setSync('Resultado guardado localmente; el módulo de sincronización no está disponible. Reintenta cuando se cargue.', 'error');
            return;
        }
        try {
            sync.enqueue(result);
            if (!firebaseReady) {
                setSync('Resultado guardado y en cola local; Firebase no está disponible todavía.', 'pending');
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

    function attachFirebaseConnection() {
        if (!firebaseConnectionRef || !sync || firebaseListenersAttached) return;
        if (!firebaseConnectionHandler) {
            firebaseConnectionHandler = snapshot => sync && sync.setConnected(snapshot.val() === true);
        }
        firebaseConnectionRef.on('value', firebaseConnectionHandler, error => {
            setSync('No se pudo comprobar la conexión con Firebase: ' + error.message, 'error');
        });
        firebaseListenersAttached = true;
    }

    function detachFirebaseConnection() {
        if (firebaseConnectionRef && firebaseListenersAttached) {
            firebaseConnectionRef.off('value', firebaseConnectionHandler);
            firebaseListenersAttached = false;
        }
    }

    function handleOnline() {
        if (sync) sync.setConnected(true);
    }

    function handleOffline() {
        if (sync) sync.setConnected(false);
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
                if (!firebaseReady || !database) return Promise.reject(new Error('Firebase todavía no está disponible.'));
                const safeResult = Object.assign({}, result);
                delete safeResult.syncState;
                delete safeResult.attempts;
                delete safeResult.lastError;
                return database.ref(`sessions/${targetSession}/results/${result.id}`).set(safeResult);
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

    function setupFirebase(manualRetry) {
        if (!sessionId) {
            setSync('Sesión local: no se ha recibido un QR. Los resultados quedan en este dispositivo.', 'local');
            return;
        }
        try {
            const retryButton = byId('retry-sync-button');
            retryButton.hidden = false;
            if (!window.PaceTrackResultSync) {
                setSync('Módulo de sincronización no disponible; los resultados permanecen guardados localmente.', 'error');
                return;
            }
            createSyncQueue();
            reconcileLocalResults();
            if (!window.firebase || !firebase.database || !firebase.initializeApp) {
                firebaseReady = false;
                setSync('Firebase no está disponible. Los resultados de esta sesión permanecen en la cola local.', 'error');
                return;
            }
            if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
            database = firebase.database();
            firebaseReady = true;
            if (!firebaseConnectionRef) firebaseConnectionRef = database.ref('.info/connected');
            attachFirebaseConnection();
            attachNetworkListeners();
            if (manualRetry) sync.retry();
            else sync.flush();
        } catch (error) {
            firebaseReady = false;
            setSync('No se pudo iniciar Firebase: ' + error.message + '. El guardado local sigue activo.', 'error');
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
    setupFirebase();
    resetButton.addEventListener('click', confirmReset);
    byId('export-local-results').addEventListener('click', exportHistory);
    byId('retry-sync-button').addEventListener('click', () => {
        try {
            setupFirebase(true);
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
        detachFirebaseConnection();
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
        attachFirebaseConnection();
        if (sync) sync.flush();
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