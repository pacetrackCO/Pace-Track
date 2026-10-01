-- PaceTrack Replit API schema. Apply explicitly before starting the server.
-- Session credentials are SHA-256 hashes; raw tokens and invites are never persisted.

CREATE TABLE IF NOT EXISTS pace_sessions (
    id UUID PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('pc', 'sector')),
    owner_token_hash CHAR(64) NOT NULL,
    guest_token_hash CHAR(64),
    invite_hash CHAR(64) UNIQUE,
    created_at TIMESTAMPTZ NOT NULL,
    owner_expires_at TIMESTAMPTZ NOT NULL,
    guest_expires_at TIMESTAMPTZ,
    invite_expires_at TIMESTAMPTZ,
    expires_at TIMESTAMPTZ NOT NULL,
    closed BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS pace_sessions_expiry_idx
    ON pace_sessions (expires_at);

CREATE TABLE IF NOT EXISTS pace_session_results (
    session_id UUID NOT NULL REFERENCES pace_sessions(id),
    result_id TEXT NOT NULL CHECK (length(result_id) BETWEEN 1 AND 128),
    elapsed DOUBLE PRECISION NOT NULL CHECK (
        elapsed >= 0 AND elapsed <= 2592000000
    ),
    method TEXT NOT NULL CHECK (method IN ('manual', 'automatic')),
    result_timestamp TIMESTAMPTZ NOT NULL,
    PRIMARY KEY (session_id, result_id)
);

CREATE INDEX IF NOT EXISTS pace_session_results_order_idx
    ON pace_session_results (session_id, result_timestamp, result_id);

CREATE TABLE IF NOT EXISTS pace_sector_signals (
    session_id UUID PRIMARY KEY REFERENCES pace_sessions(id),
    offer_sdp TEXT,
    answer_sdp TEXT,
    owner_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (
        owner_candidate_count BETWEEN 0 AND 128
    ),
    guest_candidate_count INTEGER NOT NULL DEFAULT 0 CHECK (
        guest_candidate_count BETWEEN 0 AND 128
    )
);

CREATE TABLE IF NOT EXISTS pace_sector_candidates (
    session_id UUID NOT NULL REFERENCES pace_sessions(id),
    role TEXT NOT NULL CHECK (role IN ('owner', 'guest')),
    candidate_id INTEGER NOT NULL CHECK (candidate_id BETWEEN 1 AND 128),
    candidate JSONB NOT NULL,
    PRIMARY KEY (session_id, role, candidate_id)
);

CREATE INDEX IF NOT EXISTS pace_sector_candidates_order_idx
    ON pace_sector_candidates (session_id, role, candidate_id);

CREATE TABLE IF NOT EXISTS pace_api_rate_limits (
    key_hash CHAR(64) PRIMARY KEY,
    window_started TIMESTAMPTZ NOT NULL,
    request_count INTEGER NOT NULL CHECK (request_count > 0)
);

CREATE INDEX IF NOT EXISTS pace_api_rate_limits_window_idx
    ON pace_api_rate_limits (window_started);

CREATE TABLE IF NOT EXISTS pace_contact_submissions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    nombre TEXT NOT NULL,
    email TEXT NOT NULL,
    mensaje TEXT NOT NULL,
    submitted_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);