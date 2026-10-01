'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const express = require('express');
const {
  createRepository,
  RepositoryConflict,
  RepositoryLimit,
  RepositoryClosed,
} = require('./repository.cjs');

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESULT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const INVITE_PATTERN = /^[0-9a-f]{32}$/;
const CLEAN_ROUTES = {
  '/timer': '/timer/timer.html',
  '/timer-loop': '/timer_loop/timer_loop.html',
  '/timer-sector': '/timer_sector/timer_sector.html',
  '/eventos': '/events/events.html',
  '/construccion': '/Construccion/construccion.html',
};
const ROOT_FILES = new Set([
  'index.html',
  'styles.css',
  'pacetrack-ui.css',
  'script.js',
  'robots.txt',
  'sitemap.xml',
]);
const STATIC_DIRECTORIES = new Set([
  'images',
  'Images',
  'Construccion',
  'events',
  'timer',
  'timer_loop',
  'timer_sector',
  'timer_PC',
  'timing',
]);
const BLOCKED_SEGMENTS = new Set([
  'server',
  'db',
  'netlify',
  'tests',
  'security',
  '.git',
  '.agents',
  'artifacts',
  'node_modules',
]);
const STATIC_EXTENSIONS = new Set([
  '.html', '.css', '.js', '.mjs', '.json', '.png', '.jpg', '.jpeg', '.webp',
  '.gif', '.svg', '.ico', '.mp3', '.wav', '.woff', '.woff2', '.ttf', '.xml', '.txt',
]);

