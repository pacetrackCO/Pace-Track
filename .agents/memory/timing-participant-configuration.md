---
name: Participant configuration safety
description: Why participant lists must be configured before pairing and protected through pending measurements.
---

Configure the Sector participant list before pairing. Do not allow roster changes during measurement, pending readiness/acknowledgement/result reconciliation, or an established paired session, even when a station appears idle.

**Why:** A roster change can relabel an elapsed measurement or reset one station's participant/round progress independently of the other. A missing acknowledgement does not prove the other station has not already accepted and advanced. Blocking configuration was chosen over silently cancelling or resetting a paired measurement.

**How to apply:** Guard submission as well as opening configuration, including delayed Excel parsing. Explain that users must resolve the pending attempt or disconnect and configure before pairing. Supporting live roster edits would require a coordinated, acknowledged session-change protocol first.