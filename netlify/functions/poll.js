// netlify/functions/poll.js
//
// Lee y vacía la bandeja de señalización (par de signal.js).
// Usa el mismo almacén compartido (Netlify Blobs) para que funcione entre instancias.

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Content-Type': 'application/json'
};

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

exports.handler = async (event) => {
    if (event.httpMethod === 'OPTIONS') {
        return { statusCode: 200, headers: corsHeaders, body: '' };
    }
    if (event.httpMethod !== 'GET') {
        return { statusCode: 405, headers: corsHeaders, body: JSON.stringify({ error: 'Método no permitido' }) };
    }

    try {
        const { id } = event.queryStringParameters || {};
        if (!id) {
            return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Falta el parámetro id' }) };
        }

        const key = inboxKey(id);
        const store = getStoreSafe();
        const now = Date.now();
        let messages = [];

        if (store) {
            try {
                const data = await store.get(key, { type: 'json' });
                if (Array.isArray(data)) messages = data;
                await store.delete(key);
            } catch (e) {
                messages = [];
            }
        } else {
            messages = Array.isArray(memoryFallback[key]) ? memoryFallback[key] : [];
            memoryFallback[key] = [];
        }

        messages = messages.filter((m) => now - (m.timestamp || 0) < 60000);

        return { statusCode: 200, headers: corsHeaders, body: JSON.stringify(messages) };
    } catch (error) {
        console.error('Error en poll:', error);
        return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: error.message || 'Error interno' }) };
    }
};
