# Vault module ownership

| Module | Sole owner | Forbidden responsibility |
| --- | --- | --- |
| Entity | entity domain/application | crypto key handling |
| Local Account | account domain/application | KYC policy |
| KYC | KYC domain/application | raw secret reveal |
| Game | game domain/application | provider implementation |
| Secret/Core Vault | secret domain/application | direct route parsing |
| Access/Security | access policy | persistence |
| Crypto | crypto boundary | business decisions |
| Backup/Snapshot | recovery application | frontend state |
| API adapters | route layer | duplicate orchestration |

One source of truth is selected for each behavior. Compatibility adapters are
allowed while consumer proof is being collected.
