---
name: Timing test realism
description: Avoid false timer failures from virtual-time browser tests and separate simulations from physical validation.
---

Do not change measurement logic solely because a virtual-time iframe test reports a frozen timer. Require real-time browser evidence first.

**Why:** During this project, Chromium's virtual clock advanced JavaScript delays while an iframe's animation-driven display did not advance; the same mode worked in real time without changing its timing logic. This is a test-environment limitation, not evidence of inaccurate elapsed-time arithmetic.

**How to apply:** Run camera/frame lifecycle checks with real elapsed time. Use injected clocks for deterministic protocol arithmetic, and describe camera/network simulations separately from physical-device and live-link validation.