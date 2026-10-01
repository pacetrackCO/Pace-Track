'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const http = require('node:http');
const test = require('node:test');
const { createApp } = require('../server/app.cjs');
const { RepositoryConflict, RepositoryLimit } = require('../server/repository.cjs');

const SECRET = 'test-session-secret-that-is-at-least-32-bytes';

function digest(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

class MemoryRepository {
  constructor() {
    this.sessions = new Map();
    this.invites = new Map();
    this.results = new Map();
    this.signals = new Map();
    this.rateLimits = new Map();
    this.contacts = [];
    this.failHealth = false;
    this.sessionLookups = 0;
  }

  async consumeRateLimit(key, limit) {
    const count = (this.rateLimits.get(key) || 0) + 1;
    this.rateLimits.set(key, count);
    return count <= limit;
  }

  async createSession({ id, kind, ownerTokenHash, inviteHash }) {
    const now = Date.now();
    const expiresAt = new Date(now + (kind === 'pc' ? 30 : 2) * 60 * 60 * 1000);
    if (kind === 'pc') expiresAt.setTime(now + 30 * 24 * 60 * 60 * 1000);
    const session = {
      id,
      kind,
      ownerTokenHash,
      guestTokenHash: null,
      ownerExpiresAt: expiresAt,
      guestExpiresAt: null,
      expiresAt,
      closed: false,
      inviteHash,
      inviteExpiresAt: new Date(now + 2 * 60 * 60 * 1000),
    };
    this.sessions.set(id, session);
    this.invites.set(inviteHash, session);
    return { id, kind, expiresAt: expiresAt.toISOString() };
  }

  async redeemInvite({ kind, inviteHash, guestTokenHash }) {
    const session = this.invites.get(inviteHash);
    if (!session || session.kind !== kind || session.closed || session.guestTokenHash ||
        session.inviteExpiresAt.getTime() <= Date.now() ||
        session.expiresAt.getTime() <= Date.now()) return null;
    session.guestTokenHash = guestTokenHash;
    session.guestExpiresAt = new Date(Date.now() + 2 * 60 * 60 * 1000);
    this.invites.delete(inviteHash);
    return {
      id: session.id,
      expiresAt: new Date(Math.min(
        session.expiresAt.getTime(),
        session.guestExpiresAt.getTime(),
      )).toISOString(),
    };
  }

  async findSessionById(id) {
    this.sessionLookups += 1;
    return this.sessions.get(id) || null;
  }

  async createContact(contact) {
    this.contacts.push(contact);
  }

  async readResults(sessionId) {
    return this.results.get(sessionId) || [];
  }

  async putResult({ sessionId, role, id, elapsed, method, timestamp }) {
    assert.equal(role, 'guest');
    const records = this.results.get(sessionId) || [];
    const existing = records.find((record) => record.id === id);
    if (existing) {
      if (existing.elapsed !== elapsed || existing.method !== method ||
          existing.timestamp !== timestamp) {
        throw new RepositoryConflict();
      }
      return { created: false, record: existing };
    }
    if (records.length >= 5000) {
      throw new RepositoryLimit('result_limit');
    }
    const record = { id, sessionId, elapsed, method, timestamp };
    records.push(record);
    this.results.set(sessionId, records);
    return { created: true, record };
  }

  async addSignal({ sessionId, role, type, sdp, candidate }) {
    const values = this.signals.get(sessionId) || {
      offer: null, answer: null, owner: [], guest: [],
    };
    this.signals.set(sessionId, values);
    if (type === 'offer' || type === 'answer') {
      if ((type === 'offer' && role !== 'owner') ||
          (type === 'answer' && role !== 'guest')) {
        throw new RepositoryConflict('wrong_role');
      }
      if (values[type] !== null && values[type] !== sdp) {
        throw new RepositoryConflict();
      }
      const created = values[type] === null;
      values[type] = sdp;
      return { created };
    }
    const items = values[role];
    if (items.length >= 128) {
      throw new RepositoryLimit('candidate_limit');
    }
    const saved = { id: items.length + 1, candidate };
    items.push(saved);
    return { created: true, candidate: saved };
  }

  async readSignals(sessionId, oppositeRole) {
    const values = this.signals.get(sessionId) || {
      offer: null, answer: null, owner: [], guest: [],
    };
    return {
      description: oppositeRole === 'owner'
        ? (values.offer ? { type: 'offer', sdp: values.offer } : null)
        : (values.answer ? { type: 'answer', sdp: values.answer } : null),
      answered: Boolean(values.answer),
      candidates: values[oppositeRole],
    };
  }

  async closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session) session.closed = true;
  }

  async healthCheck() {
    if (this.failHealth) throw new Error('private database failure details');
  }
}

