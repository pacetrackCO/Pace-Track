'use strict';

const crypto = require('node:crypto');

const CAPABILITY_TTL_MAX_SECONDS = 60 * 60;
const DEFAULT_CAPABILITY_TTL_SECONDS = 5 * 60;
const SIGNAL_TTL_MS = 5 * 60 * 1000;
const MAX_SIGNAL_BYTES = 16 * 1024;
const MAX_REQUEST_BYTES = 20 * 1024;
// Bounds outstanding messages per (recipient, peer) pair, not request rate.
const MAX_QUEUE_ITEMS = 32;
const ATOMIC_QUEUE_CONTRACT = 'pt-signal-queue-v1';
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const SIGNAL_KEYS = {
    offer: ['type', 'sdp'],
    answer: ['type', 'sdp'],
    candidate: ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment']
};

class ConfigurationError extends Error {}
class StorageError extends Error {}

function validId(value) {
    return typeof value === 'string' && ID_PATTERN.test(value);
}

function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) &&
        (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function getSigningSecret(secret) {
    const value = secret === undefined ? process.env.SIGNAL_SESSION_SECRET : secret;
    if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
        throw new ConfigurationError('SIGNAL_SESSION_SECRET must be configured with at least 32 bytes');
    }
    return value;
}

function mac(payload, secret) {
    return crypto.createHmac('sha256', secret).update(payload).digest();
}

/**
 * Trusted server-side provisioning helper only. Do not expose this through a
 * public function or client bundle. A trusted, authenticated provisioning
 * flow must decide who may join, mint one token per participant with that
 * participant's id and permitted peer, and deliver it only to that participant.
 */
function mintCapability({ id, peer, ttlSeconds = DEFAULT_CAPABILITY_TTL_SECONDS, secret, now = Date.now() } = {}) {
    if (!validId(id) || !validId(peer) || id === peer) {
        throw new TypeError('Capability id and peer must be distinct strict IDs');
    }
    if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > CAPABILITY_TTL_MAX_SECONDS) {
        throw new TypeError('Capability lifetime must be between 1 second and 1 hour');
    }
    if (!Number.isSafeInteger(now) || now < 0) throw new TypeError('Invalid capability issue time');

    const signingSecret = getSigningSecret(secret);
    const iat = Math.floor(now / 1000);
    const payload = Buffer.from(JSON.stringify({
        v: 1,
        aud: 'webrtc-signal',
        id,
        peer,
        iat,
        exp: iat + ttlSeconds
    }), 'utf8').toString('base64url');
    const signature = mac(payload, signingSecret).toString('base64url');
    return `${payload}.${signature}`;
}

function verifyCapability(token, secret, now = Date.now()) {
    const signingSecret = getSigningSecret(secret);
    if (typeof token !== 'string' || token.length > 2048) return null;
    const parts = token.split('.');
    if (parts.length !== 2 || !parts[0] || !parts[1]) return null;

    let payloadBytes;
    let signature;
    try {
        payloadBytes = Buffer.from(parts[0], 'base64url');
        signature = Buffer.from(parts[1], 'base64url');
        if (payloadBytes.toString('base64url') !== parts[0] ||
            signature.toString('base64url') !== parts[1] ||
            signature.length !== 32) return null;
    } catch (_) {
        return null;
    }

    const expected = mac(parts[0], signingSecret);
    if (!crypto.timingSafeEqual(signature, expected)) return null;

    let claims;
    try {
        claims = JSON.parse(payloadBytes.toString('utf8'));
    } catch (_) {
        return null;
    }
    if (!isPlainObject(claims) ||
        Object.keys(claims).sort().join(',') !== 'aud,exp,iat,id,peer,v' ||
        claims.v !== 1 ||
        claims.aud !== 'webrtc-signal' ||
        !validId(claims.id) ||
        !validId(claims.peer) ||
        claims.id === claims.peer ||
        !Number.isSafeInteger(claims.iat) ||
        !Number.isSafeInteger(claims.exp)) return null;

    const nowSeconds = Math.floor(now / 1000);
    if (claims.exp <= nowSeconds ||
        claims.iat > nowSeconds + 30 ||
        claims.exp <= claims.iat ||
        claims.exp - claims.iat > CAPABILITY_TTL_MAX_SECONDS) return null;

    return { id: claims.id, peer: claims.peer, expiresAt: claims.exp };
}