class HttpError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function exactObject(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function keyedHash(secret, scope, value) {
  return crypto.createHmac('sha256', secret).update(`${scope}:${value}`).digest('hex');
}

function matchesHash(candidate, expected) {
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/i.test(expected)) return false;
  const left = Buffer.from(candidate, 'hex');
  const right = Buffer.from(expected, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function validDate(value) {
  if (typeof value !== 'string' || value.length > 64 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function stringWithin(value, maxLength) {
  return typeof value === 'string' &&
    [...value].length <= maxLength &&
    !value.includes('\u0000');
}

function requestIp(req) {
  return req.socket && req.socket.remoteAddress
    ? req.socket.remoteAddress
    : 'unknown';
}

function requireJson(req, _res, next) {
  if (!req.is('application/json')) {
    return next(new HttpError(415, 'json_required'));
  }
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

function isAuthorizedExpiryValid(session, role, now = Date.now()) {
  if (!session || new Date(session.expiresAt).getTime() <= now) return false;
  if (role === 'owner') {
    return new Date(session.ownerExpiresAt).getTime() > now;
  }
  return Boolean(session.guestTokenHash && session.guestExpiresAt &&
    new Date(session.guestExpiresAt).getTime() > now);
}

function createApp(options = {}) {
  const sessionSecret = options.sessionSecret || process.env.SESSION_SECRET;
  if (typeof sessionSecret !== 'string' || Buffer.byteLength(sessionSecret) < 32) {
    throw new Error('SESSION_SECRET must be configured with at least 32 bytes.');
  }

  let repository = options.repository;
  if (!repository) {
    let pool = options.pool;
    if (!pool) {
      const connectionString = process.env.DATABASE_URL;
      if (!connectionString) throw new Error('DATABASE_URL must be configured.');
      const { Pool } = require('pg');
      pool = new Pool({ connectionString });
      pool.on('error', () => {
        // Intentionally do not log connection details or database errors.
      });
    }
    repository = createRepository(pool);
  }

  const app = express();
  const staticRoot = path.resolve(options.staticRoot || path.join(__dirname, '..'));
  app.disable('x-powered-by');
  app.locals.repository = repository;

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(self)');
    if (req.originalUrl.startsWith('/api')) {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });

  app.use('/api', (req, _res, next) => {
    const fetchSite = req.get('sec-fetch-site');
    if (fetchSite && fetchSite.toLowerCase() === 'cross-site') {
      return next(new HttpError(403, 'cross_site_request'));
    }
    const origin = req.get('origin');
    if (origin) {
      try {
        const parsed = new URL(origin);
        const host = req.get('host');
        if (parsed.origin === 'null' || !host ||
            parsed.host.toLowerCase() !== host.toLowerCase()) {
          return next(new HttpError(403, 'origin_not_allowed'));
        }
      } catch (_) {
        return next(new HttpError(403, 'origin_not_allowed'));
      }
    }
    next();
  });

  app.use('/api', express.json({
    limit: '72kb',
    strict: true,
    type: 'application/json',
  }));

  const enforceRate = (scope, limit, windowSeconds, valueForKey) =>
    asyncRoute(async (req, _res, next) => {
      const keyHash = keyedHash(sessionSecret, scope, valueForKey(req));
      const allowed = await repository.consumeRateLimit(keyHash, limit, windowSeconds);
      if (!allowed) throw new HttpError(429, 'rate_limit_exceeded');
      next();
    });

  const publicIpLimit = (scope, limit, windowSeconds) =>
    enforceRate(scope, limit, windowSeconds, requestIp);

  const authenticate = asyncRoute(async (req, _res, next) => {
    const preAuthKey = keyedHash(sessionSecret, 'pre-auth-ip', requestIp(req));
    if (!await repository.consumeRateLimit(preAuthKey, 1800, 60)) {
      throw new HttpError(429, 'rate_limit_exceeded');
    }
    const rejectInvalidAuth = async () => {
      const invalidKey = keyedHash(sessionSecret, 'invalid-auth-ip', requestIp(req));
      if (!await repository.consumeRateLimit(invalidKey, 50, 60)) {
        throw new HttpError(429, 'rate_limit_exceeded');
      }
      throw new HttpError(401, 'unauthorized');
    };
    const authorization = req.get('authorization') || '';
    const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization);
    if (!match || !UUID_PATTERN.test(req.params.id)) {
      await rejectInvalidAuth();
    }

    const tokenHash = sha256(match[1]);
    const session = await repository.findSessionById(req.params.id);
    if (!session) {
      await rejectInvalidAuth();
    }
    let role = null;
    if (matchesHash(tokenHash, session.ownerTokenHash)) role = 'owner';
    else if (matchesHash(tokenHash, session.guestTokenHash)) role = 'guest';
    if (!role || !isAuthorizedExpiryValid(session, role)) {
      await rejectInvalidAuth();
    }

    const tokenQuotaKey = keyedHash(sessionSecret, 'authorized-token', tokenHash);
    if (!await repository.consumeRateLimit(tokenQuotaKey, 900, 60)) {
      throw new HttpError(429, 'rate_limit_exceeded');
    }
    req.auth = {
      role,
      session,
      expiresAt: role === 'owner'
        ? new Date(session.ownerExpiresAt).toISOString()
        : new Date(Math.min(
          new Date(session.guestExpiresAt).getTime(),
          new Date(session.expiresAt).getTime(),
        )).toISOString(),
    };
    next();
  });

  function requireRole(role) {
    return (req, _res, next) => {
      if (req.auth.role !== role) return next(new HttpError(403, 'forbidden'));
      next();
    };
  }

  function requireSessionKind(kind) {
    return (req, _res, next) => {
      if (req.auth.session.kind !== kind) {
        return next(new HttpError(403, 'forbidden'));
      }
      next();
    };
  }

  app.get('/api/health', asyncRoute(async (_req, res) => {
    await repository.healthCheck();
    res.json({ ok: true });
  }));

  app.post(
    '/api/sessions',
    requireJson,
    publicIpLimit('create-session-ip', 20, 60 * 60),
    asyncRoute(async (req, res) => {
      if (!exactObject(req.body, ['kind']) ||
          !['pc', 'sector'].includes(req.body.kind)) {
        throw new HttpError(400, 'invalid_request');
      }
      const id = crypto.randomUUID();
      const token = crypto.randomBytes(32).toString('base64url');
      const invite = crypto.randomBytes(16).toString('hex');
      const session = await repository.createSession({
        id,
        kind: req.body.kind,
        ownerTokenHash: sha256(token),
        inviteHash: sha256(invite),
      });
      res.status(201).json({
        id: session.id,
        token,
        invite,
        expiresAt: session.expiresAt,
      });
    }),
  );

  app.post(
    '/api/sessions/join',
    requireJson,
    publicIpLimit('join-session-ip', 30, 60 * 60),
    asyncRoute(async (req, res) => {
      if (!exactObject(req.body, ['kind', 'invite']) ||
          !['pc', 'sector'].includes(req.body.kind) ||
          typeof req.body.invite !== 'string' ||
          !INVITE_PATTERN.test(req.body.invite)) {
        throw new HttpError(400, 'invalid_request');
      }
      const token = crypto.randomBytes(32).toString('base64url');
      const session = await repository.redeemInvite({
        kind: req.body.kind,
        inviteHash: sha256(req.body.invite),
        guestTokenHash: sha256(token),
      });
      if (!session) throw new HttpError(404, 'invite_unavailable');
      res.status(200).json({
        id: session.id,
        token,
        expiresAt: session.expiresAt,
      });
    }),
  );

  app.post(
    '/api/contact',
    requireJson,
    publicIpLimit('contact-ip', 5, 60 * 60),
    asyncRoute(async (req, res) => {
      if (!exactObject(req.body, ['nombre', 'email', 'mensaje'])) {
        throw new HttpError(400, 'invalid_request');
      }
      const nombre = typeof req.body.nombre === 'string' ? req.body.nombre.trim() : '';
      const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
      const mensaje = typeof req.body.mensaje === 'string' ? req.body.mensaje.trim() : '';
      if (!stringWithin(nombre, 100) || nombre.length === 0 ||
          !stringWithin(email, 254) || email.length === 0 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
          !stringWithin(mensaje, 5000) || mensaje.length === 0) {
        throw new HttpError(400, 'invalid_request');
      }
      await repository.createContact({ nombre, email, mensaje });
      res.status(201).json({ ok: true });
    }),
  );

  app.get('/api/sessions/:id', authenticate, asyncRoute(async (req, res) => {
    if (req.auth.session.kind === 'sector' && req.auth.session.closed) {
      throw new HttpError(410, 'session_closed');
    }
    res.json({
      id: req.auth.session.id,
      kind: req.auth.session.kind,
      role: req.auth.role,
      expiresAt: req.auth.expiresAt,
      paired: Boolean(req.auth.session.guestTokenHash),
    });
  }));

  app.get(
    '/api/sessions/:id/results',
    authenticate,
    requireSessionKind('pc'),
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      res.json(await repository.readResults(req.auth.session.id));
    }),
  );

  app.put(
    '/api/sessions/:id/results/:resultId',
    requireJson,
    authenticate,
    requireSessionKind('pc'),
    requireRole('guest'),
    asyncRoute(async (req, res) => {
      const id = req.params.resultId;
      const body = req.body;
      if (!RESULT_ID_PATTERN.test(id) ||
          !exactObject(body, ['id', 'sessionId', 'elapsed', 'method', 'timestamp']) ||
          body.id !== id ||
          body.sessionId !== req.auth.session.id ||
          typeof body.elapsed !== 'number' ||
          !Number.isFinite(body.elapsed) ||
          body.elapsed < 0 || body.elapsed > 2592000000 ||
          !['manual', 'automatic'].includes(body.method)) {
        throw new HttpError(400, 'invalid_result');
      }
      const timestamp = validDate(body.timestamp);
      if (!timestamp) throw new HttpError(400, 'invalid_result');
      const result = await repository.putResult({
        sessionId: req.auth.session.id,
        role: req.auth.role,
        id,
        elapsed: body.elapsed,
        method: body.method,
        timestamp,
      });
      res.status(result.created ? 201 : 200).json(result.record);
    }),
  );

  app.get(
    '/api/sessions/:id/signals',
    authenticate,
    requireSessionKind('sector'),
    asyncRoute(async (req, res) => {
      if (req.auth.session.closed) throw new HttpError(410, 'session_closed');
      const oppositeRole = req.auth.role === 'owner' ? 'guest' : 'owner';
      const signals = await repository.readSignals(req.auth.session.id, oppositeRole);
      res.json({ ...signals, closed: false });
    }),
  );

  app.post(
    '/api/sessions/:id/signals',
    requireJson,
    authenticate,
    requireSessionKind('sector'),
    asyncRoute(async (req, res) => {
      const body = req.body;
      let signal;
      if (body && body.type === 'offer') {
        if (req.auth.role !== 'owner') throw new HttpError(403, 'forbidden');
        if (!exactObject(body, ['type', 'sdp']) ||
            typeof body.sdp !== 'string' ||
            body.sdp.length > 64 * 1024 ||
            !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(body.sdp) ||
            !/^v=0(?:\r?\n)/.test(body.sdp)) {
          throw new HttpError(400, 'invalid_signal');
        }
        signal = { type: 'offer', sdp: body.sdp };
      } else if (body && body.type === 'answer') {
        if (req.auth.role !== 'guest') throw new HttpError(403, 'forbidden');
        if (!exactObject(body, ['type', 'sdp']) ||
            typeof body.sdp !== 'string' ||
            body.sdp.length > 64 * 1024 ||
            !/^[\x09\x0a\x0d\x20-\x7e]*$/.test(body.sdp) ||
            !/^v=0(?:\r?\n)/.test(body.sdp)) {
          throw new HttpError(400, 'invalid_signal');
        }
        signal = { type: 'answer', sdp: body.sdp };
      } else if (body && body.type === 'candidate') {
        if (!exactObject(body, ['type', 'candidate']) ||
            !body.candidate || typeof body.candidate !== 'object' ||
            Array.isArray(body.candidate)) {
          throw new HttpError(400, 'invalid_signal');
        }
        const candidate = body.candidate;
        const allowedKeys = ['candidate', 'sdpMid', 'sdpMLineIndex', 'usernameFragment'];
        if (Object.keys(candidate).some((key) => !allowedKeys.includes(key)) ||
            !Object.prototype.hasOwnProperty.call(candidate, 'candidate') ||
            !Object.prototype.hasOwnProperty.call(candidate, 'sdpMid') ||
            !Object.prototype.hasOwnProperty.call(candidate, 'sdpMLineIndex') ||
            !stringWithin(candidate.candidate, 2048) ||
            Buffer.byteLength(candidate.candidate, 'utf8') > 2048 ||
            !(candidate.sdpMid === null ||
              (stringWithin(candidate.sdpMid, 256) && candidate.sdpMid.length > 0)) ||
            !(candidate.sdpMLineIndex === null ||
              (Number.isInteger(candidate.sdpMLineIndex) &&
               candidate.sdpMLineIndex >= 0 && candidate.sdpMLineIndex <= 65535)) ||
            (Object.prototype.hasOwnProperty.call(candidate, 'usernameFragment') &&
             !(candidate.usernameFragment === null ||
               (stringWithin(candidate.usernameFragment, 256) &&
                candidate.usernameFragment.length > 0))) ||
            Buffer.byteLength(JSON.stringify(candidate), 'utf8') > 2048) {
          throw new HttpError(400, 'invalid_signal');
        }
        signal = { type: 'candidate', candidate };
      } else {
        throw new HttpError(400, 'invalid_signal');
      }

      const result = await repository.addSignal({
        sessionId: req.auth.session.id,
        role: req.auth.role,
        ...signal,
      });
      res.status(result.created ? 201 : 200).json({
        ok: true,
        ...(result.candidate ? { candidate: result.candidate } : {}),
      });
    }),
  );

  app.delete(
    '/api/sessions/:id',
    authenticate,
    requireSessionKind('sector'),
    requireRole('owner'),
    asyncRoute(async (req, res) => {
      await repository.closeSession(req.auth.session.id);
      res.status(204).end();
    }),
  );

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'not_found')));

  app.use((req, res, next) => {
    if (!['GET', 'HEAD'].includes(req.method)) {
      return next(new HttpError(404, 'not_found'));
    }
    let pathname;
    try {
      pathname = decodeURIComponent(req.originalUrl.split('?')[0]);
    } catch (_) {
      return next(new HttpError(404, 'not_found'));
    }
    if (pathname.includes('\\') || pathname.includes('\u0000')) {
      return next(new HttpError(404, 'not_found'));
    }
    if (pathname === '/') pathname = '/index.html';
    if (Object.prototype.hasOwnProperty.call(CLEAN_ROUTES, pathname)) {
      const queryIndex = req.originalUrl.indexOf('?');
      const query = queryIndex === -1 ? '' : req.originalUrl.slice(queryIndex);
      return res.redirect(302, CLEAN_ROUTES[pathname] + query);
    }
    const segments = pathname.split('/').filter(Boolean);
    if (!segments.length ||
        segments.some((segment) => segment === '.' || segment === '..' ||
          segment.startsWith('.') || BLOCKED_SEGMENTS.has(segment.toLowerCase()))) {
      return next(new HttpError(404, 'not_found'));
    }
    const first = segments[0];
    if (segments.length === 1 && !ROOT_FILES.has(first) &&
        !STATIC_DIRECTORIES.has(first)) {
      return next(new HttpError(404, 'not_found'));
    }
    if (segments.length > 1 &&
        (!STATIC_DIRECTORIES.has(first) ||
         !STATIC_EXTENSIONS.has(path.extname(segments[segments.length - 1]).toLowerCase()))) {
      return next(new HttpError(404, 'not_found'));
    }
    if (segments.length === 1 && STATIC_DIRECTORIES.has(first)) {
      return next(new HttpError(404, 'not_found'));
    }
    const filePath = path.resolve(staticRoot, ...segments);
    if (filePath !== staticRoot && !filePath.startsWith(`${staticRoot}${path.sep}`)) {
      return next(new HttpError(404, 'not_found'));
    }
    fs.stat(filePath, (statError, stat) => {
      if (statError || !stat.isFile()) {
        return next(new HttpError(404, 'not_found'));
      }
      res.sendFile(filePath, (sendError) => {
        if (sendError && !res.headersSent) next(new HttpError(404, 'not_found'));
      });
    });
  });

  app.use((error, _req, res, _next) => {
    if (res.headersSent) return;
    if (error instanceof RepositoryClosed) {
      return res.status(410).json({ error: 'session_closed' });
    }
    if (error instanceof RepositoryLimit) {
      return res.status(409).json({ error: error.code });
    }
    if (error instanceof RepositoryConflict) {
      if (error.code === 'wrong_role') {
        return res.status(403).json({ error: 'forbidden' });
      }
      return res.status(409).json({ error: error.code });
    }
    if (error instanceof HttpError) {
      return res.status(error.status).json({ error: error.code });
    }
    if (error && error.type === 'entity.too.large') {
      return res.status(413).json({ error: 'request_too_large' });
    }
    if (error && error.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'invalid_json' });
    }
    if (error instanceof URIError) {
      return res.status(400).json({ error: 'invalid_request' });
    }
    // Never log or return database errors, credentials, or request contents.
    return res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

module.exports = { createApp };