# Vault compatibility freeze

## Frozen

- Existing API route paths, methods, middleware order, response/status mapping,
  error codes, tenant predicates, event names, and encrypted envelope fields.
- Existing database table names, migration history, retention behavior,
  transaction semantics, key configuration names, and step-up purpose.
- Existing crypto format remains AES-256-GCM with base64url `ciphertext`,
  `iv`, and `tag` fields. This document contains no key material.

## Review rule

Any change to a public contract requires an explicit compatibility adapter and
fixture update. Modularization is not permission to redesign behavior.