function authorizationHeader(event) {
    const headers = event && event.headers || {};
    const key = Object.keys(headers).find(name => name.toLowerCase() === 'authorization');
    return key ? headers[key] : undefined;
}

function authorize(event, secret) {
    const header = authorizationHeader(event);
    if (typeof header !== 'string') return null;
    const match = /^Bearer ([A-Za-z0-9_.-]+)$/.exec(header);
    if (!match) return null;
    return verifyCapability(match[1], secret);
}

function header(event, name) {
    const headers = event && event.headers || {};
    const key = Object.keys(headers).find(candidate => candidate.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
}

function requestOriginIsSame(event) {
    const origin = header(event, 'origin');
    const fetchSite = header(event, 'sec-fetch-site');
    if (fetchSite === 'cross-site') return false;
    if (origin === undefined) return true;
    if (typeof origin !== 'string') return false;

    const forwardedHost = header(event, 'x-forwarded-host');
    const host = (typeof forwardedHost === 'string' && forwardedHost.split(',')[0].trim()) ||
        header(event, 'host') ||
        event && event.requestContext && event.requestContext.domainName;
    const forwardedProto = header(event, 'x-forwarded-proto');
    const requestProtocol = event && event.requestContext && event.requestContext.protocol;
    const protocol = (typeof forwardedProto === 'string' && forwardedProto.split(',')[0].trim()) ||
        (typeof requestProtocol === 'string' && requestProtocol.split('/')[0]) ||
        (host && /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(host) ? 'http' : 'https');
    if (typeof host !== 'string' || !host || !protocol) return false;

    try {
        const parsedOrigin = new URL(origin);
        const requestUrl = new URL(`${protocol}://${host}`);
        return parsedOrigin.origin === requestUrl.origin;
    } catch (_) {
        return false;
    }
}

function jsonResponse(statusCode, body) {
    return {
        statusCode,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Cache-Control': 'no-store'
        },
        body: JSON.stringify(body)
    };
}

function methodResponse(event, method) {
    if (!requestOriginIsSame(event)) {
        return jsonResponse(403, { error: 'Cross-origin requests are not allowed' });
    }
    if (!event || event.httpMethod !== method) {
        return jsonResponse(405, { error: `Method not allowed; use ${method}` });
    }
    return null;
}

function readJsonBody(event) {
    const body = event && event.body;
    if (typeof body !== 'string') {
        return { error: { statusCode: 400, message: 'Invalid JSON body' } };
    }

    let bytes;
    try {
        if (event.isBase64Encoded) {
            if (body.length > Math.ceil(MAX_REQUEST_BYTES * 4 / 3) + 8) {
                return { error: { statusCode: 413, message: 'Request body too large' } };
            }
            bytes = Buffer.from(body, 'base64');
        } else {
            bytes = Buffer.from(body, 'utf8');
        }
    } catch (_) {
        return { error: { statusCode: 400, message: 'Invalid JSON body' } };
    }
    if (bytes.length > MAX_REQUEST_BYTES) {
        return { error: { statusCode: 413, message: 'Request body too large' } };
    }

    try {
        return { value: JSON.parse(bytes.toString('utf8')) };
    } catch (_) {
        return { error: { statusCode: 400, message: 'Invalid JSON body' } };
    }
}

