---
name: Vault certification evidence boundary
description: How Vault modularization certification separates repository proof from deployment-specific proof.
---

The Vault modularization certificate may mark repository and static compatibility
gates as PASS, but it must keep provider-backed staging, production, destructive
restore, and sustained capacity results explicitly environment-dependent.

**Why:** Static files and validators cannot establish cloud-provider behavior,
real recovery objectives, or production traffic safety.

**How to apply:** Preserve the distinction in future evidence updates; add
deployment drill artifacts rather than weakening static gates or fabricating
runtime measurements.
