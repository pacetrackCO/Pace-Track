'use strict';

const {
    ConfigurationError,
    authorize,
    getNetlifyStore,
    jsonResponse,
    methodResponse,
    pollSignals,
    validId
} = require('./lib/signal-security');

function createHandler({ resolveStore = getNetlifyStore, signingSecret } = {}) {
    return async event => {
        const methodError = methodResponse(event, 'GET');
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

        const params = event && event.queryStringParameters;
        const id = params && params.id;
        if (!validId(id)) return jsonResponse(400, { error: 'A valid id query parameter is required' });
        if (id !== capability.id) {
            return jsonResponse(403, { error: 'Capability is not authorized for this session' });
        }

        try {
            const store = await resolveStore();
            const messages = await pollSignals(store, capability.id, capability.peer);
            return jsonResponse(200, messages);
        } catch (_) {
            return jsonResponse(503, { error: 'Shared signaling storage is unavailable' });
        }
    };
}

exports.handler = createHandler();
exports.createHandler = createHandler;