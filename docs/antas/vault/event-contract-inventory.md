# Vault event contract inventory

| Event | Producer | Payload policy | Consumers |
| --- | --- | --- | --- |
| vault.secret.updated | Vault application | secret id/version/operation only | event bus consumers |
| vault.secret.accessed | Vault application | secret id/version only | audit/observability consumers |

Secret plaintext, ciphertext, keys, and reveal tokens are forbidden in event
payloads, logs, and evidence.
