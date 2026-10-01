document.addEventListener('DOMContentLoaded', () => {
    const STORAGE_KEY = 'pacetrack.pc-sessions.v1';
    const OWNER_SESSION_KEY = 'pacetrack.pc-owner-session.v1';
    const SESSION_KIND = 'pc';
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
    let api = null;
    let ownerSession = null;
    let ownerInvite = null;
    let pollTimer = null;
    let pollInFlight = false;
    let sessionGeneration = 0;

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

    function setStorageStatus(message, kind) {
        storageStatus.textContent = message;
        storageStatus.dataset.kind = kind || 'local';
    }

    function blankStore() {
        return { version: 1, currentSessionId: null, sessions: {} };
    }

    function normalizeRecord(id, value) {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
        let serialized;
        try {
            serialized = JSON.stringify(value);
        } catch (_) {
            return null;
        }
        if (!serialized || utf8ByteLength(serialized) > 2048) return null;
        if (typeof value.elapsed !== 'number' || !Number.isFinite(value.elapsed) || value.elapsed < 0 || value.elapsed > 2592000000) return null;
        const recordId = value.id || id;
        if (typeof recordId !== 'string' || !validResultId(recordId)) return null;
        if (value.method !== undefined && !['manual', 'automatic', 'legacy'].includes(value.method)) return null;
        if (value.timestamp !== undefined && (typeof value.timestamp !== 'string' || value.timestamp.length > 40 ||
            (value.timestamp && !Number.isFinite(Date.parse(value.timestamp))))) return null;
        return {
            id: recordId,
            elapsed: value.elapsed,
            method: value.method || 'legacy',
            timestamp: value.timestamp || ''
        };
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

    function validServerResult(value, targetSession) {
        if (!value || typeof value !== 'object' || Array.isArray(value) ||
            value.sessionId !== targetSession || !['manual', 'automatic'].includes(value.method) ||
            typeof value.timestamp !== 'string' || !value.timestamp) return false;
        const keys = Object.keys(value).sort();
        if (keys.length !== 5 || keys.join(',') !== 'elapsed,id,method,sessionId,timestamp') return false;
        return Boolean(normalizeRecord(value.id, value));
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
            sessionId = null;
            results = new Map();
            sessionNotice.textContent = 'No se pudo recuperar el historial local; no se modificará el archivo dañado.';
            return false;
        }

        Object.entries(loaded.store.sessions).forEach(([id, session]) => {
            sessionArchives.set(id, mergeRecords([], session.results));
        });
        const storedId = loaded.store.currentSessionId;
        if (storedId && loaded.store.sessions[storedId]) {
            sessionId = storedId;
            results = new Map(sessionArchives.get(storedId).map(record => [record.id, record]));
            sessionNotice.textContent = `Sesión local recuperada: ${sessionId}.`;
            setStorageStatus('Copia local recuperada. Los archivos anteriores se conservan para exportar.', 'local');
            return true;
        }
        sessionId = null;
        results = new Map();
        sessionNotice.textContent = loaded.exists
            ? 'No hay sesión activa. Las sesiones locales anteriores se conservan para exportar.'
            : 'Creando una sesión segura…';
        return true;
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
        if (!validSessionId(targetSession) || targetSession !== sessionId) return;
        if (id !== null && id !== undefined && !validResultId(id)) return;
        if (value && value.id !== undefined && id !== null && id !== undefined && value.id !== id) return;
        if (value && value.sessionId !== undefined && value.sessionId !== targetSession) return;
        const record = normalizeRecord(id, value);
        if (!record || results.has(record.id)) return;
        results.set(record.id, record);
        renderResults();
        persistSessionSnapshot(targetSession, Array.from(results.values()));
    }

    function showQr() {
        if (!validSessionId(sessionId) || !ownerInvite) {
            qrcodeContainer.replaceChildren();
            sessionCode.textContent = sessionId ? `Sesión local: ${sessionId}` : 'Sin sesión Replit activa';
            return;
        }
        const qrUrl = new URL('../Mobil/timer.html', window.location.href);
        qrUrl.searchParams.set('session', sessionId);
        qrUrl.hash = `invite=${ownerInvite}`;
        sessionCode.textContent = `Sesión actual: ${sessionId}`;
        try {
            if (typeof QRCode === 'undefined') throw new Error('Librería de código QR no disponible.');
            qrcodeContainer.replaceChildren();
            new QRCode(qrcodeContainer, { text: qrUrl.toString(), width: 200, height: 200 });
            connectionStatus.textContent = 'Sesión Replit lista. Escanea el QR para vincular el móvil de forma segura.';
        } catch (error) {
            connectionStatus.textContent = `${error.message} Copia este enlace en el móvil: ${qrUrl.toString()}`;
        }
    }

    function readOwnerMetadata() {
        try {
            const metadata = JSON.parse(localStorage.getItem(OWNER_SESSION_KEY) || 'null');
            if (!metadata || !validSessionId(metadata.id) || !validInvite(metadata.invite)) return null;
            return metadata;
        } catch (_) {
            return null;
        }
    }

    function validInvite(value) {
        return typeof value === 'string' && /^[a-f0-9]{32}$/i.test(value);
    }

    function saveOwnerMetadata(session) {
        const metadata = { id: session.id, invite: session.invite, expiresAt: session.expiresAt };
        ownerInvite = metadata.invite;
        try {
            localStorage.setItem(OWNER_SESSION_KEY, JSON.stringify(metadata));
            return true;
        } catch (error) {
            setStorageStatus(`La sesión está activa, pero no se pudo guardar su invitación para recuperarla después: ${error.message}`, 'error');
            return false;
        }
    }

    function validCapability(session, expectedId) {
        return Boolean(session && session.id === expectedId && validSessionId(session.id) &&
            typeof session.token === 'string' && session.token.length > 0);
    }

    function stopPolling() {
        sessionGeneration += 1;
        if (pollTimer !== null) {
            window.clearInterval(pollTimer);
            pollTimer = null;
        }
        pollInFlight = false;
    }

    async function pollSession(generation) {
        if (!ownerSession || !api || pollInFlight || generation !== sessionGeneration) return;
        pollInFlight = true;
        const targetSession = sessionId;
        try {
            const info = await api.request(ownerSession, '', { method: 'GET' });
            if (generation !== sessionGeneration || targetSession !== sessionId) return;
            if (!info || info.id !== targetSession || info.kind !== SESSION_KIND || info.role !== 'owner') {
                throw new Error('El servidor no confirmó la sesión propietaria esperada.');
            }
            const remoteResults = await api.request(ownerSession, '/results', { method: 'GET' });
            if (generation !== sessionGeneration || targetSession !== sessionId) return;
            if (!Array.isArray(remoteResults)) throw new Error('El servidor devolvió resultados con un formato no válido.');
            remoteResults.forEach(record => {
                if (validServerResult(record, targetSession)) acceptRecord(record.id, record, targetSession);
            });
            connectionStatus.textContent = 'Conectado a Replit; esperando resultados del móvil.';
        } catch (error) {
            if (generation === sessionGeneration && targetSession === sessionId) {
                connectionStatus.textContent = `Sin conexión con Replit: ${error.message}. Los resultados locales siguen disponibles; se reintentará.`;
            }
        } finally {
            if (generation === sessionGeneration) pollInFlight = false;
        }
    }

    function startPolling() {
        stopPolling();
        if (!ownerSession || !api || !validSessionId(sessionId)) return;
        const generation = sessionGeneration;
        pollSession(generation);
        pollTimer = window.setInterval(() => pollSession(generation), 2000);
    }

    async function activateOwnerSession(session) {
        session = Object.assign({}, session, { role: 'owner' });
        const response = await api.request(session, '', { method: 'GET' });
        if (!response || response.id !== session.id || response.kind !== SESSION_KIND || response.role !== 'owner') {
            throw new Error('La sesión guardada no coincide con la capacidad propietaria; se requiere crear una sesión nueva.');
        }
        ownerSession = Object.assign({}, session, { role: 'owner' });
        sessionId = session.id;
        ownerInvite = (readOwnerMetadata() || {}).invite || session.invite || null;
        if (!sessionArchives.has(sessionId)) sessionArchives.set(sessionId, []);
        results = new Map((sessionArchives.get(sessionId) || []).map(record => [record.id, record]));
        persistActiveSession();
        sessionNotice.textContent = validInvite(ownerInvite)
            ? `Sesión Replit recuperada: ${sessionId}. Se conservan también los historiales locales anteriores.`
            : `Sesión Replit recuperada: ${sessionId}, pero no hay una invitación guardada para conectar móviles. Crea una sesión nueva para emparejar.`;
        showQr();
        renderResults();
        startPolling();
    }

    async function createServerSession() {
        if (!api || typeof api.create !== 'function') throw new Error('La API de sesiones Replit no está disponible.');
        const created = await api.create(SESSION_KIND);
        if (!created || !validSessionId(created.id) || typeof created.token !== 'string' ||
            !created.token || !validInvite(created.invite) || !Number.isFinite(Date.parse(created.expiresAt || ''))) {
            throw new Error('El servidor devolvió una sesión o invitación con formato no válido.');
        }
        const saved = api.save('owner', created);
        if (saved === false) setStorageStatus('La sesión está activa, pero el token propietario no pudo guardarse para recuperarla después.', 'error');
        saveOwnerMetadata(created);
        if (typeof api.saveInvitation === 'function') api.saveInvitation(SESSION_KIND, created.invite, created);
        stopPolling();
        ownerSession = Object.assign({}, created, { role: 'owner' });
        ownerInvite = created.invite;
        sessionId = created.id;
        results = new Map();
        sessionArchives.set(sessionId, []);
        persistActiveSession();
        sessionNotice.textContent = `Nueva sesión Replit: ${sessionId}. Los historiales locales anteriores se conservan para exportar.`;
        showQr();
        renderResults();
        startPolling();
        return created;
    }

    async function initializeSession() {
        try {
            api = window.PaceTrackSessionAPI;
            if (!api || typeof api.request !== 'function') throw new Error('La API de sesiones Replit no está disponible.');
            const metadata = readOwnerMetadata();
            const recoverId = metadata ? metadata.id : sessionId;
            if (recoverId && typeof api.load === 'function') {
                let savedOwner = await api.load('owner', recoverId);
                let savedInvitation = null;
                if (metadata && typeof api.loadInvitation === 'function') {
                    savedInvitation = await api.loadInvitation(SESSION_KIND, metadata.invite);
                }
                if (savedOwner && validCapability(savedOwner, recoverId) &&
                    (!savedInvitation || savedInvitation.id === recoverId)) {
                    try {
                        await activateOwnerSession(Object.assign({}, savedOwner, { invite: metadata && metadata.invite }));
                        return;
                    } catch (error) {
                        connectionStatus.textContent = `No se pudo recuperar la sesión Replit: ${error.message}`;
                    }
                }
            }
            if (sessionId || sessionArchives.size) {
                sessionNotice.textContent = 'Este historial local no tiene una capacidad propietaria guardada. Para conectar móviles, crea una sesión Replit nueva; los archivos antiguos seguirán disponibles para exportar.';
                connectionStatus.textContent = 'Historial local disponible; no se contactará con sesiones antiguas de Firebase.';
                showQr();
                renderResults();
                return;
            }
            await createServerSession();
        } catch (error) {
            connectionStatus.textContent = `No se pudo crear o recuperar la sesión Replit: ${error.message}. La sesión local no se ha reemplazado; pulsa «Nueva sesión» para reintentar.`;
            sessionNotice.textContent = sessionArchives.size
                ? 'Los historiales existentes permanecen locales e intactos.'
                : 'No hay sesión remota activa; no se ha generado un identificador simulado.';
            showQr();
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

    async function startNewSession() {
        const hasResults = results.size > 0;
        if (hasResults && !window.confirm('¿Crear una sesión Replit nueva? Los resultados e historiales anteriores se conservarán en este dispositivo para exportar. Los móviles deberán escanear el nuevo QR.')) return;
        newSessionButton.disabled = true;
        try {
            await createServerSession();
        } catch (error) {
            connectionStatus.textContent = `No se pudo crear la sesión Replit: ${error.message}. La sesión actual y los historiales locales no se han reemplazado.`;
            setStorageStatus(error.message, 'error');
        } finally {
            newSessionButton.disabled = false;
        }
    }

    loadSavedState();
    renderResults();
    showQr();
    initializeSession();
    exportButton.addEventListener('click', exportCsv);
    exportHistoryButton.addEventListener('click', exportAllHistory);
    newSessionButton.addEventListener('click', startNewSession);
    window.addEventListener('pagehide', event => {
        stopPolling();
        if (!event.persisted) return;
    });
    window.addEventListener('pageshow', event => {
        if (event.persisted && ownerSession) startPolling();
    });
    window.addEventListener('online', () => {
        if (ownerSession) pollSession(sessionGeneration);
    });
});