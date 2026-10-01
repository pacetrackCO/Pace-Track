(function (root) {
    'use strict';

    const ACCESS_PREFIX = 'pacetrack.access.v1:';
    const INVITE_PREFIX = 'pacetrack.invite.v1:';
    const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
    const TOKEN = /^[A-Za-z0-9_-]{43}$/;
    const INVITE = /^[a-f0-9]{32}$/;

    function validSession(session) {
        return Boolean(session && ID.test(session.id) && TOKEN.test(session.token));
    }

    function error(message, status) {
        const failure = new Error(message);
        failure.status = status || 0;
        return failure;
    }

    async function fetchJSON(path, options) {
        if (typeof root.fetch !== 'function') throw error('El servicio de sesiones no está disponible en este navegador.');
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 12000);
        try {
            const response = await root.fetch(path, Object.assign({
                credentials: 'same-origin',
                cache: 'no-store',
                redirect: 'error',
                signal: controller.signal
            }, options));
            if (response.ok && response.status === 204) return null;
            let data;
            try { data = await response.json(); } catch (_) {
                throw error('El servidor no devolvió una respuesta válida.', response.status);
            }
            if (!response.ok) {
                const messages = {
                    401: 'El acceso a la sesión no es válido o ha caducado. Crea una nueva sesión y vuelve a emparejar.',
                    403: 'Este dispositivo no tiene permiso para esa operación.',
                    404: 'No encontramos la sesión. Crea una nueva y vuelve a emparejar.',
                    409: 'La invitación ya se utilizó o el dato entra en conflicto con uno confirmado.',
                    410: 'La sala o la invitación ha caducado. Crea una nueva.',
                    429: 'Se alcanzó el límite de intentos. Espera un momento antes de reintentar.',
                    503: 'La base de datos no está disponible. Los resultados locales siguen conservados.'
                };
                throw error(messages[response.status] || 'No se pudo completar la solicitud a la sesión.', response.status);
            }
            return data;
        } catch (failure) {
            if (failure.status !== undefined) throw failure;
            throw error(failure.name === 'AbortError'
                ? 'El servidor tardó demasiado. Los datos locales se conservan; puedes reintentar.'
                : 'No se pudo conectar con el servidor. Los datos locales se conservan; puedes reintentar.');
        } finally { clearTimeout(timeout); }
    }

    async function create(kind) {
        if (!['pc', 'sector'].includes(kind)) throw error('Tipo de sesión no válido.');
        const session = await fetchJSON('/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: kind })
        });
        if (!validSession(session) || !INVITE.test(session.invite)) throw error('La nueva sesión no tiene un acceso seguro válido.');
        return session;
    }

    async function join(kind, invite) {
        if (!['pc', 'sector'].includes(kind) || !INVITE.test(invite)) throw error('Código de invitación no válido.');
        const session = await fetchJSON('/api/sessions/join', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ kind: kind, invite: invite })
        });
        if (!validSession(session)) throw error('La invitación no devolvió un acceso seguro válido.');
        return session;
    }

    async function request(session, suffix, options) {
        if (!validSession(session)) throw error('Falta el acceso seguro de este dispositivo.', 401);
        if (typeof suffix !== 'string' || !/^(?:|\/results(?:\/[A-Za-z0-9_-]{1,128})?|\/signals)$/.test(suffix)) {
            throw error('Ruta de sesión no válida.');
        }
        const settings = options || {};
        const method = settings.method || 'GET';
        if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)) throw error('Operación de sesión no válida.');
        const headers = { Authorization: 'Bearer ' + session.token };
        const init = { method: method, headers: headers };
        if (settings.body !== undefined) {
            headers['Content-Type'] = 'application/json';
            init.body = JSON.stringify(settings.body);
        }
        return fetchJSON('/api/sessions/' + encodeURIComponent(session.id) + suffix, init);
    }

    function read(key) {
        try {
            const value = JSON.parse(root.localStorage.getItem(key) || 'null');
            return validSession(value) ? value : null;
        } catch (_) { return null; }
    }
    function write(key, session) {
        if (!validSession(session)) return false;
        try {
            root.localStorage.setItem(key, JSON.stringify(session));
            return true;
        } catch (_) { return false; }
    }
    function save(role, session) {
        return ['owner', 'guest'].includes(role) && validSession(session)
            ? write(ACCESS_PREFIX + role + ':' + session.id, session) : false;
    }
    function load(role, id) {
        if (!['owner', 'guest'].includes(role) || typeof id !== 'string' || !ID.test(id)) return null;
        const session = read(ACCESS_PREFIX + role + ':' + id);
        return session && session.id === id ? session : null;
    }
    function saveInvitation(kind, invite, session) {
        return ['pc', 'sector'].includes(kind) && INVITE.test(invite)
            ? write(INVITE_PREFIX + kind + ':' + invite, session) : false;
    }
    function loadInvitation(kind, invite) {
        return ['pc', 'sector'].includes(kind) && INVITE.test(invite)
            ? read(INVITE_PREFIX + kind + ':' + invite) : null;
    }

    root.PaceTrackSessionAPI = Object.freeze({
        create: create, join: join, request: request,
        save: save, load: load,
        saveInvitation: saveInvitation, loadInvitation: loadInvitation
    });
})(typeof window !== 'undefined' ? window : globalThis);