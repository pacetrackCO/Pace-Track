(function (root, factory) {
    const SectorSync = factory();
    if (typeof module === 'object' && module.exports) module.exports = SectorSync;
    if (root) root.SectorSync = SectorSync;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    const VERSION = 1;
    const VALID_TYPES = new Set(['ping', 'pong', 'event', 'ack']);
    const id = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
    const finite = value => typeof value === 'number' && Number.isFinite(value);

    class SectorSync {
        constructor(options = {}) {
            if (typeof options.transport !== 'function') throw new TypeError('transport must be a function');
            this.sessionId = String(options.sessionId || '');
            if (!this.sessionId) throw new TypeError('sessionId is required');
            this.transport = options.transport;
            this.now = options.now || (() => performance.now());
            this.onEvent = options.onEvent || (() => {});
            this.validateEvent = options.validateEvent || (() => true);
            this.onRejected = options.onRejected || (() => {});
            this.onFailure = options.onFailure || (() => {});
            this.minSamples = options.minSamples || 5;
            this.maxAgeMs = options.maxAgeMs || 30000;
            this.driftRateMsPerSecond = options.driftRateMsPerSecond || 0.5;
            this.timeoutMs = options.timeoutMs || 700;
            this.maxRetries = options.maxRetries == null ? 3 : options.maxRetries;
            this.pending = new Map();
            this.samples = [];
            this.seen = new Set();
            this.rejected = new Set();
            this.closed = false;
            this._seq = 0;
        }

        _message(type, fields = {}) {
            return { v: VERSION, sessionId: this.sessionId, eventId: fields.eventId || this._nextId(), type, ...fields };
        }

        _nextId() { return `${this.sessionId}:${++this._seq}:${id()}`; }

        _send(message) {
            if (this.closed) throw new Error('sync session is closed');
            this.transport(JSON.stringify(message));
        }

        _request(message) {
            return new Promise((resolve, reject) => {
                const entry = { message, resolve, reject, attempts: 0, timer: null };
                this.pending.set(message.eventId, entry);
                const send = () => {
                    if (this.closed || !this.pending.has(message.eventId)) return;
                    if (entry.attempts > this.maxRetries) {
                        this.pending.delete(message.eventId);
                        reject(new Error(`No se confirmó ${message.type}; vuelve a intentarlo`));
                        this.onFailure(message.type);
                        return;
                    }
                    entry.attempts++;
                    try { this._send(message); } catch (error) {
                        this.pending.delete(message.eventId);
                        reject(error);
                        return;
                    }
                    entry.timer = setTimeout(send, this.timeoutMs);
                };
                send();
            });
        }

        async measureClock(samples = this.minSamples) {
            const count = Math.max(this.minSamples, Math.floor(samples));
            const jobs = [];
            for (let index = 0; index < count; index++) {
                const t0 = this.now();
                jobs.push(this._request(this._message('ping', { t0 })));
            }
            await Promise.all(jobs);
            return this.clockEstimate();
        }

        get synced() { return this.clockEstimate() !== null; }

        clockEstimate() {
            const fresh = this.samples.filter(sample => this.now() - sample.at <= this.maxAgeMs);
            if (fresh.length < this.minSamples) return null;
            const best = fresh.reduce((a, b) => b.rtt < a.rtt ? b : a);
            const age = Math.max(0, this.now() - best.at);
            const driftAllowance = age / 1000 * this.driftRateMsPerSecond;
            return {
                offset: best.offset,
                rtt: best.rtt,
                driftAllowance,
                driftRateMsPerSecond: this.driftRateMsPerSecond,
                freshnessLimitMs: this.maxAgeMs,
                uncertainty: best.rtt / 2 + driftAllowance,
                sampledAt: best.at,
                age,
                samples: fresh.length
            };
        }

        toLocalTime(remoteTime) {
            const estimate = this.clockEstimate();
            if (!estimate || !finite(remoteTime)) return null;
            return remoteTime - estimate.offset;
        }

        async sendEvent(kind, payload, sentAt = this.now()) {
            if (!['READY', 'UNREADY', 'START', 'RESULT', 'ABORT'].includes(kind)) throw new TypeError('Invalid event kind');
            if (!this.clockEstimate() && kind !== 'UNREADY' && kind !== 'ABORT') {
                throw new Error('No hay una referencia horaria reciente entre los dispositivos');
            }
            if (!finite(sentAt)) throw new TypeError('sentAt must be a finite monotonic timestamp');
            const message = this._message('event', { kind, payload, sentAt });
            await this._request(message);
            return message.eventId;
        }

        receive(raw) {
            if (this.closed) return false;
            let message;
            try { message = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch (_) { return false; }
            if (!this._valid(message)) return false;
            if (message.type === 'ack') {
                const pending = this.pending.get(message.ackId);
                if (!pending) return true;
                clearTimeout(pending.timer);
                this.pending.delete(message.ackId);
                pending.resolve(message);
                return true;
            }
            if (message.type === 'ping') {
                const t1 = this.now();
                const t2 = this.now();
                this._send(this._message('pong', { eventId: message.eventId, replyTo: message.eventId, t0: message.t0, t1, t2 }));
                return true;
            }
            if (message.type === 'pong') {
                const pending = this.pending.get(message.replyTo);
                if (!pending || pending.message.type !== 'ping' ||
                    message.eventId !== message.replyTo || message.t0 !== pending.message.t0) return false;
                const t3 = this.now();
                const rtt = (t3 - message.t0) - (message.t2 - message.t1);
                if (rtt < 0 || rtt > this.maxAgeMs) return false;
                const offset = ((message.t1 - message.t0) + (message.t2 - t3)) / 2;
                this.samples.push({ offset, rtt, at: t3 });
                this.samples = this.samples.filter(sample => t3 - sample.at <= this.maxAgeMs).slice(-30);
                clearTimeout(pending.timer);
                this.pending.delete(message.replyTo);
                pending.resolve(message);
                return true;
            }
            if (message.type === 'event') {
                if (this.rejected.has(message.eventId)) return false;
                if (this.seen.has(message.eventId)) {
                    this._send(this._message('ack', { ackId: message.eventId }));
                    return true;
                }
                let accepted = false;
                try { accepted = this.validateEvent(message) !== false; } catch (_) { accepted = false; }
                if (!accepted) {
                    this.rejected.add(message.eventId);
                    if (this.rejected.size > 500) this.rejected.delete(this.rejected.values().next().value);
                    this.onRejected(message);
                    return false;
                }
                const estimate = this.clockEstimate();
                const convertedAt = estimate ? this.toLocalTime(message.sentAt) : null;
                try {
                    if (this.onEvent({ ...message, convertedAt, uncertainty: estimate ? estimate.uncertainty : null, timingReliable: !!estimate }) === false) {
                        this.rejected.add(message.eventId);
                        if (this.rejected.size > 500) this.rejected.delete(this.rejected.values().next().value);
                        this.onRejected(message);
                        return false;
                    }
                } catch (error) {
                    this.rejected.add(message.eventId);
                    if (this.rejected.size > 500) this.rejected.delete(this.rejected.values().next().value);
                    this.onRejected(message, error);
                    return false;
                }
                this.seen.add(message.eventId);
                if (this.seen.size > 500) this.seen.delete(this.seen.values().next().value);
                this._send(this._message('ack', { ackId: message.eventId }));
                return true;
            }
            return false;
        }

        _valid(message) {
            if (!message || typeof message !== 'object' || Array.isArray(message)) return false;
            if (message.v !== VERSION || message.sessionId !== this.sessionId ||
                typeof message.eventId !== 'string' || message.eventId.length > 200 ||
                !VALID_TYPES.has(message.type)) return false;
            if (message.type === 'ping') return finite(message.t0);
            if (message.type === 'pong') return typeof message.replyTo === 'string' &&
                finite(message.t0) && finite(message.t1) && finite(message.t2);
            if (message.type === 'ack') return typeof message.ackId === 'string';
            return typeof message.kind === 'string' && ['READY', 'UNREADY', 'START', 'RESULT', 'ABORT'].includes(message.kind) &&
                finite(message.sentAt) && message.payload !== null && typeof message.payload === 'object';
        }

        close() {
            this.closed = true;
            for (const [key, entry] of this.pending) {
                clearTimeout(entry.timer);
                entry.reject(new Error('sync session closed'));
                this.pending.delete(key);
            }
            this.samples = [];
            this.seen.clear();
            this.rejected.clear();
        }
    }

    return SectorSync;
});