function validateSignalData(data) {
    if (!isPlainObject(data)) return false;
    if (data.type === 'offer' || data.type === 'answer') {
        const expectedKeys = SIGNAL_KEYS[data.type];
        if (Object.keys(data).sort().join(',') !== expectedKeys.slice().sort().join(',')) return false;
        if (typeof data.sdp !== 'string' || data.sdp.trim().length === 0) return false;
        return Buffer.byteLength(data.sdp, 'utf8') <= MAX_SIGNAL_BYTES;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'candidate')) {
        if (Object.keys(data).some(key => !SIGNAL_KEYS.candidate.includes(key))) return false;
        if (typeof data.candidate !== 'string' ||
            Buffer.byteLength(data.candidate, 'utf8') > 4096) return false;
        if (Object.prototype.hasOwnProperty.call(data, 'sdpMid') &&
            data.sdpMid !== null &&
            (typeof data.sdpMid !== 'string' || Buffer.byteLength(data.sdpMid, 'utf8') > 256)) return false;
        if (Object.prototype.hasOwnProperty.call(data, 'sdpMLineIndex') &&
            data.sdpMLineIndex !== null &&
            (!Number.isSafeInteger(data.sdpMLineIndex) || data.sdpMLineIndex < 0 || data.sdpMLineIndex > 65535)) return false;
        if (Object.prototype.hasOwnProperty.call(data, 'usernameFragment') &&
            data.usernameFragment !== null &&
            (typeof data.usernameFragment !== 'string' || Buffer.byteLength(data.usernameFragment, 'utf8') > 256)) return false;
        return Buffer.byteLength(JSON.stringify(data), 'utf8') <= MAX_SIGNAL_BYTES;
    }
    return false;
}

function inboxSlotKey(id, peer, slot) {
    return `v1:${id}:${peer}:${slot}`;
}

/*
 * Source audit: @netlify/blobs 11.1.2 dist/main.d.ts declares SetOptions
 * (onlyIfNew / onlyIfMatch) and WriteResult.modified; dist/main.cjs shows
 * getWithMetadata consistency routing and setJSON's conditional headers/results.
 * package.json exports the CommonJS entry under `require`. This is source
 * evidence, not live-service certification. The adapter uses only those APIs:
 * getWithMetadata(..., { consistency: 'strong' }) and setJSON(...,
 * { onlyIfNew / onlyIfMatch }). Physical deletion is deliberately avoided:
 * slot consumption is a CAS write of a tombstone, so an old poll cannot delete
 * a newer message. A fixed set of slots per participant pair bounds stored
 * records even though tombstones are retained. Message TTL is enforced on
 * reads/reuse; v11.1.2's SetOptions has no blob-expiration setting, so an
 * unvisited expired payload can remain in its fixed slot until that pair next
 * polls or sends, but it is never returned after expiresAt.
 */
function isStoredMessageValid(message, now) {
    return isPlainObject(message) &&
        validId(message.from) &&
        Number.isSafeInteger(message.timestamp) &&
        Number.isSafeInteger(message.expiresAt) &&
        message.expiresAt > now &&
        message.expiresAt - message.timestamp <= SIGNAL_TTL_MS &&
        validateSignalData(message.data);
}

function hasAtomicQueueOperations(store) {
    return Boolean(store &&
        store.atomicQueueContract === ATOMIC_QUEUE_CONTRACT &&
        typeof store.getVersioned === 'function' &&
        typeof store.createIfAbsent === 'function' &&
        typeof store.setIfVersion === 'function');
}

function isTombstone(record) {
    return isPlainObject(record) && record.v === 1 && record.tombstone === true;
}

async function enqueueSignal(store, recipientId, senderId, message) {
    if (!hasAtomicQueueOperations(store)) {
        throw new StorageError('Shared signaling storage lacks verified atomic queue operations');
    }

    for (let slot = 0; slot < MAX_QUEUE_ITEMS; slot += 1) {
        const key = inboxSlotKey(recipientId, senderId, slot);
        const current = await store.getVersioned(key);
        if (current !== null && current !== undefined) {
            if (!isPlainObject(current) ||
                !Object.prototype.hasOwnProperty.call(current, 'version') ||
                !Object.prototype.hasOwnProperty.call(current, 'value')) {
                throw new StorageError('Shared signaling storage returned an invalid versioned record');
            }
            if (isTombstone(current.value)) {
                const inserted = await store.setIfVersion(key, current.version, message);
                if (inserted) return true;
                continue;
            }
            if (isStoredMessageValid(current.value, Date.now())) continue;
            const replaced = await store.setIfVersion(key, current.version, {
                v: 1,
                tombstone: true,
                expiresAt: Date.now() + SIGNAL_TTL_MS
            });
            if (!replaced) continue;
            slot -= 1;
            continue;
        }

        const inserted = await store.createIfAbsent(key, message);
        if (inserted) return true;
    }
    return false;
}

