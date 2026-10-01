---
name: Service access changes
description: Approval and recovery boundaries for Firebase authorization and exposed relay credentials.
---

Do not infer deployed legacy Firebase access from web configuration, client-side validation, or mocked synchronization tests. Obtain the deployed rules before making claims about those retired services.

**Why:** The creator explicitly requires approval and a recovery plan before changing rules or credentials on existing services. They subsequently authorized replacing the active Firebase/Netlify services with Replit PostgreSQL instead of auditing unavailable Firebase rules.

**How to apply:** Do not reintroduce Firebase/Netlify as a shortcut. Distinguish retired-service findings, browser mocks and actual PostgreSQL checks. Do not claim old cloud records were imported or old services were secured.

Removing exposed TURN credentials from public assets does not revoke downloaded copies. Recovery must never republish an exposed credential.

**Why:** Security rollback could otherwise recreate the same abuse risk while restoring connectivity.

**How to apply:** Agree on a provider-side rotation and temporary-credential activation plan. Preserve the existing provider, use the secure secrets flow, and disclose restrictive-network pairing limitations until relay access is restored safely.

Immutable WebRTC signaling cannot be reused to recreate a peer connection after its SDP answer was published. Use a fresh owner-created invitation rather than relaxing ownership or overwriting the saved answer.

**Why:** New peer connections generate fresh ICE credentials/SDP. A fixed-SDP mock hid a failed reconnect until completion review reproduced distinct answers.

**How to apply:** Model distinct SDP per peer and server description conflicts in tests. Permit cached credentials only before answer publication; otherwise give an explicit fresh-pairing instruction.