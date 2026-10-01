'use strict';

const {
    ConfigurationError,
    MAX_SIGNAL_BYTES,
    authorize,
    enqueueSignal,
    getNetlifyStore,
    isPlainObject,
    jsonResponse,
    methodResponse,
    readJsonBody,
    validId,
    validateSignalData
} = require('./lib/signal-security');

function createHandler({ resolveStore = getNetlifyStore, signingSecret } = {}) {
    return async event => {
        const methodError = methodResponse(event, 'POST');
        if (methodError) return methodError;

        let capability;
        try {
            capability = authorize(event, signingSecret);
        } catch (error) {
            if (error instanceof ConfigurationError) {
                return jsonResponse(503, { error: 'Signaling authentication is not configured' });
            }
            return jsonResponse(401, { error: 'A valid signaling capability is required' });
        }
        if (!capability) {
            return jsonResponse(401, { error: 'A valid signaling capability is required' });
        }

        const parsed = readJsonBody(event);
        if (parsed.error) return jsonResponse(parsed.error.statusCode, { error: parsed.error.message });
        const body = parsed.value;
        if (!isPlainObject(body) ||
            Object.keys(body).sort().join(',') !== 'data,id,target' ||
            !validId(body.id) ||
            !validId(body.target) ||
            body.id === body.target ||
            !validateSignalData(body.data)) {
            return jsonResponse(400, { error: 'Invalid signaling payload' });
        }
        if (Buffer.byteLength(JSON.stringify(body.data), 'utf8') > MAX_SIGNAL_BYTES) {
            return jsonResponse(413, { error: 'Signaling payload too large' });
        }

        if (body.id !== capability.id || body.target !== capability.peer) {
            return jsonResponse(403, { error: 'Capability is not authorized for this peer pair' });
        }

        try {
            const store = await resolveStore();
            const timestamp = Date.now();
            const accepted = await enqueueSignal(store, capability.peer, capability.id, {
                from: capability.id,
                data: body.data,
                timestamp,
                expiresAt: timestamp + 5 * 60 * 1000
            });
            if (!accepted) {
                return jsonResponse(429, { error: 'Recipient signaling queue is full' });
            }
            return jsonResponse(200, { success: true });
        } catch (_) {
            return jsonResponse(503, { error: 'Shared signaling storage is unavailable' });
        }
    };
}

exports.handler = createHandler();
exports.createHandler = createHandler;