async function withServer(t, repository = new MemoryRepository()) {
  const app = createApp({ repository, sessionSecret: SECRET });
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { repository, origin: `http://127.0.0.1:${server.address().port}` };
}

async function request(origin, method, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = headers['content-type'] || 'application/json';
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body);
  }
  return new Promise((resolve, reject) => {
    const req = http.request(`${origin}${route}`, {
      method,
      headers: {
        ...headers,
        ...(body === undefined ? {} : { 'content-length': Buffer.byteLength(body) }),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = text;
        try {
          parsed = text ? JSON.parse(text) : null;
        } catch (_) {
          // Static HTML stays text.
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function bearer(token) {
  return { authorization: `Bearer ${token}` };
}

test('PC sessions bind owner/guest authorization and protect immutable results', async (t) => {
  const { origin } = await withServer(t);
  const created = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'pc' },
  });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^[0-9a-f-]{36}$/i);
  assert.match(created.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.match(created.body.invite, /^[0-9a-f]{32}$/);

  const second = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'pc' },
  });
  const joined = await request(origin, 'POST', '/api/sessions/join', {
    body: { kind: 'pc', invite: created.body.invite },
  });
  assert.equal(joined.status, 200);
  assert.equal(joined.body.id, created.body.id);
  assert.match(joined.body.token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal((await request(origin, 'POST', '/api/sessions/join', {
    body: { kind: 'pc', invite: created.body.invite },
  })).status, 404);

  assert.equal((await request(origin, 'GET', `/api/sessions/${created.body.id}`, {
    headers: bearer(created.body.token),
  })).body.paired, true);
  assert.equal((await request(origin, 'GET', `/api/sessions/${created.body.id}/results`, {
    headers: bearer(joined.body.token),
  })).status, 403);
  assert.equal((await request(origin, 'GET', `/api/sessions/${second.body.id}`, {
    headers: bearer(created.body.token),
  })).status, 401);
  assert.equal((await request(origin, 'PUT',
    `/api/sessions/${created.body.id}/results/lap_1`, {
      headers: bearer(created.body.token),
      body: {
        id: 'lap_1', sessionId: created.body.id, elapsed: 1200,
        method: 'manual', timestamp: '2025-01-01T10:00:00.000Z',
      },
    })).status, 403);

  const record = {
    id: 'lap_1',
    sessionId: created.body.id,
    elapsed: 1200,
    method: 'manual',
    timestamp: '2025-01-01T10:00:00.000Z',
  };
  const url = `/api/sessions/${created.body.id}/results/${record.id}`;
  assert.equal((await request(origin, 'PUT', url, {
    headers: bearer(joined.body.token), body: record,
  })).status, 201);
  assert.equal((await request(origin, 'PUT', url, {
    headers: bearer(joined.body.token), body: record,
  })).status, 200);
  assert.equal((await request(origin, 'PUT', url, {
    headers: bearer(joined.body.token),
    body: { ...record, elapsed: 1201 },
  })).status, 409);
  const results = await request(origin, 'GET',
    `/api/sessions/${created.body.id}/results`, {
      headers: bearer(created.body.token),
    });
  assert.deepEqual(results.body, [record]);
});

test('invite expiry, exact request schemas, and operation ownership are enforced', async (t) => {
  const { origin, repository } = await withServer(t);
  const created = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector', extra: 'not accepted' },
  });
  assert.equal(created.status, 400);
  const session = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector' },
  });
  const stored = repository.sessions.get(session.body.id);
  stored.inviteExpiresAt = new Date(Date.now() - 1);
  assert.equal((await request(origin, 'POST', '/api/sessions/join', {
    body: { kind: 'sector', invite: session.body.invite },
  })).status, 404);

  const closedInvite = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector' },
  });
  assert.equal((await request(origin, 'DELETE', `/api/sessions/${closedInvite.body.id}`, {
    headers: bearer(closedInvite.body.token),
  })).status, 204);
  assert.equal((await request(origin, 'POST', '/api/sessions/join', {
    body: { kind: 'sector', invite: closedInvite.body.invite },
  })).status, 404);

  const active = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector' },
  });
  const joined = await request(origin, 'POST', '/api/sessions/join', {
    body: { kind: 'sector', invite: active.body.invite },
  });
  const route = `/api/sessions/${active.body.id}/signals`;
  const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(joined.body.token), body: offer,
  })).status, 403);
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token), body: offer,
  })).status, 201);
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token),
    body: { ...offer, sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' },
  })).status, 409);

  const candidate = {
    type: 'candidate',
    candidate: {
      candidate: 'candidate:1 1 UDP 123 192.0.2.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    },
  };
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token),
    body: { ...candidate, candidate: { ...candidate.candidate, extra: true } },
  })).status, 400);
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token),
    body: {
      type: 'candidate',
      candidate: { ...candidate.candidate, candidate: 'x'.repeat(2049) },
    },
  })).status, 400);
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token), body: candidate,
  })).status, 201);

  const answer = { type: 'answer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(active.body.token), body: answer,
  })).status, 403);
  assert.equal((await request(origin, 'POST', route, {
    headers: bearer(joined.body.token), body: answer,
  })).status, 201);
  assert.equal((await request(origin, 'DELETE', `/api/sessions/${active.body.id}`, {
    headers: bearer(joined.body.token),
  })).status, 403);
  assert.equal((await request(origin, 'DELETE', `/api/sessions/${active.body.id}`, {
    headers: bearer(active.body.token),
  })).status, 204);
  assert.equal((await request(origin, 'GET', route, {
    headers: bearer(active.body.token),
  })).status, 410);
});

