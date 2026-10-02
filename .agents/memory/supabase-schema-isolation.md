---
name: Supabase schema isolation
description: Environment-specific guidance for Drizzle schema operations in this workspace.
---

When the database includes provider-managed schemas such as `auth`, `realtime`, `storage`, or `vault`, Drizzle schema operations must be scoped to the application's `public` schema.

**Why:** Unscoped introspection treats provider-owned tables as rename candidates for application tables and can block a non-destructive development schema setup.

**How to apply:** Keep the Drizzle config's public-only schema filter in place. Never use a force push against this database just to bypass the provider-schema conflict; inspect the diff and apply only authorized additive changes.