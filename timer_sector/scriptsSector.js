(() => {
    'use strict';

    const $ = id => document.getElementById(id);
    const video = $('video');
    const overlayCanvas = $('overlay-canvas');
    const timerDisplay = $('timer-display');
    const statusMessage = $('status-message');
    const resetButton = $('reset-button');
    const sensitivitySlider = $('sensitivity-slider');
    const messageBox = $('message-box');
    const messageContent = $('message-content');
    const messageBoxOkButton = $('message-box-ok');
    const lapsContainer = $('laps-container');
    const lapsList = $('laps-list');
    const lapsTitle = $('laps-title');
    const LS_KEYS = {
        laps: 'pt_sector_recordedLaps',
        runners: 'pt_sector_runners',
        index: 'pt_sector_currentRunnerIndex',
        round: 'pt_sector_currentRound',
        roundLaps: 'pt_sector_roundLaps',
        state: 'pt_sector_sessionState'
    };
    const firebaseConfig = {
        apiKey: "AIzaSyA60d4enyr9wtCS4_uQ0EfFYvhZlMLVHj8",
        authDomain: "pruebaspacetrack.firebaseapp.com",
        databaseURL: "https://pruebaspacetrack-default-rtdb.europe-west1.firebasedatabase.app",
        projectId: "pruebaspacetrack",
        storageBucket: "pruebaspacetrack.firebasestorage.app",
        messagingSenderId: "788636325664",
        appId: "1:788636325664:web:1a383742bf31ab3f736945"
    };
    let db = null;
    let runtime = null;
    let pc = null;
    let dataChannel = null;
    let roomRef = null;
    let listeners = [];
    let candidateQueue = [];
    let connectionTimer = null;
    let disconnectTimer = null;
    let clockTimer = null;
    let readinessTimer = null;
    let clockRefreshPending = false;
    let rtcGeneration = 0;
    let preparationGeneration = 0;
    let attemptSequence = 0;
    let role = null;
    let sessionId = null;
    let sync = null;
    let peerReady = false;
    let peerReadyAt = 0;
    let stationReady = false;
    let localReadyConfirmed = false;
    let localReadyAt = 0;
    let localReadyId = null;
    let pendingReadyId = null;
    let peerReadyId = null;
    let runtimeMethod = null;
    let runners = [];
    let currentRunnerIndex = 0;
    let currentRound = 1;
    let timerState = 'stopped';
    let startTime = null;
    let lastDisplayedTime = 0;
    let recordedLaps = [];
    let roundLaps = [];
    let volatileLaps = [];
    let awaitingResult = false;
    let syncConfirmed = false;
    let startMethod = 'manual';
    let startPending = false;
    let startCancelled = false;
    let pendingAttemptId = null;
    let activeAttemptId = null;
    let pendingAttemptReadyId = null;
    let activeAttemptReadyId = null;
    let activeAttemptMeta = null;
    let pendingAttemptMeta = null;
    let recoverableAttempt = null;
    let resultRetryPending = false;
    let syncStatusText = '';
    let syncStatusKind = null;
    let storageFailureMessage = '';
    const rejectedStartAttempts = new Map();

    const formatTime = ms => {
        const safe = Math.max(0, Number(ms) || 0);
        return `${String(Math.floor(safe / 60000)).padStart(2, '0')}:${String(Math.floor((safe % 60000) / 1000)).padStart(2, '0')}.${String(Math.floor(safe % 1000)).padStart(3, '0')}`;
    };
    const currentRunner = () => runners[currentRunnerIndex] || { id: currentRunnerIndex + 1, name: `Corredor ${currentRunnerIndex + 1}` };
    const p2pStatus = text => { $('p2p-status').textContent = text; };
    const renderSyncStatus = () => {
        const text = storageFailureMessage
            ? `${syncStatusText}\nADVERTENCIA: ${storageFailureMessage} Los datos siguen disponibles para exportar en este dispositivo.`
            : syncStatusText;
        $('p2p-sync-status').textContent = text;
        if (runtime && typeof runtime.setSync === 'function') {
            const statusKind = storageFailureMessage ? 'error' : syncStatusKind ||
                (/error|no se pudo|no llegó|incompleto|descart/i.test(text) ? 'error' :
                    /confirmad|sincronizad/i.test(text) ? 'confirmed' :
                        /esperando|midiendo|pendiente/i.test(text) ? 'pending' : 'local');
            runtime.setSync(text, statusKind);
        }
    };
    const p2pSyncStatus = (text, kind) => {
        syncStatusText = String(text);
        syncStatusKind = kind || null;
        renderSyncStatus();
    };

    function showMessageBox(message) {
        messageContent.textContent = message;
        messageBox.style.display = 'block';
    }

    function isCurrentGeneration(generation) { return generation === rtcGeneration; }
    function makeIdentity(prefix) {
        attemptSequence++;
        return `${prefix}:${sessionId || 'local'}:${attemptSequence}:${performance.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
    }

    function findAttemptLap(attemptId) {
        return [...roundLaps, ...recordedLaps, ...volatileLaps].find(lap => lap.attemptId === attemptId) || null;
    }

    function pendingResultLap() {
        return roundLaps.find(lap =>
            lap.runnerIndex === currentRunnerIndex && lap.round === currentRound &&
            typeof lap.attemptId === 'string' && lap.confirmed === false && !lap.invalidated) || null;
    }

    function resultMatchesLap(lap, payload) {
        return !!lap && lap.attemptId === payload.attemptId && lap.readyId === payload.readyId &&
            lap.runnerIndex === payload.runnerIndex && lap.round === payload.round &&
            lap.runnerName === payload.runnerName && lap.time === payload.time &&
            lap.method === payload.method && lap.uncertainty === payload.uncertainty &&
            lap.precision === payload.precision;
    }

    function attemptMetadata(payload) {
        return {
            attemptId: payload.attemptId,
            readyId: payload.readyId,
            runnerIndex: payload.runnerIndex,
            round: payload.round,
            runnerName: payload.runnerName
        };
    }

    function rememberRejectedStart(message) {
        const p = message && message.payload;
        if (!p || typeof p.attemptId !== 'string' || typeof p.readyId !== 'string') return;
        rejectedStartAttempts.set(p.attemptId, {
            readyId: p.readyId,
            runnerIndex: p.runnerIndex,
            round: p.round,
            at: performance.now()
        });
        for (const [attemptId, value] of rejectedStartAttempts) {
            if (performance.now() - value.at >= 30000) rejectedStartAttempts.delete(attemptId);
        }
        while (rejectedStartAttempts.size > 100) {
            rejectedStartAttempts.delete(rejectedStartAttempts.keys().next().value);
        }
    }

    function participantConfigurationBlockReason() {
        const hasPendingResult = !!pendingResultLap();
        const hasAttempt = timerState === 'running' || startPending || awaitingResult ||
            resultRetryPending || !!pendingReadyId || !!pendingAttemptId ||
            localReadyConfirmed || peerReady || !!activeAttemptId ||
            !!activeAttemptMeta || !!pendingAttemptMeta || !!recoverableAttempt ||
            hasPendingResult || (timerState === 'paused' && hasPendingResult);
        if (hasAttempt) {
            return 'No se puede cambiar la lista mientras hay un cronometraje, preparación o resultado pendiente. Resuelve o interrumpe el intento antes de configurar participantes.';
        }
        if (role || sync || pc || dataChannel || roomRef) {
            return 'Desconecta primero las estaciones. Configura la misma lista de participantes antes de volver a enlazar salida y llegada.';
        }
        return '';
    }

    function canConfigureParticipants() {
        const reason = participantConfigurationBlockReason();
        if (reason) showMessageBox(reason);
        return !reason;
    }

    function removeOwnedRoom(ref, ownerSession) {
        if (!ref || !ownerSession) return Promise.resolve();
        return ref.transaction(current => current && current.sessionId === ownerSession ? null : undefined)
            .catch(() => {});
    }

    function removeAnswerIfMatches(ref, ownerSession, answer) {
        if (!ref || !ownerSession || !answer) return Promise.resolve();
        return ref.transaction(current => {
            if (!current || current.sessionId !== ownerSession || !current.answer ||
                current.answer.sdp !== answer.sdp) return undefined;
            const next = { ...current };
            delete next.answer;
            return next;
        }).catch(() => {});
    }

    function saveLaps() {
        try {
            localStorage.setItem(LS_KEYS.state, JSON.stringify({
                version: 1,
                recordedLaps,
                runners,
                currentRunnerIndex,
                currentRound,
                roundLaps,
                outstandingAttempt: activeAttemptMeta || pendingAttemptMeta || recoverableAttempt
            }));
            localStorage.setItem(LS_KEYS.laps, JSON.stringify(recordedLaps));
            localStorage.setItem(LS_KEYS.runners, JSON.stringify(runners));
            localStorage.setItem(LS_KEYS.index, String(currentRunnerIndex));
            localStorage.setItem(LS_KEYS.round, String(currentRound));
            localStorage.setItem(LS_KEYS.roundLaps, JSON.stringify(roundLaps));
            storageFailureMessage = '';
            renderSyncStatus();
        } catch (error) {
            storageFailureMessage = `No se pudo guardar la sesión en este dispositivo: ${error.message}`;
            renderSyncStatus();
        }
    }

    function loadLaps() {
        try {
            const savedState = JSON.parse(localStorage.getItem(LS_KEYS.state) || 'null');
            if (savedState && savedState.version === 1) {
                recordedLaps = savedState.recordedLaps;
                runners = savedState.runners;
                roundLaps = savedState.roundLaps;
                currentRunnerIndex = Math.max(0, Number(savedState.currentRunnerIndex) || 0);
                currentRound = Math.max(1, Number(savedState.currentRound) || 1);
                if (!Array.isArray(recordedLaps)) recordedLaps = [];
                if (!Array.isArray(runners)) runners = [];
                if (!Array.isArray(roundLaps)) roundLaps = [];
                const attempt = savedState.outstandingAttempt;
                if (attempt && typeof attempt.attemptId === 'string' && typeof attempt.readyId === 'string' &&
                    Number.isInteger(attempt.runnerIndex) && Number.isInteger(attempt.round) &&
                    typeof attempt.runnerName === 'string' &&
                    attempt.runnerIndex === currentRunnerIndex && attempt.round === currentRound) {
                    recoverableAttempt = attemptMetadata(attempt);
                }
                displayLaps();
                return;
            }
            if (localStorage.getItem('recordedLaps') && !localStorage.getItem(LS_KEYS.laps)) {
                for (const [oldKey, newKey] of [
                    ['recordedLaps', LS_KEYS.laps], ['runners', LS_KEYS.runners],
                    ['currentRunnerIndex', LS_KEYS.index], ['currentRound', LS_KEYS.round],
                    ['roundLaps', LS_KEYS.roundLaps]
                ]) {
                    const value = localStorage.getItem(oldKey);
                    if (value !== null) localStorage.setItem(newKey, value);
                }
            }
            recordedLaps = JSON.parse(localStorage.getItem(LS_KEYS.laps) || '[]');
            runners = JSON.parse(localStorage.getItem(LS_KEYS.runners) || '[]');
            roundLaps = JSON.parse(localStorage.getItem(LS_KEYS.roundLaps) || '[]');
            currentRunnerIndex = Math.max(0, Number(localStorage.getItem(LS_KEYS.index)) || 0);
            currentRound = Math.max(1, Number(localStorage.getItem(LS_KEYS.round)) || 1);
            if (!Array.isArray(recordedLaps)) recordedLaps = [];
            if (!Array.isArray(runners)) runners = [];
            if (!Array.isArray(roundLaps)) roundLaps = [];
        } catch (error) {
            showMessageBox(`No se pudieron recuperar los resultados guardados: ${error.message}`);
            runners = [];
            recordedLaps = [];
            roundLaps = [];
        }
        displayLaps();
    }

    function displayLaps() {
        const roleIndicator = $('p2p-role-indicator');
        roleIndicator.textContent = role === 'start' ? '(SALIDA)' : role === 'stop' ? '(LLEGADA)' : '';
        if (!runners.length && !volatileLaps.length) {
            lapsContainer.style.display = 'none';
            return;
        }
        lapsContainer.style.display = 'block';
        lapsList.replaceChildren();
        lapsTitle.textContent = role === 'start' ? 'Pasos registrados (salida)' : 'Tiempos de la ronda';
        const entries = role === 'start' && volatileLaps.length ? volatileLaps : runners.map((runner, index) => {
            const item = [...roundLaps].reverse().find(lap => lap.runnerIndex === index && !lap.invalidated) ||
                roundLaps.find(lap => lap.runnerIndex === index);
            return item || { runnerName: runner.name, runnerIndex: index, time: null };
        });
        for (const item of entries) {
            const li = document.createElement('li');
            const name = document.createElement('span');
            const time = document.createElement('span');
            const method = document.createElement('small');
            name.textContent = `${item.runnerName || currentRunner().name}${item.round ? ` · R${item.round}` : ''}`;
            time.textContent = Number.isFinite(item.time)
                ? `${formatTime(item.time)}${item.invalidated ? ' · INVALIDADO' : item.confirmed === false ? ' · INCOMPLETO' : ''}`
                : '--:--.---';
            method.textContent = Number.isFinite(item.time)
                ? `${item.method === 'automatic' ? 'Automático' : 'Manual'} · ${item.precision || 'precisión de cámara no estimada'}`
                : '';
            method.style.flexBasis = '100%';
            method.style.color = '#cbd5e1';
            method.style.fontSize = '0.72em';
            li.style.flexWrap = 'wrap';
            li.append(name, time, method);
            lapsList.appendChild(li);
        }
    }

    function updateRoleStatus() {
        const runner = currentRunner();
        const roleName = role === 'start' ? 'Salida' : role === 'stop' ? 'Llegada' : 'Modo local';
        const phase = runtime && !stationReady ? ({
            setup: 'Preparación pendiente',
            requesting: 'Activando cámara',
            calibrating: 'Calibrando · deja libre la línea',
            testing: 'Prueba de paso pendiente',
            tested: 'Prueba superada · activa la detección',
            error: 'Cámara no lista · usa modo manual o reintenta',
            interrupted: 'Preparación interrumpida · recupera el cronometraje',
            stopped: 'Prepara el cronometraje'
        }[runtime.state] || 'Preparación pendiente') : null;
        if (phase) statusMessage.textContent = `Ronda ${currentRound} · ${runner.name} · ${roleName} · ${phase}`;
        else if (timerState === 'running') statusMessage.textContent = `${roleName} · ${runner.name} · Cronometrando`;
        else if (timerState === 'paused') statusMessage.textContent = 'Espera entre participantes · mínimo 500 ms y rearme silencioso';
        else statusMessage.textContent = `Ronda ${currentRound} · ${runner.name} · ${roleName} · ${runtimeMethod === 'manual' ? 'Manual listo' : 'Listo'}`;
        if (runtime && typeof runtime.setTriggerLabel === 'function') {
            runtime.setTriggerLabel(timerState === 'running'
                ? (role === 'stop' ? 'Registrar vuelta' : 'Parar')
                : (role === 'start' ? 'Enviar salida' : role === 'stop' ? 'Registrar vuelta' : 'Iniciar'));
        }
    }

    function advanceRunner() {
        preparationGeneration++;
        pendingReadyId = null;
        localReadyConfirmed = false;
        localReadyAt = 0;
        localReadyId = null;
        recoverableAttempt = null;
        activeAttemptId = null;
        activeAttemptReadyId = null;
        activeAttemptMeta = null;
        pendingAttemptId = null;
        pendingAttemptReadyId = null;
        pendingAttemptMeta = null;
        resultRetryPending = false;
        if (currentRunnerIndex + 1 < runners.length) currentRunnerIndex++;
        else {
            recordedLaps.push(...roundLaps);
            roundLaps = [];
            currentRunnerIndex = 0;
            currentRound++;
        }
        saveLaps();
        displayLaps();
        timerState = 'stopped';
        startTime = null;
        lastDisplayedTime = 0;
        $('p2p-retry-result').style.display = 'none';
        if (role === 'start') {
            peerReady = false;
            peerReadyAt = 0;
            peerReadyId = null;
        }
        if (role === 'stop' && dataChannel && dataChannel.readyState === 'open') {
            $('p2p-ready').disabled = false;
            $('p2p-ready').style.display = stationReady && runtime && runtime.armed ? 'block' : 'none';
            p2pStatus(stationReady && runtime && runtime.armed
                ? 'Resultado guardado · confirma llegada para el siguiente participante'
                : 'Resultado guardado · prepara llegada para el siguiente participante');
        }
        updateRoleStatus();
    }

    function appendLap(lap) {
        roundLaps.push(lap);
        if (role === 'start') volatileLaps.push(lap);
        saveLaps();
        displayLaps();
    }

    async function sendPendingResult(lap = pendingResultLap()) {
        if (!lap || lap.invalidated || role !== 'stop' || !sync || !syncConfirmed ||
            !dataChannel || dataChannel.readyState !== 'open' || resultRetryPending) return;
        const generation = rtcGeneration;
        const activeSync = sync;
        const payload = {
            time: lap.time,
            runnerName: lap.runnerName,
            runnerIndex: lap.runnerIndex,
            round: lap.round,
            attemptId: lap.attemptId,
            readyId: lap.readyId,
            method: lap.method,
            uncertainty: lap.uncertainty,
            precision: lap.precision
        };
        resultRetryPending = true;
        $('p2p-retry-result').disabled = true;
        try {
            await activeSync.sendEvent('RESULT', payload);
            if (!isCurrentGeneration(generation) || sync !== activeSync ||
                pendingResultLap() !== lap || lap.invalidated) return;
            lap.confirmed = true;
            saveLaps();
            displayLaps();
            p2pSyncStatus(`Resultado de ${lap.runnerName} confirmado en ambos dispositivos · ${lap.precision}`);
            awaitingResult = false;
            resultRetryPending = false;
            $('p2p-retry-result').style.display = 'none';
            advanceRunner();
        } catch (error) {
            if (!isCurrentGeneration(generation) || sync !== activeSync ||
                pendingResultLap() !== lap || lap.invalidated) return;
            awaitingResult = false;
            resultRetryPending = false;
            timerState = 'paused';
            $('p2p-retry-result').disabled = false;
            $('p2p-retry-result').style.display = 'block';
            p2pSyncStatus(`Resultado pendiente e incompleto; no se avanza participante. Reintenta la confirmación cuando haya conexión. ${error.message}`, 'error');
            saveLaps();
            displayLaps();
        }
    }

    function recordArrival(now, method) {
        if (timerState !== 'running' || startTime === null || awaitingResult) return;
        const attemptId = activeAttemptId;
        const elapsed = Math.max(0, now - startTime);
        const runner = currentRunner();
        const estimate = sync && sync.clockEstimate();
        const result = {
            time: elapsed,
            runnerName: runner.name,
            runnerIndex: currentRunnerIndex,
            round: currentRound,
            attemptId,
            readyId: activeAttemptReadyId,
            method: method === 'automatic' && (role == null || startMethod === 'automatic') ? 'automatic' : 'manual',
            uncertainty: estimate ? estimate.uncertainty : null,
            precision: estimate
                ? `±${estimate.uncertainty.toFixed(1)} ms estimados (RTT/2 + ${estimate.driftAllowance.toFixed(1)} ms de margen de deriva a ${estimate.driftRateMsPerSecond} ms/s; muestra vence a ${estimate.freshnessLimitMs / 1000} s; no es garantía); precisión de cámara no estimada`
                : 'Precisión de cámara no estimada',
            confirmed: false
        };
        appendLap(result);
        lastDisplayedTime = elapsed;
        timerState = 'paused';
        awaitingResult = true;
        updateRoleStatus();
        if (role === 'stop' && sync && dataChannel && dataChannel.readyState === 'open') {
            sendPendingResult(result);
        } else if (role == null) {
            result.confirmed = true;
            saveLaps();
            awaitingResult = false;
            advanceRunner();
        } else {
            result.confirmed = false;
            saveLaps();
            awaitingResult = false;
            p2pSyncStatus('Resultado guardado incompleto; reconecta con salida para confirmar. No se avanza participante.', 'error');
            $('p2p-retry-result').style.display = 'none';
        }
    }

    async function onTrigger({ now, method }) {
        if (!runtime || !runtime.armed || !stationReady) {
            statusMessage.textContent = 'Prepara la cámara, supera la prueba de paso y activa el cronometraje antes de registrar.';
            return;
        }
        if (awaitingResult) {
            statusMessage.textContent = 'Esperando confirmación del resultado anterior.';
            return;
        }
        if (role == null && pendingResultLap()) {
            statusMessage.textContent = 'Hay un resultado remoto incompleto. Reconecta con llegada y reintenta su confirmación antes de continuar en local.';
            return;
        }
        if (role === 'start' && dataChannel && dataChannel.readyState === 'open') {
            if (!peerReady || performance.now() - peerReadyAt >= 30000 || !syncConfirmed || !sync || !sync.synced) {
                p2pSyncStatus('No se inicia: llegada debe confirmar que está lista y la hora debe seguir vigente.');
                return;
            }
            if (timerState === 'running' || timerState === 'paused' || startPending) return;
            const generation = rtcGeneration;
            const activeSync = sync;
            const runner = currentRunner();
            const attemptId = makeIdentity('attempt');
            const readyId = peerReadyId;
            pendingAttemptId = attemptId;
            pendingAttemptReadyId = readyId;
            const event = { runnerIndex: currentRunnerIndex, round: currentRound, runnerName: runner.name, method, attemptId, readyId };
            pendingAttemptMeta = attemptMetadata(event);
            saveLaps();
            startPending = true;
            startCancelled = false;
            statusMessage.textContent = 'Enviando salida; esperando confirmación de llegada…';
            try {
                await activeSync.sendEvent('START', event, now);
                if (!isCurrentGeneration(generation) || sync !== activeSync) return;
                if (pendingAttemptId !== attemptId || currentRunnerIndex !== event.runnerIndex ||
                    currentRound !== event.round) return;
                if (startCancelled) {
                    p2pSyncStatus('La salida se interrumpió durante la confirmación. El intento se mantiene invalidado.');
                    return;
                }
                startTime = now;
                startMethod = method;
                activeAttemptId = attemptId;
                activeAttemptReadyId = readyId;
                activeAttemptMeta = attemptMetadata(event);
                recoverableAttempt = null;
                pendingAttemptMeta = null;
                timerState = 'running';
                saveLaps();
                updateRoleStatus();
                p2pSyncStatus('Salida confirmada por llegada. Reloj de llegada corregido por desfase y demora medidos.');
            } catch (error) {
                if (!isCurrentGeneration(generation) || sync !== activeSync) return;
                const completedResult = findAttemptLap(attemptId);
                if (completedResult && completedResult.confirmed === true && !completedResult.invalidated) return;
                if (!startCancelled) {
                    timerState = 'stopped';
                    startTime = null;
                    peerReady = false;
                    peerReadyAt = 0;
                    peerReadyId = null;
                    try {
                        await activeSync.sendEvent('ABORT', {
                            reason: 'no se confirmó la salida en origen',
                            runnerIndex: currentRunnerIndex,
                            round: currentRound,
                            attemptId,
                            readyId
                        });
                        if (!isCurrentGeneration(generation) || sync !== activeSync) return;
                        pendingAttemptMeta = null;
                        recoverableAttempt = null;
                        saveLaps();
                        p2pSyncStatus(`Salida no confirmada. Llegada recibió la invalidación del intento ${attemptId}. ${error.message}`);
                    } catch (abortError) {
                        if (!isCurrentGeneration(generation) || sync !== activeSync) return;
                        recoverableAttempt = attemptMetadata(event);
                        pendingAttemptMeta = null;
                        saveLaps();
                        p2pSyncStatus(`Salida no confirmada y no se pudo confirmar la invalidación. Llegada pudo haber iniciado el intento; no uses ese resultado. Reconecta y vuelve a confirmar llegada. ${abortError.message}`, 'error');
                    }
                }
            } finally {
                if (isCurrentGeneration(generation)) {
                    startPending = false;
                    startCancelled = false;
                    pendingAttemptId = null;
                    pendingAttemptReadyId = null;
                    pendingAttemptMeta = null;
                }
            }
            return;
        }
        if (role && (!dataChannel || dataChannel.readyState !== 'open')) {
            statusMessage.textContent = 'La sala no está conectada. Elige “Usar solo este dispositivo” para confirmar el modo local.';
            return;
        }
        if (role === 'stop') {
            if (timerState === 'running') recordArrival(now, method);
            else statusMessage.textContent = 'Llegada local: primero debe recibirse una salida sincronizada.';
            return;
        }
        if (timerState === 'running') recordArrival(now, method);
        else {
            startTime = now;
            timerState = 'running';
            updateRoleStatus();
        }
    }

    function onFrame(now) {
        if (timerState === 'running' && startTime !== null) {
            const elapsed = Math.max(0, now - startTime);
            timerDisplay.textContent = formatTime(elapsed);
            timerDisplay.style.color = '#00ffff';
        } else if (timerState !== 'paused') {
            timerDisplay.textContent = formatTime(lastDisplayedTime);
        }
    }

    function abortRun(reason, notifyPeer = true, attemptReadyId = null, recoverable = false, preserveCompletedResult = false) {
        const pendingLap = pendingResultLap();
        const meta = activeAttemptMeta || pendingAttemptMeta || recoverableAttempt ||
            (pendingLap ? attemptMetadata(pendingLap) : null);
        if (preserveCompletedResult && role === 'stop' && pendingLap) {
            timerState = 'paused';
            startTime = null;
            awaitingResult = false;
            statusMessage.textContent = `Preparación interrumpida; el resultado medido de ${pendingLap.runnerName} sigue pendiente de confirmación.`;
            saveLaps();
            return;
        }
        const shouldAbort = timerState === 'running' || startPending || awaitingResult ||
            (recoverable && !!(meta || pendingLap));
        if (shouldAbort) {
            if (startPending) startCancelled = true;
            const attemptId = pendingAttemptId || activeAttemptId || (meta && meta.attemptId);
            const readyId = attemptReadyId || pendingAttemptReadyId || activeAttemptReadyId || (meta && meta.readyId) ||
                (role === 'start' ? peerReadyId : localReadyId);
            if (recoverable && meta) recoverableAttempt = { ...meta };
            else if (!recoverable && recoverableAttempt && recoverableAttempt.attemptId === attemptId) recoverableAttempt = null;
            timerState = recoverable && pendingLap ? 'paused' : 'stopped';
            startTime = null;
            if (!recoverable && (awaitingResult || pendingLap) && attemptId) {
                const lap = findAttemptLap(attemptId);
                if (lap) {
                    lap.confirmed = false;
                    lap.invalidated = true;
                    saveLaps();
                    displayLaps();
                }
                resultRetryPending = false;
                $('p2p-retry-result').disabled = false;
                $('p2p-retry-result').style.display = 'none';
            }
            awaitingResult = false;
            statusMessage.textContent = recoverable && pendingLap
                ? `Conexión interrumpida: el resultado de ${pendingLap.runnerName} sigue pendiente; reconecta para reintentar su confirmación.`
                : `Cronometraje interrumpido: ${reason}. Este intento no se guarda; los resultados anteriores se conservan.`;
            if (notifyPeer && !recoverable && attemptId && readyId && sync && dataChannel && dataChannel.readyState === 'open') {
                sync.sendEvent('ABORT', {
                    reason: String(reason).slice(0, 200),
                    runnerIndex: meta ? meta.runnerIndex : currentRunnerIndex,
                    round: meta ? meta.round : currentRound,
                    attemptId,
                    readyId
                }).catch(() => {});
            }
            activeAttemptId = null;
            activeAttemptReadyId = null;
            activeAttemptMeta = null;
            pendingAttemptId = null;
            pendingAttemptReadyId = null;
            pendingAttemptMeta = null;
            saveLaps();
        }
    }

    function createRuntime() {
        if (!window.PaceTrackTiming || typeof window.PaceTrackTiming.create !== 'function') {
            statusMessage.textContent = 'No se cargó el módulo de cronometraje. El modo local sigue disponible manualmente.';
            return;
        }
        runtime = window.PaceTrackTiming.create({
            mode: 'sector',
            video,
            canvas: overlayCanvas,
            status: statusMessage,
            display: timerDisplay,
            slider: sensitivitySlider,
            mount: $('app-container'),
            onTrigger,
            onFrame,
            onInterrupt: reason => {
                const readyIdToInvalidate = role === 'start' ? peerReadyId : (localReadyId || pendingReadyId);
                const hadActiveAttempt = timerState === 'running' || startPending || awaitingResult;
                preparationGeneration++;
                pendingReadyId = null;
                stationReady = false;
                localReadyConfirmed = false;
                localReadyAt = 0;
                localReadyId = null;
                peerReady = false;
                peerReadyAt = 0;
                peerReadyId = null;
                runtimeMethod = runtime && runtime.method;
                abortRun(reason, true, readyIdToInvalidate, false, true);
                p2pSyncStatus(pendingResultLap()
                    ? 'Preparación interrumpida; el resultado ya medido se conserva. Reintenta su confirmación; no se avanzará hasta tener ACK.'
                    : 'Preparación interrumpida. No se aceptará una salida hasta volver a armar esta estación.', 'error');
                if (role && !hadActiveAttempt && readyIdToInvalidate && sync && dataChannel && dataChannel.readyState === 'open') {
                    sync.sendEvent('UNREADY', {
                        reason: String(reason).slice(0, 160),
                        readyId: readyIdToInvalidate,
                        runnerIndex: currentRunnerIndex,
                        round: currentRound
                    }).catch(() => {});
                }
                $('p2p-ready').style.display = 'none';
                if (role === 'stop' && pendingResultLap() && sync && dataChannel && dataChannel.readyState === 'open') {
                    $('p2p-retry-result').disabled = resultRetryPending;
                    $('p2p-retry-result').style.display = 'block';
                }
                updateRoleStatus();
            },
            onReady: ({ method }) => {
                preparationGeneration++;
                stationReady = !!(runtime && runtime.armed);
                runtimeMethod = method;
                if (role === 'stop') {
                    const oldReadyId = localReadyId || pendingReadyId;
                    localReadyConfirmed = false;
                    localReadyAt = 0;
                    localReadyId = null;
                    pendingReadyId = null;
                    $('p2p-ready').style.display = 'none';
                    if (oldReadyId && sync && dataChannel && dataChannel.readyState === 'open') {
                        sync.sendEvent('UNREADY', {
                            reason: 'llegada volvió a preparar el cronómetro',
                            readyId: oldReadyId,
                            runnerIndex: currentRunnerIndex,
                            round: currentRound
                        }).catch(() => {});
                    }
                } else if (role === 'start') {
                    const oldReadyId = peerReadyId;
                    peerReady = false;
                    peerReadyAt = 0;
                    peerReadyId = null;
                    pendingReadyId = null;
                    if (oldReadyId && sync && dataChannel && dataChannel.readyState === 'open') {
                        sync.sendEvent('UNREADY', {
                            reason: 'salida volvió a preparar el cronómetro',
                            readyId: oldReadyId,
                            runnerIndex: currentRunnerIndex,
                            round: currentRound
                        }).catch(() => {});
                    }
                }
                updateRoleStatus();
                if (role === 'stop' && syncConfirmed && stationReady) {
                    if (pendingResultLap()) {
                        $('p2p-ready').style.display = 'none';
                        $('p2p-retry-result').disabled = false;
                        $('p2p-retry-result').style.display = dataChannel && dataChannel.readyState === 'open' ? 'block' : 'none';
                        p2pSyncStatus('Llegada preparada. Hay un resultado pendiente: reintenta su confirmación sin avanzar participante.', 'pending');
                    } else {
                        $('p2p-ready').disabled = false;
                        $('p2p-ready').style.display = 'block';
                        p2pSyncStatus('Llegada preparada. Confirma aquí que estás listo para esta ronda.');
                    }
                }
            },
            getActivity: () => timerState === 'running' || awaitingResult || startPending,
            hasUnsavedData: () => !!storageFailureMessage &&
                (recordedLaps.length > 0 || roundLaps.length > 0 ||
                    !!activeAttemptMeta || !!pendingAttemptMeta || !!recoverableAttempt)
        });
        runtimeMethod = runtime.method;
    }

    function setupWithNames() {
        if (!canConfigureParticipants()) return;
        $('setup-modal').style.display = 'none';
        $('names-modal').style.display = 'flex';
        const container = $('names-input-container');
        container.replaceChildren();
        const addName = () => {
            const index = container.querySelectorAll('input').length;
            const row = document.createElement('div');
            row.className = 'name-input-group';
            const label = document.createElement('label');
            label.textContent = `Participante ${index + 1}:`;
            const input = document.createElement('input');
            input.type = 'text';
            input.placeholder = 'Nombre (opcional)';
            input.id = `runner-${index}`;
            row.append(label, input);
            container.appendChild(row);
        };
        addName();
        let add = $('add-runner-btn');
        if (!add) {
            add = document.createElement('button');
            add.id = 'add-runner-btn';
            add.type = 'button';
            add.textContent = '+ Agregar participante';
            add.className = 'gradient-blue';
            container.after(add);
        }
        add.onclick = addName;
    }

    function applyRunners(names, destructive = true) {
        if (!canConfigureParticipants()) return false;
        if (destructive && (recordedLaps.length || roundLaps.length) &&
            !confirm('Cambiar la lista de participantes borrará los resultados guardados de esta sesión. ¿Continuar?')) return false;
        runners = names.map((name, index) => ({ id: index + 1, name: String(name).trim() || `Participante ${index + 1}` }));
        currentRunnerIndex = 0;
        currentRound = 1;
        recordedLaps = [];
        roundLaps = [];
        volatileLaps = [];
        saveLaps();
        closeSetup();
        return true;
    }

    function openParticipantConfiguration() {
        if (!canConfigureParticipants()) return;
        $('setup-modal').style.display = 'flex';
    }

    function closeSetup() {
        $('names-modal').style.display = 'none';
        $('excel-modal').style.display = 'none';
        $('setup-modal').style.display = 'none';
        $('app-container').style.display = 'flex';
        if (!runtime) createRuntime();
        createButtons();
        displayLaps();
        updateRoleStatus();
    }

    function setupWithExcel() {
        if (!canConfigureParticipants()) return;
        $('setup-modal').style.display = 'none';
        $('excel-modal').style.display = 'flex';
        $('excel-file').value = '';
        $('excel-preview').style.display = 'none';
        $('names-list').replaceChildren();
    }

    function processExcelFile() {
        if (!canConfigureParticipants()) return;
        const file = $('excel-file').files[0];
        if (!file) return showMessageBox('Selecciona un archivo Excel.');
        if (!window.XLSX) return showMessageBox('La herramienta de lectura Excel no está disponible. Puedes ingresar los nombres manualmente.');
        const reader = new FileReader();
        reader.onload = event => {
            if (!canConfigureParticipants()) {
                window.tempExcelNames = null;
                return;
            }
            try {
                const workbook = XLSX.read(new Uint8Array(event.target.result), { type: 'array' });
                const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1 });
                window.tempExcelNames = rows.map(row => row[0]).filter(name => name != null && String(name).trim()).map(name => String(name).trim());
                if (!window.tempExcelNames.length) return showMessageBox('No se encontraron nombres en la primera columna.');
                const list = $('names-list');
                list.replaceChildren();
                window.tempExcelNames.forEach((name, index) => {
                    const li = document.createElement('li');
                    li.textContent = `${index + 1}. ${name}`;
                    list.appendChild(li);
                });
                $('excel-preview').style.display = 'block';
            } catch (error) {
                showMessageBox(`No se pudo leer el archivo Excel: ${error.message}`);
            }
        };
        reader.onerror = () => showMessageBox('No se pudo leer el archivo seleccionado.');
        reader.readAsArrayBuffer(file);
    }

    function createButtons() {
        if ($('download-pdf')) return;
        const pdfButton = document.createElement('button');
        pdfButton.id = 'download-pdf';
        pdfButton.textContent = 'Descargar PDF';
        pdfButton.className = 'gradient-purple';
        pdfButton.onclick = exportPdf;
        const addButton = document.createElement('button');
        addButton.textContent = '+ Participante';
        addButton.className = 'gradient-green';
        addButton.onclick = () => {
            if (!canConfigureParticipants()) return;
            runners.push({ id: runners.length + 1, name: `Participante ${runners.length + 1}` });
            saveLaps();
            displayLaps();
        };
        const csvButton = document.createElement('button');
        csvButton.id = 'export-csv';
        csvButton.textContent = 'Exportar Excel/CSV';
        csvButton.className = 'gradient-blue';
        csvButton.onclick = exportData;
        const configureButton = document.createElement('button');
        configureButton.id = 'configure-runners';
        configureButton.textContent = 'Configurar participantes';
        configureButton.className = 'gradient-purple';
        configureButton.onclick = openParticipantConfiguration;
        resetButton.after(pdfButton);
        pdfButton.after(csvButton);
        csvButton.after(configureButton);
        configureButton.after(addButton);
    }

    function exportPdf() {
        if (!recordedLaps.length && !roundLaps.length) return showMessageBox('Todavía no hay resultados para exportar.');
        if (!window.jspdf || !window.jspdf.jsPDF) return showMessageBox('PDF no disponible sin conexión. Los resultados siguen guardados en este dispositivo.');
        const { jsPDF } = window.jspdf;
        const doc = new jsPDF();
        doc.setFontSize(18);
        doc.text('REPORTE DE TIEMPOS POR RONDAS', 105, 20, { align: 'center' });
        doc.setFontSize(10);
        doc.text(`Generado: ${new Date().toLocaleDateString()}`, 20, 30);
        const allLaps = [...recordedLaps, ...roundLaps];
        const rounds = new Map();
        allLaps.forEach(lap => {
            const round = lap.round || Math.max(1, Math.floor(allLaps.indexOf(lap) / Math.max(1, runners.length)) + 1);
            if (!rounds.has(round)) rounds.set(round, []);
            rounds.get(round).push(lap);
        });
        let y = 42;
        for (const [round, laps] of rounds) {
            doc.setFontSize(13);
            doc.setTextColor(0, 51, 153);
            doc.text(`Ronda ${round}`, 20, y);
            y += 8;
            doc.setFontSize(10);
            doc.setTextColor(0, 0, 0);
            for (const lap of laps) {
                const detail = `${lap.method || 'manual'} · ${lap.precision || 'precisión no estimada'}${lap.invalidated ? ' · INVALIDADO' : lap.confirmed === false ? ' · INCOMPLETO' : ''}`;
                doc.text(`${lap.runnerName}: ${formatTime(lap.time)} (${detail})`, 25, y);
                y += 6;
                if (y > 275) { doc.addPage(); y = 20; }
            }
            y += 5;
        }
        doc.save(`reporte_rondas_${new Date().toISOString().split('T')[0]}.pdf`);
    }

    function getIceConfiguration() {
        return {
            iceServers: [
                { urls: 'stun:stun.relay.metered.ca:80' },
                { urls: 'turn:global.relay.metered.ca:80', username: 'c1208ba0e8230537122cf693', credential: 'U4ffWBruWxpMqEir' },
                { urls: 'turn:global.relay.metered.ca:80?transport=tcp', username: 'c1208ba0e8230537122cf693', credential: 'U4ffWBruWxpMqEir' },
                { urls: 'turn:global.relay.metered.ca:443', username: 'c1208ba0e8230537122cf693', credential: 'U4ffWBruWxpMqEir' },
                { urls: 'turns:global.relay.metered.ca:443?transport=tcp', username: 'c1208ba0e8230537122cf693', credential: 'U4ffWBruWxpMqEir' }
            ],
            iceCandidatePoolSize: 10
        };
    }

    function stopListeners() {
        for (const [ref, event, callback] of listeners) ref.off(event, callback);
        listeners = [];
    }

    function cleanupRTC({ keepRole = false, message = 'Modo local · este dispositivo' } = {}) {
        const oldRole = role;
        const oldRoomRef = roomRef;
        const oldSessionId = sessionId;
        rtcGeneration++;
        preparationGeneration++;
        pendingReadyId = null;
        if (awaitingResult) {
            awaitingResult = false;
            timerState = 'paused';
        }
        clearTimeout(connectionTimer);
        clearTimeout(disconnectTimer);
        clearInterval(clockTimer);
        clearInterval(readinessTimer);
        connectionTimer = disconnectTimer = null;
        clockTimer = readinessTimer = null;
        clockRefreshPending = false;
        stopListeners();
        if (sync) sync.close();
        sync = null;
        syncConfirmed = false;
        peerReady = false;
        peerReadyAt = 0;
        peerReadyId = null;
        localReadyConfirmed = false;
        localReadyAt = 0;
        localReadyId = null;
        rejectedStartAttempts.clear();
        startPending = false;
        startCancelled = true;
        pendingAttemptId = null;
        pendingAttemptReadyId = null;
        pendingAttemptMeta = null;
        activeAttemptId = null;
        activeAttemptReadyId = null;
        activeAttemptMeta = null;
        awaitingResult = false;
        resultRetryPending = false;
        timerState = 'stopped';
        startTime = null;
        candidateQueue = [];
        if (dataChannel) {
            dataChannel.onopen = dataChannel.onclose = dataChannel.onerror = dataChannel.onmessage = null;
            try { dataChannel.close(); } catch (_) {}
        }
        dataChannel = null;
        if (pc) {
            pc.onicecandidate = pc.ondatachannel = pc.onconnectionstatechange = pc.oniceconnectionstatechange = null;
            try { pc.close(); } catch (_) {}
        }
        pc = null;
        roomRef = null;
        if (!keepRole) role = null;
        if (oldRole === 'start') removeOwnedRoom(oldRoomRef, oldSessionId);
        $('p2p-ready').style.display = 'none';
        $('p2p-retry-result').style.display = 'none';
        $('p2p-retry-result').disabled = false;
        $('p2p-create').disabled = false;
        $('p2p-join').disabled = false;
        p2pStatus(message);
        displayLaps();
    }

    function remoteDescriptionSet(operationPc, generation) {
        if (!isCurrentGeneration(generation) || pc !== operationPc || !operationPc.remoteDescription) return;
        const pending = candidateQueue;
        candidateQueue = [];
        pending.forEach(candidate => operationPc.addIceCandidate(new RTCIceCandidate(candidate)).catch(error => {
            if (isCurrentGeneration(generation)) p2pSyncStatus(`No se pudo completar la conexión. Reintenta la sala: ${error.message}`);
        }));
    }

    async function addRemoteCandidate(candidate, operationPc, generation) {
        if (!isCurrentGeneration(generation) || pc !== operationPc || !operationPc) return;
        if (!operationPc.remoteDescription) {
            candidateQueue.push(candidate);
            return;
        }
        try { await operationPc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (error) { if (isCurrentGeneration(generation)) p2pSyncStatus(`Error al establecer la conexión. Puedes reintentar: ${error.message}`); }
    }

    function connectionChanged(generation, operationPc) {
        if (!isCurrentGeneration(generation) || pc !== operationPc || !operationPc) return;
        const state = ['failed', 'closed', 'disconnected'].includes(operationPc.connectionState)
            ? operationPc.connectionState : operationPc.iceConnectionState || operationPc.connectionState;
        if (state === 'connected' || state === 'completed') {
            clearTimeout(connectionTimer);
            clearTimeout(disconnectTimer);
            p2pStatus(`Conectados · ${role === 'start' ? 'salida' : 'llegada'}`);
            p2pSyncStatus('Midiendo diferencia entre relojes. Aún no se puede iniciar.');
            return;
        }
        if (state === 'failed' || state === 'closed') {
            abortRun('se perdió la conexión entre dispositivos', false, null, true);
            cleanupRTC({ keepRole: true, message: 'Conexión interrumpida · puedes volver a enlazar' });
            p2pSyncStatus('No se aceptan tiempos hasta volver a conectar y confirmar la sincronización.');
            return;
        }
        if (state === 'disconnected') {
            if (!disconnectTimer) disconnectTimer = setTimeout(() => {
                if (isCurrentGeneration(generation) && pc === operationPc &&
                    (operationPc.connectionState === 'disconnected' || operationPc.iceConnectionState === 'disconnected')) {
                    abortRun('se perdió la conexión entre dispositivos', false, null, true);
                    cleanupRTC({ keepRole: true, message: 'Conexión interrumpida · puedes volver a enlazar' });
                }
            }, 5000);
        }
    }

    async function publishCandidate(target, candidate, generation) {
        if (!isCurrentGeneration(generation)) return;
        const candidateRef = target.push();
        try {
            await candidateRef.set(candidate);
            if (!isCurrentGeneration(generation)) await candidateRef.remove();
        } catch (error) {
            if (isCurrentGeneration(generation)) p2pSyncStatus(`No se pudo enviar información de conexión: ${error.message}`);
        }
    }

    function validIncomingEvent(message) {
        const eventLocalTime = sync && sync.toLocalTime(message.sentAt);
        const eventIsRecent = eventLocalTime !== null &&
            performance.now() - eventLocalTime >= -100 && performance.now() - eventLocalTime < 30000;
        if (message.kind === 'READY') {
            const p = message.payload;
            return role === 'start' && !!(runtime && runtime.armed && stationReady) && !!sync?.clockEstimate() &&
                eventIsRecent &&
                typeof p.readyId === 'string' && p.readyId.length <= 200 &&
                p.runnerIndex === currentRunnerIndex && p.round === currentRound &&
                p.runnerName === currentRunner().name && ['manual', 'automatic'].includes(p.method);
        }
        if (message.kind === 'START') {
            const p = message.payload;
            return role === 'stop' && !!(runtime && runtime.armed && stationReady && localReadyConfirmed &&
                performance.now() - localReadyAt < 30000) &&
                !!sync?.clockEstimate() && eventIsRecent &&
                p.runnerIndex === currentRunnerIndex && p.round === currentRound &&
                p.runnerName === currentRunner().name && p.readyId === localReadyId &&
                ['manual', 'automatic'].includes(p.method) &&
                typeof p.attemptId === 'string' && p.attemptId.length <= 200 &&
                timerState !== 'running' && timerState !== 'paused' && !awaitingResult;
        }
        if (message.kind === 'RESULT') {
            const p = message.payload;
            if (role !== 'start' || !sync?.clockEstimate() || !eventIsRecent ||
                !Number.isFinite(p.time) || p.time < 0 || p.time >= 24 * 60 * 60 * 1000 ||
                !['manual', 'automatic'].includes(p.method) ||
                typeof p.runnerName !== 'string' || p.runnerName.length > 120) return false;
            const existing = findAttemptLap(p.attemptId);
            if (existing) return existing.confirmed === true && !existing.invalidated && resultMatchesLap(existing, p);
            const acceptedAttempt = activeAttemptMeta || pendingAttemptMeta || recoverableAttempt;
            return !!acceptedAttempt && p.attemptId === acceptedAttempt.attemptId &&
                p.readyId === acceptedAttempt.readyId && p.runnerIndex === acceptedAttempt.runnerIndex &&
                p.round === acceptedAttempt.round && p.runnerName === acceptedAttempt.runnerName;
        }
        if (message.kind === 'UNREADY') {
            const p = message.payload;
            const expectedReadyId = role === 'start' ? peerReadyId : (localReadyId || pendingReadyId);
            return !!role && !!expectedReadyId && p.readyId === expectedReadyId &&
                p.runnerIndex === currentRunnerIndex && p.round === currentRound;
        }
        if (message.kind === 'ABORT') {
            const p = message.payload;
            const matchesActive = p.attemptId === activeAttemptId && p.readyId === activeAttemptReadyId;
            const matchesPending = p.attemptId === pendingAttemptId && p.readyId === pendingAttemptReadyId;
            const matchesRecoverable = recoverableAttempt && p.attemptId === recoverableAttempt.attemptId &&
                p.readyId === recoverableAttempt.readyId && p.runnerIndex === recoverableAttempt.runnerIndex &&
                p.round === recoverableAttempt.round;
            const rejectedStart = rejectedStartAttempts.get(p.attemptId);
            const matchesRejected = rejectedStart && rejectedStart.readyId === p.readyId &&
                rejectedStart.runnerIndex === p.runnerIndex && rejectedStart.round === p.round &&
                performance.now() - rejectedStart.at < 30000;
            const incompleteLap = role === 'stop' && findAttemptLap(p.attemptId);
            const matchesIncompleteLap = incompleteLap && incompleteLap.confirmed === false &&
                incompleteLap.readyId === p.readyId && incompleteLap.runnerIndex === p.runnerIndex &&
                incompleteLap.round === p.round;
            return !!role && typeof p.attemptId === 'string' && typeof p.readyId === 'string' &&
                ((matchesActive || matchesPending) && p.runnerIndex === currentRunnerIndex && p.round === currentRound ||
                    matchesRecoverable || matchesRejected || matchesIncompleteLap);
        }
        return false;
    }

    function processIncomingEvent(message) {
        if (!message.timingReliable && message.kind === 'START') {
            p2pSyncStatus('Salida descartada: no existe una estimación horaria reciente.');
            return;
        }
        if (message.kind === 'READY') {
            if (role === 'start' && recoverableAttempt) {
                const abandoned = { ...recoverableAttempt };
                recoverableAttempt = null;
                saveLaps();
                if (sync && dataChannel && dataChannel.readyState === 'open') {
                    sync.sendEvent('ABORT', {
                        ...abandoned,
                        reason: 'llegada confirma una nueva preparación; intento interrumpido anterior descartado'
                    }).catch(error => {
                        if (isCurrentGeneration(rtcGeneration)) {
                            p2pSyncStatus(`Intento interrumpido anterior no pudo reconciliarse: ${error.message}`, 'error');
                        }
                    });
                }
            }
            peerReady = true;
            peerReadyAt = performance.now();
            peerReadyId = message.payload.readyId;
            syncConfirmed = true;
            p2pSyncStatus('Llegada confirmó que está lista. La salida ya puede iniciar cuando su control esté armado.');
        } else if (message.kind === 'UNREADY') {
            if (role === 'start') {
                peerReady = false;
                peerReadyAt = 0;
                peerReadyId = null;
            }
            if (role === 'stop') {
                preparationGeneration++;
                pendingReadyId = null;
                localReadyConfirmed = false;
                localReadyAt = 0;
                localReadyId = null;
                $('p2p-ready').disabled = false;
                $('p2p-ready').style.display = stationReady && runtime && runtime.armed && !pendingResultLap() ? 'block' : 'none';
            }
            p2pSyncStatus('La preparación de una estación se interrumpió. Repite prueba y confirmación antes de otra salida.');
        } else if (message.kind === 'START') {
            localReadyConfirmed = false;
            localReadyAt = 0;
            activeAttemptId = message.payload.attemptId;
            activeAttemptReadyId = message.payload.readyId;
            activeAttemptMeta = attemptMetadata(message.payload);
            recoverableAttempt = null;
            startTime = message.convertedAt;
            startMethod = message.payload.method === 'automatic' ? 'automatic' : 'manual';
            timerState = 'running';
            saveLaps();
            updateRoleStatus();
            p2pSyncStatus(`Salida confirmada · diferencia de reloj estimada ±${message.uncertainty.toFixed(1)} ms (RTT/2 + margen de deriva; referencia vence a los 30 s; no es garantía de precisión).`);
        } else if (message.kind === 'RESULT') {
            const existing = findAttemptLap(message.payload.attemptId);
            if (existing) {
                p2pSyncStatus(`Reintento de resultado ya confirmado; no se duplica ni avanza otra vez.`);
                return;
            }
            const result = { ...message.payload, confirmed: true, method: message.payload.method === 'automatic' ? 'automatic' : 'manual' };
            appendLap(result);
            lastDisplayedTime = result.time;
            p2pSyncStatus(`Resultado confirmado · ${result.method} · ${result.precision || 'precisión no estimada'}`);
            advanceRunner();
        } else if (message.kind === 'ABORT') {
            const p = message.payload;
            const lap = findAttemptLap(p.attemptId);
            if (lap && lap.confirmed === false && lap.readyId === p.readyId) {
                lap.invalidated = true;
                resultRetryPending = false;
                $('p2p-retry-result').disabled = false;
                $('p2p-retry-result').style.display = 'none';
                saveLaps();
                displayLaps();
            }
            const matchesCurrentAttempt = (p.attemptId === activeAttemptId && p.readyId === activeAttemptReadyId) ||
                (p.attemptId === pendingAttemptId && p.readyId === pendingAttemptReadyId);
            if (matchesCurrentAttempt) {
                if (role === 'stop') {
                    timerState = 'stopped';
                    startTime = null;
                    awaitingResult = false;
                    statusMessage.textContent = 'Intento cancelado por la estación de salida; el tiempo no se confirma.';
                } else {
                    abortRun('la otra estación interrumpió el intento', false, p.readyId);
                }
                activeAttemptId = null;
                activeAttemptReadyId = null;
                activeAttemptMeta = null;
            }
            if (recoverableAttempt && p.attemptId === recoverableAttempt.attemptId &&
                p.readyId === recoverableAttempt.readyId) {
                recoverableAttempt = null;
                saveLaps();
            }
            if (role === 'start' && p.readyId === peerReadyId) {
                peerReady = false;
                peerReadyAt = 0;
                peerReadyId = null;
            }
            if (role === 'stop' && p.readyId === localReadyId) {
                preparationGeneration++;
                pendingReadyId = null;
                localReadyConfirmed = false;
                localReadyAt = 0;
                localReadyId = null;
                $('p2p-ready').disabled = false;
                $('p2p-ready').style.display = stationReady && runtime && runtime.armed && !pendingResultLap() ? 'block' : 'none';
            }
            saveLaps();
            p2pSyncStatus('Intento invalidado mediante ABORT; no debe usarse como resultado confirmado.', 'error');
        }
    }

    function expireReadiness() {
        const now = performance.now();
        if (role === 'start' && peerReady && now - peerReadyAt >= 30000) {
            peerReady = false;
            peerReadyAt = 0;
            p2pSyncStatus('La confirmación de llegada venció. Pide que llegada vuelva a confirmar antes de iniciar.', 'pending');
        }
        if (role === 'stop' && localReadyConfirmed && now - localReadyAt >= 30000) {
            localReadyConfirmed = false;
            localReadyAt = 0;
            $('p2p-ready').disabled = false;
            $('p2p-ready').style.display = stationReady && runtime && runtime.armed && !pendingResultLap() ? 'block' : 'none';
            p2pSyncStatus('La confirmación de llegada venció. Vuelve a confirmar que estás listo.', 'pending');
        }
    }

    async function refreshClock(generation = rtcGeneration) {
        if (!isCurrentGeneration(generation)) return;
        if (clockRefreshPending || !sync || !dataChannel || dataChannel.readyState !== 'open') return;
        const activeSync = sync;
        const wasFresh = activeSync.synced;
        clockRefreshPending = true;
        try {
            await activeSync.measureClock(5);
            if (activeSync !== sync) return;
            syncConfirmed = true;
            expireReadiness();
            if (!wasFresh) {
                p2pSyncStatus('La referencia horaria se renovó. Confirma de nuevo la disponibilidad de llegada.', 'pending');
            }
        } catch (error) {
            if (activeSync === sync) {
                if (!activeSync.synced) {
                    syncConfirmed = false;
                    $('p2p-create').disabled = $('p2p-join').disabled = false;
                }
                p2pSyncStatus(`No se pudo renovar la referencia horaria. No inicies hasta que vuelva a estar vigente: ${error.message}`, 'error');
            }
        } finally {
            if (isCurrentGeneration(generation)) clockRefreshPending = false;
        }
    }

    function setupDataChannelEvents(channel, generation) {
        channel.onopen = async () => {
            if (!isCurrentGeneration(generation) || dataChannel !== channel) return;
            clearTimeout(connectionTimer);
            const activeSession = sessionId;
            if (!window.SectorSync) {
                p2pSyncStatus('No está disponible el módulo de sincronización. Usa el modo local o recarga la página.', 'error');
                $('p2p-create').disabled = $('p2p-join').disabled = false;
                return;
            }
            const channelSync = new window.SectorSync({
                sessionId: activeSession,
                transport: raw => {
                    if (!isCurrentGeneration(generation) || dataChannel !== channel || channel.readyState !== 'open') {
                        throw new Error('La conexión ya no está disponible');
                    }
                    channel.send(raw);
                },
                validateEvent: message => isCurrentGeneration(generation) && sync === channelSync && validIncomingEvent(message),
                onEvent: message => {
                    if (isCurrentGeneration(generation) && sync === channelSync) processIncomingEvent(message);
                },
                onRejected: message => {
                    if (!isCurrentGeneration(generation) || sync !== channelSync) return;
                    if (message.kind === 'READY') p2pSyncStatus('Llegada no coincide con participante o ronda. Comprueba que ambas listas estén iguales.');
                    else if (message.kind === 'START') {
                        rememberRejectedStart(message);
                        p2pSyncStatus('Salida descartada: no coincide participante/ronda o la señal llegó fuera de tiempo.');
                    }
                    else if (message.kind === 'RESULT') p2pSyncStatus('Resultado descartado: no coincide participante/ronda o se perdió la referencia horaria.');
                },
                onFailure: () => {
                    if (isCurrentGeneration(generation) && sync === channelSync) {
                        p2pSyncStatus('No llegó confirmación. Los eventos incompletos no avanzan al siguiente participante; revisa el estado y reintenta cuando haya conexión.', 'error');
                    }
                }
            });
            sync = channelSync;
            p2pStatus(`Dispositivos conectados · ${role === 'start' ? 'salida' : 'llegada'}`);
            try {
                const estimate = await channelSync.measureClock(5);
                if (!isCurrentGeneration(generation) || sync !== channelSync || activeSession !== sessionId) return;
                syncConfirmed = true;
                p2pSyncStatus(`Hora comprobada con 5 muestras · RTT ${estimate.rtt.toFixed(1)} ms; incertidumbre orientativa ±${estimate.uncertainty.toFixed(1)} ms (RTT/2 + ${estimate.driftAllowance.toFixed(1)} ms de deriva a ${estimate.driftRateMsPerSecond} ms/s; muestra vence a ${estimate.freshnessLimitMs / 1000} s; no es garantía de precisión).`);
                if (role === 'stop' && stationReady && runtime && runtime.armed) {
                    if (pendingResultLap()) {
                        $('p2p-ready').style.display = 'none';
                        $('p2p-retry-result').disabled = false;
                        $('p2p-retry-result').style.display = 'block';
                        p2pSyncStatus('Hay un resultado remoto pendiente. Reintenta su confirmación antes de preparar otra salida.', 'pending');
                    } else {
                        $('p2p-ready').disabled = false;
                        $('p2p-ready').style.display = 'block';
                        p2pSyncStatus('Hora comprobada. Llegada está preparada; confirma que está lista para esta ronda.');
                    }
                } else if (role === 'stop') {
                    $('p2p-ready').style.display = 'none';
                    p2pSyncStatus('Hora comprobada. Llegada debe terminar su prueba de paso y activar el cronometraje antes de confirmar.');
                }
                clockTimer = setInterval(() => {
                    if (isCurrentGeneration(generation)) refreshClock(generation);
                }, 15000);
                readinessTimer = setInterval(() => {
                    if (isCurrentGeneration(generation)) expireReadiness();
                }, 1000);
            } catch (error) {
                if (!isCurrentGeneration(generation) || sync !== channelSync) return;
                $('p2p-create').disabled = $('p2p-join').disabled = false;
                p2pSyncStatus(`No se pudo comprobar la hora. Reintenta la conexión: ${error.message}`);
            }
        };
        channel.onclose = () => {
            if (!isCurrentGeneration(generation) || dataChannel !== channel) return;
            abortRun('se cerró la conexión', false, null, true);
            cleanupRTC({ keepRole: true, message: 'Conexión cerrada · puedes volver a enlazar' });
        };
        channel.onerror = () => {
            if (!isCurrentGeneration(generation) || dataChannel !== channel) return;
            $('p2p-create').disabled = $('p2p-join').disabled = false;
            p2pSyncStatus('La conexión tuvo un problema. No se confirman nuevos tiempos; puedes volver a enlazar.');
        };
        channel.onmessage = event => {
            if (isCurrentGeneration(generation) && dataChannel === channel && sync) {
                let message;
                try { message = JSON.parse(event.data); } catch (_) {}
                const activeSync = sync;
                if (!activeSync.receive(event.data) && (!message || message.type !== 'event') &&
                    isCurrentGeneration(generation) && sync === activeSync) {
                    p2pSyncStatus('Se descartó un mensaje inválido o de sesión anterior.');
                }
            }
        };
    }

    async function createRoom(roomId) {
        if (!firebaseAvailable()) return;
        if ((timerState === 'running' || awaitingResult) &&
            !confirm('Crear una nueva sala interrumpirá el intento actual. ¿Continuar?')) return;
        abortRun('se cambió la conexión', false, null, true);
        cleanupRTC();
        role = 'start';
        displayLaps();
        updateRoleStatus();
        const generation = rtcGeneration;
        const newSession = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
        sessionId = newSession;
        const operationRoomRef = db.ref(`rooms/${roomId}`);
        roomRef = operationRoomRef;
        p2pStatus('Creando sala…');
        $('p2p-create').disabled = $('p2p-join').disabled = true;
        let claimed = false;
        try {
            const created = await operationRoomRef.child('sessionId').transaction(value => value == null ? newSession : undefined);
            claimed = created.committed;
            if (!isCurrentGeneration(generation)) {
                if (claimed) await removeOwnedRoom(operationRoomRef, newSession);
                return;
            }
            if (!created.committed) throw new Error('Ese código ya está en uso. Elige otro código para una sala nueva.');
            const operationPc = new RTCPeerConnection(getIceConfiguration());
            pc = operationPc;
            const channel = operationPc.createDataChannel('pacetrack-timing-v1');
            dataChannel = channel;
            setupDataChannelEvents(channel, generation);
            operationPc.onicecandidate = event => {
                if (isCurrentGeneration(generation) && pc === operationPc && event.candidate) {
                    publishCandidate(operationRoomRef.child('hostCandidates'), event.candidate.toJSON(), generation);
                }
            };
            operationPc.onconnectionstatechange = operationPc.oniceconnectionstatechange =
                () => connectionChanged(generation, operationPc);
            const offer = await operationPc.createOffer();
            if (!isCurrentGeneration(generation) || pc !== operationPc) return;
            await operationPc.setLocalDescription(offer);
            if (!isCurrentGeneration(generation) || pc !== operationPc) return;
            const offerDescription = {
                type: operationPc.localDescription.type,
                sdp: operationPc.localDescription.sdp
            };
            await operationRoomRef.child('offer').set(offerDescription);
            if (!isCurrentGeneration(generation) || pc !== operationPc) {
                await removeOwnedRoom(operationRoomRef, newSession);
                return;
            }
            const answerListener = snapshot => {
                if (!isCurrentGeneration(generation) || pc !== operationPc) return;
                if (snapshot.exists() && !operationPc.remoteDescription) {
                    operationPc.setRemoteDescription(new RTCSessionDescription(snapshot.val()))
                        .then(() => remoteDescriptionSet(operationPc, generation))
                        .catch(error => {
                            if (isCurrentGeneration(generation)) p2pSyncStatus(`No se pudo aceptar la llegada: ${error.message}`);
                        });
                }
            };
            operationRoomRef.child('answer').on('value', answerListener);
            listeners.push([operationRoomRef.child('answer'), 'value', answerListener]);
            const candidatesRef = operationRoomRef.child('guestCandidates');
            const candidatesListener = snapshot => addRemoteCandidate(snapshot.val(), operationPc, generation);
            candidatesRef.on('child_added', candidatesListener);
            listeners.push([candidatesRef, 'child_added', candidatesListener]);
            p2pStatus(`Sala ${roomId} creada · comparte el código con llegada`);
            p2pSyncStatus('Esperando a que la llegada entre en esta sala…');
            connectionTimer = setTimeout(() => {
                if (isCurrentGeneration(generation) && pc === operationPc && operationPc.connectionState !== 'connected') {
                    cleanupRTC({ keepRole: true, message: 'La sala no conectó a tiempo · revisa el código y reintenta' });
                    p2pSyncStatus('Puedes intentar otra vez o pasar explícitamente al modo local.');
                }
            }, 45000);
        } catch (error) {
            if (!isCurrentGeneration(generation)) {
                if (claimed) await removeOwnedRoom(operationRoomRef, newSession);
                return;
            }
            cleanupRTC({ message: 'No se pudo crear la sala' });
            p2pSyncStatus(`${error.message} Comprueba la conexión e inténtalo de nuevo.`);
        }
    }

    async function joinRoom(roomId) {
        if (!firebaseAvailable()) return;
        if ((timerState === 'running' || awaitingResult) &&
            !confirm('Entrar en otra sala interrumpirá el intento actual. ¿Continuar?')) return;
        abortRun('se cambió la conexión', false, null, true);
        cleanupRTC();
        role = 'stop';
        displayLaps();
        updateRoleStatus();
        const generation = rtcGeneration;
        $('p2p-create').disabled = $('p2p-join').disabled = true;
        p2pStatus('Buscando sala…');
        const operationRoomRef = db.ref(`rooms/${roomId}`);
        roomRef = operationRoomRef;
        let joinedSession = null;
        let savedAnswer = null;
        try {
            const snapshot = await operationRoomRef.once('value');
            if (!isCurrentGeneration(generation)) return;
            if (!snapshot.exists() || !snapshot.val().offer || !snapshot.val().sessionId) {
                throw new Error('No encontramos una salida activa con ese código. Comprueba el código e inténtalo otra vez.');
            }
            joinedSession = snapshot.val().sessionId;
            sessionId = joinedSession;
            const operationPc = new RTCPeerConnection(getIceConfiguration());
            pc = operationPc;
            operationPc.ondatachannel = event => {
                if (!isCurrentGeneration(generation) || pc !== operationPc) return;
                dataChannel = event.channel;
                setupDataChannelEvents(event.channel, generation);
            };
            operationPc.onicecandidate = event => {
                if (isCurrentGeneration(generation) && pc === operationPc && event.candidate) {
                    publishCandidate(operationRoomRef.child('guestCandidates'), event.candidate.toJSON(), generation);
                }
            };
            operationPc.onconnectionstatechange = operationPc.oniceconnectionstatechange =
                () => connectionChanged(generation, operationPc);
            await operationPc.setRemoteDescription(new RTCSessionDescription(snapshot.val().offer));
            if (!isCurrentGeneration(generation) || pc !== operationPc) return;
            remoteDescriptionSet(operationPc, generation);
            const answer = await operationPc.createAnswer();
            if (!isCurrentGeneration(generation) || pc !== operationPc) return;
            await operationPc.setLocalDescription(answer);
            if (!isCurrentGeneration(generation) || pc !== operationPc) return;
            savedAnswer = {
                type: operationPc.localDescription.type,
                sdp: operationPc.localDescription.sdp
            };
            await operationRoomRef.child('answer').set(savedAnswer);
            if (!isCurrentGeneration(generation) || pc !== operationPc) {
                await removeAnswerIfMatches(operationRoomRef, joinedSession, savedAnswer);
                return;
            }
            const candidatesRef = operationRoomRef.child('hostCandidates');
            const candidatesListener = candidate => addRemoteCandidate(candidate.val(), operationPc, generation);
            candidatesRef.on('child_added', candidatesListener);
            listeners.push([candidatesRef, 'child_added', candidatesListener]);
            p2pStatus(`Entrando en sala ${roomId} como llegada…`);
            p2pSyncStatus('Esperando conexión con salida…');
            connectionTimer = setTimeout(() => {
                if (isCurrentGeneration(generation) && pc === operationPc && operationPc.connectionState !== 'connected') {
                    cleanupRTC({ keepRole: true, message: 'No se pudo conectar a tiempo · revisa el código e inténtalo de nuevo' });
                    p2pSyncStatus('Puedes intentar otra vez o pasar explícitamente al modo local.');
                }
            }, 45000);
        } catch (error) {
            if (!isCurrentGeneration(generation)) {
                if (savedAnswer && joinedSession) await removeAnswerIfMatches(operationRoomRef, joinedSession, savedAnswer);
                return;
            }
            cleanupRTC({ message: 'No se pudo entrar en la sala' });
            p2pSyncStatus(`${error.message} La cámara y el cronometraje local siguen disponibles.`);
        }
    }

    function firebaseAvailable() {
        if (!window.firebase || !firebase.apps || !firebase.database || typeof RTCPeerConnection === 'undefined') {
            p2pStatus('Sin sincronización · modo local disponible');
            p2pSyncStatus('Firebase o la conexión entre dispositivos no está disponible en este navegador. Usa el modo manual o activa cámara desde Preparar.');
            return false;
        }
        try {
            if (!firebase.apps.length) firebase.initializeApp(firebaseConfig);
            db = firebase.database();
            return true;
        } catch (error) {
            p2pStatus('No se pudo iniciar la sincronización · modo local disponible');
            p2pSyncStatus(`Error de Firebase: ${error.message}`);
            return false;
        }
    }

    function validRoomCode(code) {
        return /^[\p{L}\p{N}_-]{3,32}$/u.test(code);
    }

    function exportData() {
        const data = [...recordedLaps, ...roundLaps];
        const csv = ['Ronda,Participante,Tiempo ms,Método,Incertidumbre estimada ms (RTT/2 + margen deriva; no garantía),Confirmado', ...data.map(lap =>
            [lap.round || currentRound, `"${String(lap.runnerName || '').replaceAll('"', '""')}"`, lap.time,
                lap.method || 'manual', lap.uncertainty ?? '', lap.invalidated ? 'invalidado' : lap.confirmed !== false ? 'sí' : 'no'].join(','))].join('\n');
        const link = document.createElement('a');
        link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
        link.download = 'pacetrack-sector.csv';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 1000);
    }

    function resetSession() {
        const hasResults = recordedLaps.length > 0 || roundLaps.length > 0;
        if (!confirm(hasResults
            ? '¿Borrar participantes, vuelta actual y todos los resultados guardados? Esta acción no se puede deshacer.'
            : '¿Reiniciar esta sesión?')) return;
        cleanupRTC();
        if (runtime) runtime.stop();
        try { Object.values(LS_KEYS).forEach(key => localStorage.removeItem(key)); }
        catch (error) { showMessageBox(`No se pudo borrar el guardado: ${error.message}`); return; }
        location.reload();
    }

    $('setup-with-names').onclick = setupWithNames;
    $('setup-without-names').onclick = () => {
        if (!canConfigureParticipants()) return;
        applyRunners(['Corredor 1']);
    };
    $('setup-with-excel').onclick = setupWithExcel;
    $('save-names').onclick = () => {
        if (!canConfigureParticipants()) return;
        applyRunners([...$('names-input-container').querySelectorAll('input')].map(input => input.value));
    };
    $('cancel-names').onclick = () => { $('names-modal').style.display = 'none'; $('setup-modal').style.display = 'flex'; };
    $('process-excel').onclick = () => {
        if (!canConfigureParticipants()) return;
        if (!window.tempExcelNames) return processExcelFile();
        applyRunners(window.tempExcelNames);
        window.tempExcelNames = null;
    };
    $('excel-file').addEventListener('change', processExcelFile);
    $('cancel-excel').onclick = () => { $('excel-modal').style.display = 'none'; $('setup-modal').style.display = 'flex'; window.tempExcelNames = null; };
    messageBoxOkButton.onclick = () => { messageBox.style.display = 'none'; };
    resetButton.onclick = resetSession;
    $('p2p-create').onclick = () => {
        const code = $('p2p-room-id').value.trim();
        if (!validRoomCode(code)) return p2pSyncStatus('Usa un código de 3 a 32 letras, números, guion o guion bajo; compártelo con llegada.');
        createRoom(code);
    };
    $('p2p-join').onclick = () => {
        const code = $('p2p-room-id').value.trim();
        if (!validRoomCode(code)) return p2pSyncStatus('Escribe el código de 3 a 32 letras, números, guion o guion bajo que te compartió salida.');
        joinRoom(code);
    };
    $('p2p-ready').onclick = async () => {
        if (!sync || !syncConfirmed) return p2pSyncStatus('Espera a que termine la comprobación de hora.');
        if (pendingResultLap()) {
            $('p2p-ready').style.display = 'none';
            $('p2p-retry-result').style.display = 'block';
            return p2pSyncStatus('Confirma el resultado pendiente antes de preparar otra salida.', 'pending');
        }
        if (!runtime || !runtime.armed || !stationReady) {
            $('p2p-ready').style.display = 'none';
            return p2pSyncStatus('Llegada debe completar la preparación, calibración y prueba antes de confirmar que está lista.');
        }
        const generation = rtcGeneration;
        const activeSync = sync;
        const readyId = makeIdentity('ready');
        const readyGeneration = preparationGeneration;
        pendingReadyId = readyId;
        $('p2p-ready').disabled = true;
        try {
            await activeSync.sendEvent('READY', {
                runnerIndex: currentRunnerIndex,
                round: currentRound,
                runnerName: currentRunner().name,
                method: runtimeMethod,
                readyId
            });
            if (!isCurrentGeneration(generation) || sync !== activeSync ||
                readyGeneration !== preparationGeneration || pendingReadyId !== readyId) return;
            if (!runtime || !runtime.armed || !stationReady) {
                pendingReadyId = null;
                $('p2p-ready').disabled = false;
                try {
                    await activeSync.sendEvent('UNREADY', {
                        reason: 'preparación dejó de estar lista durante la confirmación',
                        readyId,
                        runnerIndex: currentRunnerIndex,
                        round: currentRound
                    });
                } catch (error) {
                    p2pSyncStatus(`Preparación no confirmada y no se pudo invalidar el READY pendiente: ${error.message}`, 'error');
                }
                return;
            }
            localReadyConfirmed = true;
            localReadyAt = performance.now();
            localReadyId = readyId;
            pendingReadyId = null;
            p2pSyncStatus('Confirmaste que llegada está lista. La salida ya puede iniciar.');
            $('p2p-ready').style.display = 'none';
        } catch (error) {
            if (!isCurrentGeneration(generation) || sync !== activeSync ||
                readyGeneration !== preparationGeneration || pendingReadyId !== readyId) return;
            pendingReadyId = null;
            $('p2p-ready').disabled = false;
            try {
                await activeSync.sendEvent('UNREADY', {
                    reason: 'llegada no recibió confirmación del READY',
                    readyId,
                    runnerIndex: currentRunnerIndex,
                    round: currentRound
                });
                p2pSyncStatus(`No se confirmó el aviso de llegada; se invalidó el READY pendiente. ${error.message}`);
            } catch (unreadyError) {
                p2pSyncStatus(`No se confirmó el aviso de llegada y no se pudo invalidar el READY pendiente: ${error.message} ${unreadyError.message}`, 'error');
            }
        }
    };
    $('p2p-retry-result').onclick = () => sendPendingResult();
    $('p2p-local').onclick = () => {
        if (pendingResultLap() &&
            !confirm('Hay un resultado remoto pendiente. Cambiar a modo local lo invalidará y no se avanzará al siguiente participante. ¿Continuar?')) return;
        if ((timerState === 'running' || awaitingResult) &&
            !confirm('Cambiar a modo local interrumpirá el intento en curso. ¿Continuar?')) return;
        abortRun('cambio explícito al modo local', false);
        cleanupRTC({ message: 'Modo local · conexión con la otra estación cerrada' });
        role = null;
        peerReady = false;
        peerReadyAt = 0;
        syncConfirmed = false;
        localReadyConfirmed = false;
        localReadyAt = 0;
        p2pStatus('Modo local · este dispositivo');
        p2pSyncStatus('Modo local explícito · resultados guardados en este dispositivo. No hay sincronización entre estaciones.');
        displayLaps();
        updateRoleStatus();
    };
    $('p2p-toggle').onclick = () => {
        const content = $('p2p-content');
        content.style.display = content.style.display === 'none' ? 'block' : 'none';
        $('p2p-toggle').textContent = content.style.display === 'none' ? '▶' : '▼';
    };

    window.addEventListener('pagehide', () => {
        abortRun('se cerró la página', true, null, false, true);
        cleanupRTC();
        p2pSyncStatus('Página suspendida · modo local sin sincronización activa. Al volver, prepara de nuevo la estación y vuelve a enlazar si necesitas dos dispositivos.', 'error');
    });

    if (window.__PACETRACK_SECTOR_TEST_MODE__ === true) {
        window.__PACETRACK_SECTOR_TEST_API__ = Object.freeze({
            configurePairing(nextRole, nextSync, channel = { readyState: 'open' }) {
                rtcGeneration++;
                preparationGeneration++;
                role = nextRole;
                sessionId = 'adapter-vm-session';
                sync = nextSync;
                syncConfirmed = true;
                dataChannel = channel;
                localReadyConfirmed = false;
                localReadyAt = 0;
                localReadyId = null;
                pendingReadyId = null;
                peerReady = false;
                peerReadyAt = 0;
                peerReadyId = null;
                displayLaps();
                updateRoleStatus();
            },
            dispatchEvent(message) {
                if (!validIncomingEvent(message)) return false;
                processIncomingEvent(message);
                return true;
            },
            ready() { return $('p2p-ready').onclick(); },
            retryResult() { return $('p2p-retry-result').onclick(); },
            openConfiguration() { return openParticipantConfiguration(); },
            applyRunners(names) { return applyRunners(names); },
            disconnected() {
                abortRun('test peer disconnection', false, null, true);
                cleanupRTC({ keepRole: true, message: 'Conexión interrumpida · test recovery' });
            },
            state() {
                return JSON.parse(JSON.stringify({
                    role, currentRunnerIndex, currentRound, timerState, awaitingResult,
                    currentRunnerName: currentRunner().name, startTime, startPending,
                    pendingAttemptId, pendingAttemptMeta, resultRetryPending, runners,
                    localReadyConfirmed, localReadyId, pendingReadyId, peerReady, peerReadyId,
                    activeAttemptId, activeAttemptMeta, recoverableAttempt,
                    pendingResult: pendingResultLap(), roundLaps, recordedLaps
                }));
            },
            controls() {
                return {
                    readyDisplay: $('p2p-ready').style.display,
                    readyDisabled: $('p2p-ready').disabled,
                    retryDisplay: $('p2p-retry-result').style.display,
                    retryDisabled: $('p2p-retry-result').disabled,
                    syncStatus: $('p2p-sync-status').textContent
                };
            }
        });
    }

    function boot() {
        loadLaps();
        if (!runners.length) {
            runners = [{ id: 1, name: 'Corredor 1' }];
            saveLaps();
        }
        if (roundLaps.some(lap =>
            lap.runnerIndex === currentRunnerIndex && lap.round === currentRound &&
            lap.confirmed === true && !lap.invalidated)) advanceRunner();
        p2pStatus('Modo local · este dispositivo');
        p2pSyncStatus('Modo local explícito · cronometraje y resultados en este dispositivo; no hay sincronización entre estaciones.');
        closeSetup();
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js';
        document.head.appendChild(script);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
    else boot();
})();