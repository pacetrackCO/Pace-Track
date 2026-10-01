'use strict';

class RepositoryConflict extends Error {
  constructor(code = 'conflict') {
    super(code);
    this.code = code;
  }
}

class RepositoryLimit extends Error {
  constructor(code = 'limit') {
    super(code);
    this.code = code;
  }
}

class RepositoryClosed extends Error {
  constructor() {
    super('closed');
    this.code = 'closed';
  }
}

function asIso(value) {
  return new Date(value).toISOString();
}

function rowToSession(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    ownerTokenHash: row.owner_token_hash,
    guestTokenHash: row.guest_token_hash,
    ownerExpiresAt: row.owner_expires_at,
    guestExpiresAt: row.guest_expires_at,
    expiresAt: row.expires_at,
    closed: row.closed,
  };
}

function resultFromRow(row) {
  return {
    id: row.result_id,
    sessionId: row.session_id,
    elapsed: Number(row.elapsed),
    method: row.method,
    timestamp: asIso(row.result_timestamp),
  };
}

function createRepository(pool) {
  if (!pool || typeof pool.query !== 'function' || typeof pool.connect !== 'function') {
    throw new TypeError('A PostgreSQL Pool is required.');
  }

  let quotaOperations = 0;

  async function inTransaction(work) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (_) {
        // Keep the original failure; database details must not escape the API.
      }
      throw error;
    } finally {
      client.release();
    }
  }

  async function lockSession(client, id) {
    const result = await client.query(
      `SELECT id, kind, closed, expires_at, guest_expires_at
         FROM pace_sessions
        WHERE id = $1
        FOR UPDATE`,
      [id],
    );
    return result.rows[0] || null;
  }

  function assertActiveSector(session) {
    if (!session || session.kind !== 'sector') {
      throw new RepositoryConflict('not_sector');
    }
    if (session.closed || new Date(session.expires_at).getTime() <= Date.now()) {
      throw new RepositoryClosed();
    }
  }

  return {
    async consumeRateLimit(keyHash, limit, windowSeconds) {
      quotaOperations += 1;
      if (quotaOperations % 256 === 0) {
        await pool.query(
          `DELETE FROM pace_api_rate_limits
            WHERE window_started < clock_timestamp() - INTERVAL '2 hours'`,
        );
      }
      const result = await pool.query(
        `INSERT INTO pace_api_rate_limits (key_hash, window_started, request_count)
         VALUES (
           $1,
           to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2) * $2),
           1
         )
         ON CONFLICT (key_hash) DO UPDATE
           SET window_started = CASE
                 WHEN pace_api_rate_limits.window_started <=
                   clock_timestamp() - ($2 * INTERVAL '1 second')
                 THEN to_timestamp(floor(extract(epoch FROM clock_timestamp()) / $2) * $2)
                 ELSE pace_api_rate_limits.window_started
               END,
               request_count = CASE
                 WHEN pace_api_rate_limits.window_started <=
                   clock_timestamp() - ($2 * INTERVAL '1 second')
                 THEN 1
                 ELSE LEAST(pace_api_rate_limits.request_count + 1, $3)
               END
         RETURNING request_count`,
        [keyHash, windowSeconds, limit + 1],
      );
      return Number(result.rows[0].request_count) <= limit;
    },

    async createSession({ id, kind, ownerTokenHash, inviteHash }) {
      const result = await pool.query(
        `WITH clock AS (
           SELECT clock_timestamp() AS created
         )
         INSERT INTO pace_sessions (
           id, kind, owner_token_hash, invite_hash, created_at,
           owner_expires_at, invite_expires_at, expires_at
         )
         SELECT $1, $2, $3, $4, clock.created,
                clock.created + CASE WHEN $2 = 'pc'
                  THEN INTERVAL '30 days' ELSE INTERVAL '2 hours' END,
                clock.created + INTERVAL '2 hours',
                clock.created + CASE WHEN $2 = 'pc'
                  THEN INTERVAL '30 days' ELSE INTERVAL '2 hours' END
           FROM clock
         RETURNING id, kind, owner_expires_at`,
        [id, kind, ownerTokenHash, inviteHash],
      );
      return {
        id: result.rows[0].id,
        kind: result.rows[0].kind,
        expiresAt: asIso(result.rows[0].owner_expires_at),
      };
    },

    async redeemInvite({ kind, inviteHash, guestTokenHash }) {
      const result = await pool.query(
        `UPDATE pace_sessions
            SET guest_token_hash = $3,
                guest_expires_at = clock_timestamp() + INTERVAL '2 hours',
                invite_hash = NULL,
                invite_expires_at = NULL
          WHERE kind = $1
            AND invite_hash = $2
            AND guest_token_hash IS NULL
            AND invite_expires_at > clock_timestamp()
            AND expires_at > clock_timestamp()
            AND closed = FALSE
         RETURNING id, LEAST(guest_expires_at, expires_at) AS expires_at`,
        [kind, inviteHash, guestTokenHash],
      );
      if (!result.rows[0]) return null;
      return {
        id: result.rows[0].id,
        expiresAt: asIso(result.rows[0].expires_at),
      };
    },

    async findSessionById(id) {
      const result = await pool.query(
        `SELECT id, kind, owner_token_hash, guest_token_hash,
                owner_expires_at, guest_expires_at, expires_at, closed
           FROM pace_sessions
          WHERE id = $1`,
        [id],
      );
      return rowToSession(result.rows[0]);
    },

    async createContact({ nombre, email, mensaje }) {
      await pool.query(
        `INSERT INTO pace_contact_submissions (nombre, email, mensaje)
         VALUES ($1, $2, $3)`,
        [nombre, email, mensaje],
      );
    },

    async readResults(sessionId) {
      const result = await pool.query(
        `SELECT result_id, session_id, elapsed, method, result_timestamp
           FROM pace_session_results
          WHERE session_id = $1
          ORDER BY result_timestamp ASC, result_id ASC
          LIMIT 5000`,
        [sessionId],
      );
      return result.rows.map(resultFromRow);
    },

    async putResult({ sessionId, role, id, elapsed, method, timestamp }) {
      return inTransaction(async (client) => {
        const session = await lockSession(client, sessionId);
        if (!session || session.kind !== 'pc') {
          throw new RepositoryConflict('not_pc');
        }
        if (role !== 'guest') throw new RepositoryConflict('wrong_role');
        if (session.guest_expires_at &&
            new Date(session.guest_expires_at).getTime() <= Date.now()) {
          throw new RepositoryClosed();
        }

        const existing = await client.query(
          `SELECT result_id, session_id, elapsed, method, result_timestamp
             FROM pace_session_results
            WHERE session_id = $1 AND result_id = $2`,
          [sessionId, id],
        );
        if (existing.rows[0]) {
          const record = resultFromRow(existing.rows[0]);
          if (record.elapsed !== elapsed || record.method !== method ||
              record.timestamp !== timestamp) {
            throw new RepositoryConflict();
          }
          return { created: false, record };
        }

        const count = await client.query(
          `SELECT count(*)::integer AS count
             FROM pace_session_results
            WHERE session_id = $1`,
          [sessionId],
        );
        if (Number(count.rows[0].count) >= 5000) {
          throw new RepositoryLimit('result_limit');
        }

        const inserted = await client.query(
          `INSERT INTO pace_session_results (
             session_id, result_id, elapsed, method, result_timestamp
           ) VALUES ($1, $2, $3, $4, $5)
           RETURNING result_id, session_id, elapsed, method, result_timestamp`,
          [sessionId, id, elapsed, method, timestamp],
        );
        return { created: true, record: resultFromRow(inserted.rows[0]) };
      });
    },

    async addSignal({ sessionId, role, type, sdp, candidate }) {
      return inTransaction(async (client) => {
        const session = await lockSession(client, sessionId);
        assertActiveSector(session);
        await client.query(
          `INSERT INTO pace_sector_signals (session_id)
           VALUES ($1)
           ON CONFLICT (session_id) DO NOTHING`,
          [sessionId],
        );
        const signalResult = await client.query(
          `SELECT offer_sdp, answer_sdp, owner_candidate_count,
                  guest_candidate_count
             FROM pace_sector_signals
            WHERE session_id = $1
            FOR UPDATE`,
          [sessionId],
        );
        const signals = signalResult.rows[0];

        if (type === 'offer' || type === 'answer') {
          if ((type === 'offer' && role !== 'owner') ||
              (type === 'answer' && role !== 'guest')) {
            throw new RepositoryConflict('wrong_role');
          }
          const column = type === 'offer' ? 'offer_sdp' : 'answer_sdp';
          if (signals[column] !== null) {
            if (signals[column] !== sdp) throw new RepositoryConflict();
            return { created: false };
          }
          await client.query(
            `UPDATE pace_sector_signals SET ${column} = $2 WHERE session_id = $1`,
            [sessionId, sdp],
          );
          return { created: true };
        }

        if (role !== 'owner' && role !== 'guest') {
          throw new RepositoryConflict('wrong_role');
        }
        const countColumn = role === 'owner'
          ? 'owner_candidate_count'
          : 'guest_candidate_count';
        const currentCount = Number(signals[countColumn]);
        if (currentCount >= 128) throw new RepositoryLimit('candidate_limit');
        const candidateId = currentCount + 1;
        await client.query(
          `INSERT INTO pace_sector_candidates (session_id, role, candidate_id, candidate)
           VALUES ($1, $2, $3, $4::jsonb)`,
          [sessionId, role, candidateId, JSON.stringify(candidate)],
        );
        await client.query(
          `UPDATE pace_sector_signals
              SET ${countColumn} = $2
            WHERE session_id = $1`,
          [sessionId, candidateId],
        );
        return { created: true, candidate: { id: candidateId, candidate } };
      });
    },

    async readSignals(sessionId, oppositeRole) {
      return inTransaction(async (client) => {
        const session = await lockSession(client, sessionId);
        assertActiveSector(session);
        const signalResult = await client.query(
          `SELECT offer_sdp, answer_sdp
             FROM pace_sector_signals
            WHERE session_id = $1`,
          [sessionId],
        );
        const signal = signalResult.rows[0] || {};
        const description = oppositeRole === 'owner'
          ? (signal.offer_sdp ? { type: 'offer', sdp: signal.offer_sdp } : null)
          : (signal.answer_sdp ? { type: 'answer', sdp: signal.answer_sdp } : null);
        const candidatesResult = await client.query(
          `SELECT candidate_id, candidate
             FROM pace_sector_candidates
            WHERE session_id = $1 AND role = $2
            ORDER BY candidate_id ASC
            LIMIT 128`,
          [sessionId, oppositeRole],
        );
        return {
          description,
          answered: Boolean(signal.answer_sdp),
          candidates: candidatesResult.rows.map((row) => ({
            id: Number(row.candidate_id),
            candidate: row.candidate,
          })),
        };
      });
    },

    async closeSession(sessionId) {
      return inTransaction(async (client) => {
        const session = await lockSession(client, sessionId);
        if (!session || session.kind !== 'sector') {
          throw new RepositoryConflict('not_sector');
        }
        if (new Date(session.expires_at).getTime() <= Date.now()) {
          throw new RepositoryClosed();
        }
        await client.query(
          `UPDATE pace_sessions SET closed = TRUE WHERE id = $1`,
          [sessionId],
        );
      });
    },

    async healthCheck() {
      await pool.query('SELECT 1');
    },
  };
}

module.exports = {
  createRepository,
  RepositoryConflict,
  RepositoryLimit,
  RepositoryClosed,
};