'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');

async function request(origin, method, route, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body;
  if (options.body !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.body);
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
          // Static content is not JSON.
        }
        resolve({ status: res.statusCode, headers: res.headers, body: parsed });
      });
    });
    req.on('error', reject);
    if (body !== undefined) req.write(body);
    req.end();
  });
}

function authorization(token) {
  return { authorization: `Bearer ${token}` };
}

async function main() {
  if (process.env.REPLIT_DEPLOYMENT === '1' || process.env.NODE_ENV === 'production') {
    throw new Error('Integration writes are allowed in development only.');
  }
  if (!process.env.DATABASE_URL || !process.env.SESSION_SECRET) {
    console.log('Replit API integration checks skipped (development database and secret required).');
    return;
  }

  const { Pool } = require('pg');
  const { createApp } = require('../server/app.cjs');
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  pool.on('error', () => {});
  const app = createApp({ pool, sessionSecret: process.env.SESSION_SECRET });
  const server = http.createServer(app);
  const sessionIds = [];

  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const origin = `http://127.0.0.1:${server.address().port}`;
    const created = await request(origin, 'POST', '/api/sessions', {
      body: { kind: 'pc' },
    });
    assert.equal(created.status, 201);
    sessionIds.push(created.body.id);

    const joined = await request(origin, 'POST', '/api/sessions/join', {
      body: { kind: 'pc', invite: created.body.invite },
    });
    assert.equal(joined.status, 200);
    assert.equal((await request(origin, 'POST', '/api/sessions/join', {
      body: { kind: 'pc', invite: created.body.invite },
    })).status, 404);

    const other = await request(origin, 'POST', '/api/sessions', {
      body: { kind: 'pc' },
    });
    assert.equal(other.status, 201);
    sessionIds.push(other.body.id);
    assert.equal((await request(origin, 'GET', `/api/sessions/${other.body.id}`, {
      headers: authorization(created.body.token),
    })).status, 401);
    assert.equal((await request(origin, 'GET', `/api/sessions/${created.body.id}/results`, {
      headers: authorization(joined.body.token),
    })).status, 403);

    const record = {
      id: 'integration_result_1',
      sessionId: created.body.id,
      elapsed: 321.5,
      method: 'automatic',
      timestamp: new Date().toISOString(),
    };
    const resultRoute =
      `/api/sessions/${created.body.id}/results/${record.id}`;
    assert.equal((await request(origin, 'PUT', resultRoute, {
      headers: authorization(joined.body.token),
      body: record,
    })).status, 201);
    assert.equal((await request(origin, 'PUT', resultRoute, {
      headers: authorization(joined.body.token),
      body: record,
    })).status, 200);
    assert.equal((await request(origin, 'PUT', resultRoute, {
      headers: authorization(joined.body.token),
      body: { ...record, elapsed: 322 },
    })).status, 409);
    assert.equal((await request(origin, 'GET',
      `/api/sessions/${created.body.id}/results`, {
        headers: authorization(created.body.token),
      })).body.length, 1);

    const sector = await request(origin, 'POST', '/api/sessions', {
      body: { kind: 'sector' },
    });
    assert.equal(sector.status, 201);
    sessionIds.push(sector.body.id);
    const sectorGuest = await request(origin, 'POST', '/api/sessions/join', {
      body: { kind: 'sector', invite: sector.body.invite },
    });
    assert.equal(sectorGuest.status, 200);
    const signalRoute = `/api/sessions/${sector.body.id}/signals`;
    const offer = { type: 'offer', sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' };
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sectorGuest.body.token),
      body: offer,
    })).status, 403);
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sector.body.token),
      body: offer,
    })).status, 201);
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sector.body.token),
      body: offer,
    })).status, 200);
    const unansweredView = await request(origin, 'GET', signalRoute, {
      headers: authorization(sectorGuest.body.token),
    });
    assert.equal(unansweredView.body.answered, false);
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sectorGuest.body.token),
      body: { type: 'answer', sdp: 'v=0\r\no=- 2 2 IN IP4 127.0.0.1\r\n' },
    })).status, 201);
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sectorGuest.body.token),
      body: { type: 'answer', sdp: 'v=0\r\no=- 3 3 IN IP4 127.0.0.1\r\n' },
    })).status, 409);

    const candidate = {
      candidate: 'candidate:1 1 UDP 123 192.0.2.1 5000 typ host',
      sdpMid: '0',
      sdpMLineIndex: 0,
    };
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sectorGuest.body.token),
      body: { type: 'candidate', candidate },
    })).status, 201);
    assert.equal((await request(origin, 'POST', signalRoute, {
      headers: authorization(sector.body.token),
      body: {
        type: 'candidate',
        candidate: { ...candidate, candidate: 'x'.repeat(2049) },
      },
    })).status, 400);
    const ownerView = await request(origin, 'GET', signalRoute, {
      headers: authorization(sector.body.token),
    });
    assert.equal(ownerView.body.description.type, 'answer');
    assert.equal(ownerView.body.candidates.length, 1);
    const guestView = await request(origin, 'GET', signalRoute, {
      headers: authorization(sectorGuest.body.token),
    });
    assert.equal(guestView.body.description.type, 'offer');
    assert.equal(guestView.body.answered, true);
    assert.equal(guestView.body.candidates.length, 0);

    const repository = app.locals.repository;
    for (let index = 0; index < 128; index += 1) {
      await repository.addSignal({
        sessionId: sector.body.id,
        role: 'owner',
        type: 'candidate',
        candidate: { candidate: `candidate-${index}`, sdpMid: null, sdpMLineIndex: null },
      });
    }
    await assert.rejects(
      repository.addSignal({
        sessionId: sector.body.id,
        role: 'owner',
        type: 'candidate',
        candidate: { candidate: 'over-limit', sdpMid: null, sdpMLineIndex: null },
      }),
      (error) => error && error.code === 'candidate_limit',
    );

    const expiredInvite = await request(origin, 'POST', '/api/sessions', {
      body: { kind: 'pc' },
    });
    assert.equal(expiredInvite.status, 201);
    sessionIds.push(expiredInvite.body.id);
    await pool.query(
      `UPDATE pace_sessions
          SET invite_expires_at = clock_timestamp() - INTERVAL '1 second'
        WHERE id = $1`,
      [expiredInvite.body.id],
    );
    assert.equal((await request(origin, 'POST', '/api/sessions/join', {
      body: { kind: 'pc', invite: expiredInvite.body.invite },
    })).status, 404);

    const closedInvite = await request(origin, 'POST', '/api/sessions', {
      body: { kind: 'sector' },
    });
    assert.equal(closedInvite.status, 201);
    sessionIds.push(closedInvite.body.id);
    assert.equal((await request(origin, 'DELETE',
      `/api/sessions/${closedInvite.body.id}`, {
        headers: authorization(closedInvite.body.token),
      })).status, 204);
    assert.equal((await request(origin, 'POST', '/api/sessions/join', {
      body: { kind: 'sector', invite: closedInvite.body.invite },
    })).status, 404);

    assert.equal((await request(origin, 'DELETE', `/api/sessions/${sector.body.id}`, {
      headers: authorization(sectorGuest.body.token),
    })).status, 403);
    assert.equal((await request(origin, 'DELETE', `/api/sessions/${sector.body.id}`, {
      headers: authorization(sector.body.token),
    })).status, 204);
    assert.equal((await request(origin, 'GET', signalRoute, {
      headers: authorization(sector.body.token),
    })).status, 410);
    assert.deepEqual((await request(origin, 'GET', '/api/health')).body, { ok: true });
    assert.equal((await request(origin, 'GET', '/server/app.cjs')).status, 404);
    assert.equal((await request(origin, 'GET', '/styles.css')).status, 200);
    console.log('Replit API PostgreSQL integration checks passed.');
  } finally {
    await new Promise((resolve) => server.close(resolve));
    if (sessionIds.length) {
      await pool.query(
        `DELETE FROM pace_sector_candidates WHERE session_id = ANY($1::uuid[])`,
        [sessionIds],
      );
      await pool.query(
        `DELETE FROM pace_sector_signals WHERE session_id = ANY($1::uuid[])`,
        [sessionIds],
      );
      await pool.query(
        `DELETE FROM pace_session_results WHERE session_id = ANY($1::uuid[])`,
        [sessionIds],
      );
      await pool.query(
        `DELETE FROM pace_sessions WHERE id = ANY($1::uuid[])`,
        [sessionIds],
      );
    }
    await pool.end();
  }
}

main().catch(() => {
  console.error('Replit API integration checks failed; sensitive details omitted.');
  process.exitCode = 1;
});
