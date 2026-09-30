document.addEventListener('DOMContentLoaded', () => {
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
    const STORAGE_KEY = 'pacetrack.pc-sessions.v1';
    const statusMessage = document.getElementById('status-message');
    const connectionStatus = document.getElementById('connection-status');
    const storageStatus = document.getElementById('storage-status');
    const sessionNotice = document.getElementById('session-notice');
    const sessionCode = document.getElementById('session-code');
    const qrcodeContainer = document.getElementById('qrcode');
    const lapsList = document.getElementById('laps-list');
    const lapsContainer = document.getElementById('laps-container');
    const exportButton = document.getElementById('export-results');
    const exportHistoryButton = document.getElementById('export-history');
    const newSessionButton = document.getElementById('new-session');

    let sessionId = null;
    let results = new Map();
    const sessionArchives = new Map();
    let database = null;
    let connected = false;
    let connectionRef = null;
    let resultsRef = null;
    let legacyRef = null;
    let subscriptions = [];
    let listenerGeneration = 0;

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

    function createSessionId() {
        if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
        return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, character => {
            const random = Math.random() * 16 | 0;
            return (character === 'x' ? random : (random & 0x3 | 0x8)).toString(16);
        });
    }

    function createUnusedSessionId() {
        let candidate = createSessionId();
        for (let attempt = 0; attempt < 8 && sessionArchives.has(candidate); attempt += 1) {
            candidate = createSessionId();
        }
        return candidate;
    }

    function setStorageStatus(message, kind) {
        storageStatus.textContent = message;
        storageStatus.dataset.kind = kind || 'local';
    }

    function blankStore() {
        return { version: 1, currentSessionId: null, sessions: {} };
    }

    function normalizeRecord(id, value) {
        if (!value || !Number.isFinite(Number(value.elapsed))) return null;
        const recordId = value.id || id;
        if (!recordId) return null;
        return Object.assign({}, value, {
            id: String(recordId),
            elapsed: Number(value.elapsed)
        });
    }

    function readStore() {
        let raw;
        try {
            raw = localStorage.getItem(STORAGE_KEY);
        } catch (error) {
            return { ok: false, error: `El navegador no permite leer el historial local: ${error.message}` };
        }
        if (!raw) return { ok: true, store: blankStore(), exists: false };
        try {
            const parsed = JSON.parse(raw);
            if (!parsed || parsed.version !== 1 || !parsed.sessions || typeof parsed.sessions !== 'object' || Array.isArray(parsed.sessions)) {
                throw new Error('El formato guardado no es compatible.');
            }
            for (const [id, session] of Object.entries(parsed.sessions)) {
                if (!validSessionId(id) || !session || !Array.isArray(session.results)) {
                    throw new Error('La sesión guardada está dañada.');
                }
                if (session.results.some(result => !normalizeRecord(null, result))) {
                    throw new Error('Hay un resultado local dañado; no se sobrescribirá el archivo guardado.');
                }
            }
            if (parsed.currentSessionId !== null && !validSessionId(parsed.currentSessionId)) {
                throw new Error('El identificador de la sesión guardada no es válido.');
            }
            return {
                ok: true,
                store: {
                    version: 1,
                    currentSessionId: parsed.currentSessionId || null,
                    sessions: parsed.sessions
                },
                exists: true
            };
        } catch (error) {
            return { ok: false, error: `No se pudo recuperar el historial local: ${error.message} No se modificará el dato dañado.` };
        }
    }

    function mergeRecords(existing, incoming) {
        const merged = new Map();
        (existing || []).forEach(record => {
            const normalized = normalizeRecord(null, record);
            if (normalized && !merged.has(normalized.id)) merged.set(normalized.id, normalized);
        });
        (incoming || []).forEach(record => {
            const normalized = normalizeRecord(null, record);
            if (normalized && !merged.has(normalized.id)) merged.set(normalized.id, normalized);
        });
        return Array.from(merged.values()).sort((a, b) => {
            const timeOrder = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
            return timeOrder || a.id.localeCompare(b.id);
        });
    }

    function writeStore(store) {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
            setStorageStatus('Sesión e historial guardados en este dispositivo.', 'local');
            return true;
        } catch (error) {
            setStorageStatus(`No se pudo guardar el historial local: ${error.message}. La sesión actual sigue activa solo en memoria.`, 'error');
            return false;
        }
    }

    function cacheSession(id, records) {
        const merged = mergeRecords(sessionArchives.get(id) || [], records || []);
        sessionArchives.set(id, merged);
        return merged;
    }

    function persistSessionSnapshot(id, records) {
        const mergedMemory = cacheSession(id, records);
        const loaded = readStore();
        if (!loaded.ok) {
            setStorageStatus(loaded.error, 'error');
            return false;
        }
        const store = loaded.store;
        const previous = store.sessions[id] && store.sessions[id].results;
        store.sessions[id] = Object.assign({}, store.sessions[id] || {}, {
            results: mergeRecords(previous, mergedMemory)
        });
        // A result callback from another open tab must not replace the latest active-session pointer.
        if (!store.currentSessionId) store.currentSessionId = id;
        return writeStore(store);
    }

    function persistActiveSession() {
        const loaded = readStore();
        if (!loaded.ok) {
            setStorageStatus(loaded.error, 'error');
            return false;
        }
        const store = loaded.store;
        const current = Array.from(results.values());
        const records = mergeRecords(store.sessions[sessionId] && store.sessions[sessionId].results, current);
        store.sessions[sessionId] = Object.assign({}, store.sessions[sessionId] || {}, { results: records });
        store.currentSessionId = sessionId;
        cacheSession(sessionId, records);
        return writeStore(store);
    }

    function loadSavedState() {
        const loaded = readStore();
        if (!loaded.ok) {
            setStorageStatus(loaded.error, 'error');
            sessionId = createUnusedSessionId();
            results = new Map();
            sessionNotice.textContent = `No se pudo recuperar una sesión anterior. Esta sesión temporal es ${sessionId}; exporta cualquier resultado antes de cerrar si el almacenamiento continúa indisponible.`;
            return;
        }

        Object.entries(loaded.store.sessions).forEach(([id, session]) => {
            sessionArchives.set(id, mergeRecords([], session.results));
        });
        const storedId = loaded.store.currentSessionId;
        if (storedId && loaded.store.sessions[storedId]) {
            sessionId = storedId;
            results = new Map(sessionArchives.get(storedId).map(record => [record.id, record]));
            sessionNotice.textContent = `Sesión anterior recuperada tras recargar: ${sessionId}. Se recuperaron ${results.size} resultado(s) guardados localmente.`;
            setStorageStatus('Copia local recuperada. Los resultados nuevos se guardarán sin reemplazar otras sesiones.', 'local');
            return;
        }

        sessionId = createUnusedSessionId();
        results = new Map();
        sessionNotice.textContent = loaded.exists
            ? `Se creó una sesión nueva (${sessionId}); las sesiones locales anteriores se conservan para exportar.`
            : `Nueva sesión creada: ${sessionId}.`;
        persistActiveSession();
    }

    function renderResults() {
        const records = Array.from(results.values()).sort((a, b) => {
            const dateDifference = String(a.timestamp || '').localeCompare(String(b.timestamp || ''));
            return dateDifference || String(a.id).localeCompare(String(b.id));
        });
        lapsList.replaceChildren();
        lapsContainer.style.display = records.length ? 'block' : 'none';
        records.forEach((result, index) => {
            const li = document.createElement('li');
            const label = document.createElement('span');
            const time = document.createElement('span');
            const method = document.createElement('small');
            label.textContent = `P${index + 1}:`;
            time.textContent = formatTime(result.elapsed);
            method.textContent = result.method === 'manual' ? 'Manual' :
                result.method === 'automatic' ? 'Automático' : 'Importado';
            li.append(label, time, method);
            lapsList.appendChild(li);
        });
        if (records.length) {
            statusMessage.textContent = `${records.length} resultado${records.length === 1 ? '' : 's'} recuperado${records.length === 1 ? '' : 's'} o confirmado${records.length === 1 ? '' : 's'} en esta sesión.`;
        } else {
            statusMessage.textContent = 'Aún no hay resultados confirmados. Escanea el QR para conectar un móvil.';
        }
    }

    function acceptRecord(id, value, targetSession) {
        if (targetSession !== sessionId) return;
        const record = normalizeRecord(id, value);
        if (!record || results.has(record.id)) return;
        results.set(record.id, record);
        renderResults();
        persistSessionSnapshot(targetSession, Array.from(results.values()));
    }

    function showQr() {
        const qrUrl = `https://pacetrack.es/timer_PC/Mobil/timer.html?session=${encodeURIComponent(sessionId)}`;
        sessionCode.textContent = `Sesión actual: ${sessionId}`;
        try {
            if (typeof QRCode === 'undefined') throw new Error('Librería de código QR no disponible.');
            qrcodeContainer.replaceChildren();
            new QRCode(qrcodeContainer, { text: qrUrl, width: 200, height: 200 });
            connectionStatus.textContent = 'Escanea el QR desde el móvil para conectarlo a esta sesión. No se necesita cámara en este ordenador.';
        } catch (error) {
            connectionStatus.textContent = `${error.message} Copia este enlace en el móvil: ${qrUrl}`;
        }
    }

    function detachFirebase() {
        listenerGeneration += 1;
        subscriptions.forEach(subscription => subscription.ref.off(subscription.event, subscription.callback));
        subscriptions = [];
        connectionRef = null;
        resultsRef = null;
        legacyRef = null;
        connected = false;
    }

    function initFirebase() {
        detachFirebase();
        const targetSession = sessionId;
        const generation = listenerGeneration;
        const isCurrent = () => targetSession === sessionId && generation === listenerGeneration;
        try {
            if (!window.firebase || !firebase.initializeApp || !firebase.database) {
                throw new Error('El SDK de Firebase no se ha cargado.');
            }
            if (!firebase.apps || !firebase.apps.length) firebase.initializeApp(firebaseConfig);
            database = firebase.database();

            function subscribe(ref, event, callback, onError) {
                const guardedCallback = snapshot => { if (isCurrent()) callback(snapshot); };
                const guardedError = error => { if (isCurrent()) onError(error); };
                ref.on(event, guardedCallback, guardedError);
                subscriptions.push({ ref, event, callback: guardedCallback });
            }

            connectionRef = database.ref('.info/connected');
            resultsRef = database.ref(`sessions/${targetSession}/results`);
            legacyRef = database.ref(`sessions/${targetSession}/laps`);
            subscribe(connectionRef, 'value', snapshot => {
                connected = snapshot.val() === true;
                connectionStatus.textContent = connected
                    ? 'Conectado a Firebase; esperando resultados del móvil.'
                    : 'Sin conexión con Firebase. La sesión y los resultados recuperados permanecen visibles localmente.';
            }, error => {
                connected = false;
                connectionStatus.textContent = `Error de conexión recuperable: ${error.message}. La copia local sigue disponible.`;
            });
            subscribe(resultsRef, 'child_added', snapshot => acceptRecord(snapshot.key, snapshot.val(), targetSession), error => {
                connectionStatus.textContent = `No se pudieron leer resultados: ${error.message}. La copia local sigue disponible.`;
            });
            subscribe(resultsRef, 'child_changed', snapshot => acceptRecord(snapshot.key, snapshot.val(), targetSession), error => {
                connectionStatus.textContent = `No se pudieron actualizar resultados: ${error.message}.`;
            });
            // Compatibilidad de lectura para datos antiguos; los nuevos envíos nunca reescriben listas completas.
            subscribe(legacyRef, 'value', snapshot => {
                const oldLaps = snapshot.val();
                if (!Array.isArray(oldLaps)) return;
                oldLaps.forEach((elapsed, index) => {
                    if (Number.isFinite(Number(elapsed))) {
                        acceptRecord(`legacy-${index}`, {
                            id: `legacy-${index}`,
                            elapsed: Number(elapsed),
                            method: 'legacy',
                            timestamp: new Date(index).toISOString()
                        }, targetSession);
                    }
                });
            }, error => {
                connectionStatus.textContent = `No se pudieron recuperar resultados anteriores: ${error.message}`;
            });
        } catch (error) {
            connectionStatus.textContent = `${error.message} El cronometraje móvil sigue disponible; se muestran los resultados guardados en este dispositivo.`;
        }
    }

    function csvDownload(rows, filename) {
        const csv = rows.map(row => row.map(value => `"${String(value).replace(/"/g, '""')}"`).join(',')).join('\r\n');
        const blob = new Blob(['\ufeff', csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = filename;
        anchor.click();
        URL.revokeObjectURL(url);
    }

    function exportCsv() {
        const records = Array.from(results.values()).sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || '')));
        const rows = [['Paso', 'Milisegundos', 'Tiempo', 'Método', 'Fecha', 'ID']];
        records.forEach((result, index) => rows.push([
            index + 1,
            Number(result.elapsed),
            formatTime(result.elapsed),
            result.method || 'legacy',
            result.timestamp || '',
            result.id
        ]));
        csvDownload(rows, `pacetrack-${sessionId}.csv`);
    }

    function exportAllHistory() {
        const loaded = readStore();
        if (loaded.ok) {
            Object.entries(loaded.store.sessions).forEach(([id, session]) => {
                cacheSession(id, session.results);
            });
        } else {
            setStorageStatus(loaded.error, 'error');
        }
        cacheSession(sessionId, Array.from(results.values()));
        const rows = [['Sesión', 'Paso', 'Milisegundos', 'Tiempo', 'Método', 'Fecha', 'ID']];
        Array.from(sessionArchives.entries()).forEach(([id, records]) => {
            records.forEach((result, index) => rows.push([
                id,
                index + 1,
                Number(result.elapsed),
                formatTime(result.elapsed),
                result.method || 'legacy',
                result.timestamp || '',
                result.id
            ]));
        });
        csvDownload(rows, 'pacetrack-sesiones-guardadas.csv');
    }

    function startNewSession() {
        const hasResults = results.size > 0;
        if (hasResults && !window.confirm('¿Crear una sesión nueva? Los resultados confirmados de la sesión actual se conservarán localmente y en Firebase. Los móviles conectados a la sesión anterior no cambiarán; escanea el nuevo QR para conectarlos.')) return;

        const previousId = sessionId;
        persistSessionSnapshot(previousId, Array.from(results.values()));
        detachFirebase();
        sessionId = createSessionId();
        results = new Map();
        sessionArchives.set(sessionId, []);
        persistActiveSession();
        sessionNotice.textContent = `Sesión nueva: ${sessionId}. La sesión anterior (${previousId}) se conserva para exportarla.`;
        showQr();
        renderResults();
        initFirebase();
    }

    loadSavedState();
    showQr();
    renderResults();
    initFirebase();
    exportButton.addEventListener('click', exportCsv);
    exportHistoryButton.addEventListener('click', exportAllHistory);
    newSessionButton.addEventListener('click', startNewSession);
    window.addEventListener('pagehide', event => {
        detachFirebase();
        if (!event.persisted) return;
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted) initFirebase();
    });
});