test('candidate quota, rate bounds, same-origin protection and safe static allowlist', async (t) => {
  const repository = new MemoryRepository();
  const { origin } = await withServer(t, repository);
  const sector = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector' },
  });
  const session = repository.sessions.get(sector.body.id);
  repository.signals.set(session.id, {
    offer: null,
    answer: null,
    owner: Array.from({ length: 128 }, (_, index) => ({
      id: index + 1,
      candidate: { candidate: 'seed', sdpMid: null, sdpMLineIndex: null },
    })),
    guest: [],
  });
  assert.equal((await repository.addSignal({
    sessionId: session.id,
    role: 'owner',
    type: 'candidate',
    candidate: { candidate: 'next', sdpMid: null, sdpMLineIndex: null },
  }).then(() => 201, () => 409)), 409);

  assert.equal((await request(origin, 'POST', '/api/sessions', {
    headers: { origin: 'https://attacker.example' },
    body: { kind: 'pc' },
  })).status, 403);
  assert.equal((await request(origin, 'POST', '/api/sessions', {
    headers: { 'sec-fetch-site': 'cross-site' },
    body: { kind: 'pc' },
  })).status, 403);
  assert.equal((await request(origin, 'POST', '/api/sessions', {
    headers: { 'content-type': 'text/plain' },
    body: '{}',
  })).status, 415);

  const home = await request(origin, 'GET', '/');
  assert.equal(home.status, 200);
  assert.equal((await request(origin, 'GET', '/styles.css')).status, 200);
  for (const privatePath of [
    '/server/app.cjs',
    '/db/schema.sql',
    '/netlify.toml',
    '/tests/replit-api.test.cjs',
    '/security/ACCESS-PLAN.md',
    '/.git/config',
    '/.agents/config',
    '/artifacts/mockup-sandbox',
    '/%2e%2e/server/app.cjs',
  ]) {
    assert.equal((await request(origin, 'GET', privatePath)).status, 404, privatePath);
  }
  assert.equal(home.headers['x-content-type-options'], 'nosniff');
  assert.equal(home.headers['referrer-policy'], 'no-referrer');
});

test('health endpoint hides database failures and API responses are not cacheable', async (t) => {
  const repository = new MemoryRepository();
  repository.failHealth = true;
  const { origin } = await withServer(t, repository);
  const response = await request(origin, 'GET', '/api/health');
  assert.equal(response.status, 500);
  assert.deepEqual(response.body, { error: 'internal_error' });
  assert.equal(JSON.stringify(response.body).includes('private database'), false);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('valid polling does not consume the invalid-auth budget; invalid attempts are bounded', async (t) => {
  const repository = new MemoryRepository();
  const { origin } = await withServer(t, repository);
  const created = await request(origin, 'POST', '/api/sessions', {
    body: { kind: 'sector' },
  });
  const route = `/api/sessions/${created.body.id}`;
  for (let index = 0; index < 60; index += 1) {
    assert.equal((await request(origin, 'GET', route, {
      headers: bearer(created.body.token),
    })).status, 200);
  }
  assert.equal(repository.sessionLookups, 60);
  const invalidToken = Buffer.alloc(32, 7).toString('base64url');
  for (let index = 0; index < 50; index += 1) {
    assert.equal((await request(origin, 'GET', `/api/sessions/${crypto.randomUUID()}`, {
      headers: bearer(invalidToken),
    })).status, 401);
  }
  assert.equal((await request(origin, 'GET', `/api/sessions/${crypto.randomUUID()}`, {
    headers: bearer(invalidToken),
  })).status, 429);
  assert.equal(repository.sessionLookups, 111);
});
