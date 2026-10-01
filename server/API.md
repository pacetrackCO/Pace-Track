# PaceTrack Replit API

The vanilla HTML/CSS/JavaScript website remains static. Replit runs the CommonJS
Express application exported as `createApp` from `server/app.cjs`; `server/index.cjs`
binds it to `0.0.0.0:5000`. There is no startup migration or DDL. Apply
`db/schema.sql` explicitly before starting the service. The application reads
`DATABASE_URL` and `SESSION_SECRET` from its
runtime environment. `SESSION_SECRET` must contain at least 32 bytes. Never log,
return, or commit either secret.

## Session lifecycle

Sector negotiation is immutable. `GET /api/sessions/:id/signals` includes
`answered:boolean`, without exposing the reader's own SDP. If arrival reloads
after an answer was saved, it must not generate a new answer in that session:
the UI requests a fresh owner-created session/invitation instead. Cached guest
credentials can resume only a negotiation that has not published its answer.
Concurrent answers that differ still receive 409; no role may overwrite them.

All request and response bodies use JSON. The API rejects cross-site Fetch
Metadata requests and mismatched `Origin` hosts. It does not enable CORS. API
responses use `Cache-Control: no-store`.

| Method and path | Authorization | Contract |
| --- | --- | --- |
| `POST /api/sessions` | Public; 20 requests/IP/hour | Exact body `{ "kind": "pc" \| "sector" }`. Returns `201` and `{ id, token, invite, expiresAt }`. |
| `POST /api/sessions/join` | Public; 30 requests/IP/hour | Exact body `{ "kind": "pc" \| "sector", "invite": "<32 lowercase hex>" }`. Returns a guest `{ id, token, expiresAt }`; invitations are single-use. |
| `GET /api/sessions/:id` | Owner or guest token | Returns `{ id, kind, role, expiresAt, paired }`. |
| `GET /api/sessions/:id/results` | PC owner only | Returns at most 5,000 canonical `{ id, sessionId, elapsed, method, timestamp }` records. |
| `PUT /api/sessions/:id/results/:resultId` | PC guest only | Inserts an immutable result. Identical retries are idempotent; reusing an ID with different data returns `409`. |
| `POST /api/sessions/:id/signals` | Sector owner/guest | Owner may submit one immutable offer; guest may submit one immutable answer. Either role may append up to 128 bounded candidates. |
| `GET /api/sessions/:id/signals` | Sector owner or guest | Returns the opposite role's description/candidates only: `{ description, candidates, closed }`. |
| `DELETE /api/sessions/:id` | Sector owner only | Closes the session; it never deletes user results. |
| `POST /api/contact` | Public; 5 requests/IP/hour | Exact body `{ nombre, email, mensaje }`; stores a submission without a public listing endpoint. |
| `GET /api/health` | Public | Performs `SELECT 1`, returning only `{ "ok": true }` on success. |

Pass credentials as `Authorization: Bearer <token>`. An owner token is valid for
up to 30 days for PC sessions. Guest tokens and invitations expire after two
hours; sector sessions are operational for two hours. A sector session closed
by its owner responds `410` to subsequent authorized reads. Authorization is
bound to the UUID in the URL; neither the role nor session ID is client-selected
on join.

Raw bearer tokens and invitations are returned once and are never stored:
only SHA-256 digests are persisted. Public-IP counters and authorized-token
counters use HMAC-SHA-256 keys derived with `SESSION_SECRET`; raw IP addresses,
tokens, and request bodies are not stored as quota keys. `request.socket.remoteAddress`
is used rather than trusting arbitrary forwarded-IP headers, so Replit's
reverse proxy may make public IP quotas shared across clients. PostgreSQL
fixed-window upserts make the 20/hour create, 30/hour join, 5/hour contact,
1,800/minute pre-authorization lookup guard, 50/minute invalid-authentication,
and 900/minute authorized-token limits concurrency-safe and shared across
instances. Valid polling consumes the broad pre-authorization guard and its
token quota, but never the invalid-authentication counter. Expired rate-limit
metadata may be pruned; session results and contact records are not subject to
quota cleanup.

JSON request bodies are limited to 72 KiB. SDP is printable ASCII, starts with
`v=0`, and is limited to 64 KiB. An ICE candidate is limited to 2 KiB and 128
candidates per role/session. Result elapsed time is finite and bounded to 30
days; each PC session is capped at 5,000 result IDs. Result and description
records cannot be updated or deleted through the API.

## Checks

`node --test tests/replit-api.test.cjs` exercises authorization, schema
validation, immutable results, candidate limits, safe static serving, and
sanitized database failures using an isolated repository double.

`node tests/replit-api-integration.cjs` uses the configured development
PostgreSQL database when `DATABASE_URL` and `SESSION_SECRET` are present; it
does not create/alter schema and removes only the synthetic sessions it
created. Apply the schema beforehand. The integration check intentionally leaves
rate-counter metadata to the normal bounded cleanup policy.