async function pollSignals(store, recipientId, allowedPeer) {
    if (!hasAtomicQueueOperations(store)) {
        throw new StorageError('Shared signaling storage lacks verified atomic queue operations');
    }

    const now = Date.now();
    const messages = [];
    for (let slot = 0; slot < MAX_QUEUE_ITEMS; slot += 1) {
        const key = inboxSlotKey(recipientId, allowedPeer, slot);
        const current = await store.getVersioned(key);
        if (current === null || current === undefined) continue;
        if (!isPlainObject(current) ||
            !Object.prototype.hasOwnProperty.call(current, 'version') ||
            !Object.prototype.hasOwnProperty.call(current, 'value')) {
            throw new StorageError('Shared signaling storage returned an invalid versioned record');
        }

        const message = current.value;
        if (isTombstone(message)) continue;
        const validMessage = isStoredMessageValid(message, now) && message.from === allowedPeer;
        const consumed = await store.setIfVersion(key, current.version, {
            v: 1,
            tombstone: true,
            expiresAt: now + SIGNAL_TTL_MS
        });
        // Return a message only if the exact version observed was replaced.
        // A concurrent replacement changes the ETag and makes this CAS fail.
        if (consumed && validMessage) {
            messages.push(message);
        }
    }

    messages.sort((left, right) => left.timestamp - right.timestamp);
    return messages.map(({ from, data, timestamp }) => ({ from, data, timestamp }));
}

function createBlobsQueueAdapter(blobStore) {
    if (!blobStore ||
        typeof blobStore.getWithMetadata !== 'function' ||
        typeof blobStore.setJSON !== 'function') {
        throw new StorageError('Netlify Blobs 11.1.2 conditional APIs are unavailable');
    }

    return {
        atomicQueueContract: ATOMIC_QUEUE_CONTRACT,
        async getVersioned(key) {
            const result = await blobStore.getWithMetadata(key, {
                type: 'json',
                consistency: 'strong'
            });
            if (result === null) return null;
            if (!isPlainObject(result) ||
                typeof result.etag !== 'string' ||
                result.etag.length === 0 ||
                !Object.prototype.hasOwnProperty.call(result, 'data')) {
                throw new StorageError('Netlify Blobs returned an invalid versioned record');
            }
            return { value: result.data, version: result.etag };
        },
        async createIfAbsent(key, value) {
            const result = await blobStore.setJSON(key, value, { onlyIfNew: true });
            if (!isPlainObject(result) || typeof result.modified !== 'boolean') {
                throw new StorageError('Netlify Blobs returned an invalid conditional-write result');
            }
            return result.modified;
        },
        async setIfVersion(key, version, value) {
            const result = await blobStore.setJSON(key, value, { onlyIfMatch: version });
            if (!isPlainObject(result) || typeof result.modified !== 'boolean') {
                throw new StorageError('Netlify Blobs returned an invalid conditional-write result');
            }
            return result.modified;
        }
    };
}

function getNetlifyStore() {
    try {
        const sdkPackage = require('@netlify/blobs/package.json');
        if (sdkPackage.version !== '11.1.2') {
            throw new StorageError('Signaling requires the source-audited @netlify/blobs 11.1.2 API');
        }
        const { getStore } = require('@netlify/blobs');
        return createBlobsQueueAdapter(getStore('webrtc-signal'));
    } catch (error) {
        if (error instanceof StorageError) throw error;
        throw new StorageError('Netlify Blobs is unavailable');
    }
}

module.exports = {
    CAPABILITY_TTL_MAX_SECONDS,
    MAX_SIGNAL_BYTES,
    MAX_REQUEST_BYTES,
    MAX_QUEUE_ITEMS,
    ATOMIC_QUEUE_CONTRACT,
    ConfigurationError,
    StorageError,
    authorize,
    createBlobsQueueAdapter,
    enqueueSignal,
    getNetlifyStore,
    isPlainObject,
    jsonResponse,
    methodResponse,
    mintCapability,
    pollSignals,
    readJsonBody,
    requestOriginIsSame,
    validId,
    validateSignalData,
    inboxSlotKey
};