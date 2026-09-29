// netlify/functions/signal.js
//
// Cola de señalización WebRTC. ANTES usaba un objeto en memoria (`const messages = {}`),
// que NO funciona en Netlify: cada función (signal/poll) corre en instancias aisladas y
// efímeras, así que los mensajes nunca llegaban al otro extremo.
// AHORA usa Netlify Blobs como almacén compartido, con fallback en memoria para `netlify dev`.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

// Fallback solo para desarrollo local (un único proceso)
const memoryFallback = globalThis.__ptSignalMemory || (globalThis.__ptSignalMemory = {});

function inboxKey(id) {
    return `inbox:${String(id).toUpperCase().replace(/[^A-Z0-9-]/g, '').slice(0, 64)}`;
}

function getStoreSafe() {
    try {
        // eslint-disable-next-line global-require
        const { getStore } = require('@netlify/blobs');
        return getStore('webrtc-signal');
    } catch (e) {
        return null;
    }
}

async function readInbox(store, key) {
    if (store) {
        try {
            const data = await store.get(key, { type: 'json' });
            return Array.isArray(data) ? data : [];
        } catch (e) {
            return [];
        }
    }
    return Array.isArray(memoryFallback[key]) ? memoryFallback[key] : [];
}

async function writeInbox(store, key, arr) {
    if (store) {
        try {
            await store.setJSON(key, arr);
            return;
        } catch (e) {
            // cae al fallback en memoria
        }
    }
    memoryFallback[key] = arr;
}

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Método no permitido' }) };
    }

    try {
        const body = JSON.parse(event.body || '{}');
        const { id, target, data } = body;

        if (!id || !target || !data) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Faltan parámetros id, target o data' }) };
        }
        if (String(id) === String(target)) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'id y target no pueden ser iguales' }) };
        }
        const raw = JSON.stringify(data);
        if (raw.length > 20000) {
            return { statusCode: 413, headers: corsHeaders, body: JSON.stringify({ error: 'Mensaje demasiado grande' }) };
        }

        const store = getStoreSafe();
        const key = inboxKey(target);
        const now = Date.now();
        const inbox = (await readInbox(store, key)).filter((m) => now - (m.timestamp || 0) < 60000);

        inbox.push({ from: String(id).slice(0, 64), data, timestamp: now });
        await writeInbox(store, key, inbox.slice(-20));

        return {
            statusCode: 200,
            headers: corsHeaders,
            body: JSON.stringify({ success: true, message: 'Señal enviada correctamente', sharedStore: !!store })
        };
    } catch (error) {
        console.error('Error en signal:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message || 'Error interno' }) };
    }
};
