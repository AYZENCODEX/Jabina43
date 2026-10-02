---
name: Imported workspace startup
description: Startup prerequisites for this imported pnpm workspace.
---

Imported workspace previews need the committed pnpm lockfile installed before
the generated API build can resolve workspace tooling. The API also fails
closed when required vault encryption secrets are absent, so preview startup
depends on the workspace secret manager rather than local fallback values.

**Why:** An imported checkout may not include `node_modules`, and the server
intentionally refuses to start without encryption keys that protect stored
credentials.

**How to apply:** Install with the frozen lockfile, then restart the existing
application workflow after required secrets are available. Never replace
missing encryption secrets with placeholders.