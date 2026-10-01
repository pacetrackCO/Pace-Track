# PaceTrack

The website retains vanilla HTML, CSS and JavaScript. Its active session/results/signaling/contact backend is Express with Replit PostgreSQL; keep the original page structure and timer behavior. Firebase and Netlify files are historical references, not the active runtime.

## Website source of truth

The user requested a visual refresh across the entire interface, retaining the original orange/amber identity or harmonious colors. The implemented interface uses orange, amber and night blue accents.

The approved design is integrated into all eight original pages through the root `pacetrack-ui.css`. The root website is the only publishable app; do not add a story, animation, or mockup artifact unless the user explicitly asks for one.

## Running the website

The `PaceTrack` workflow runs `npm start` from the root. The server listens on `0.0.0.0:5000`, serves the original public pages plus clean routes, and provides same-origin `/api` endpoints. It never serves server source, database schema, tests, secrets or historical Netlify functions. API errors and logs must not disclose connection strings or capabilities.

The server reads `DATABASE_URL` and `SESSION_SECRET` at runtime. `db/schema.sql` is the schema source; `node scripts/apply-dev-schema.cjs` and the post-merge script apply it to development only. There is no startup/publish DDL hook. Replit's Publish flow applies schema changes to its managed production database; do not migrate production manually or publish without the user's approval.

Run `node tests/verify-interface.mjs` to check all eight pages, required controls, local assets, service dependencies and JavaScript syntax.

When updating the website from a design reference, retain current event hooks and Replit service integration. Timer text colors are operational status indicators controlled by the timer scripts; do not override them with `!important` in shared styles.

## Timing verification

The original timer pages use the shared preparation/camera runtime in `timing/`, with mode-specific participant, lap and synchronization adapters. Read `timing/README.md` for operation, interruption rules, repeatable checks and the honest compatibility matrix. Physical Android/iOS camera and live two-device tests remain distinct from the simulated browser checks.

Run `npm test` for interface, timing, persistence and authorization regressions. `npm run test:integration` checks actual development PostgreSQL using synthetic sessions and deletes only its own fixtures. Never run this write test against production. `python3 tests/run-browser-checks.py` exercises real-time Chromium with isolated service/camera mocks; it must never forward session/contact requests to actual databases.

Timing scripts/styles and adapters use matching `v` query parameters in timer pages. Update those parameters together when changing assets for release; clients may have cached older service integrations.

## Service access hardening

Read `security/ACCESS-PLAN.md` and `server/API.md` before changing authorization or relay credentials. Browser capabilities are session-bound, separate for owner/guest, generated on the server, stored hashed in PostgreSQL and expiring; invitations are single-use. Owner credentials are never included in pairing QR URLs. Preserve offline records and explicit unconfirmed sync states.

Static TURN credentials have been removed from all public sector copies. Sector temporarily uses STUN only and warns that restrictive networks may not pair. This does not revoke previously downloaded credentials; provider-side rotation and authorized temporary credentials are pending.

Firebase/Netlify live permissions were not audited or changed; the user authorized replacing those active services with Replit instead. Historical cloud records are not imported or deleted. Preserve/export browser histories; any cloud import requires a separate export or authorized access. Do not re-enable legacy clients as a rollback without evaluating their access risks. Contact submissions are stored in PostgreSQL; no email delivery is implied.