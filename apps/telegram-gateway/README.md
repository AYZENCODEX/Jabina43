# AYZEN Telegram Gateway

This is the shared transport boundary for the eight named bots: AYZENX, WARDE,
VERVE, RYFT, SYLO, SKARN, ZYNTH, and WISP.

It validates the registered bot key, Telegram's webhook secret, and update
shape, then forwards the update to `TELEGRAM_HANDLER_URL` (defaulting to the
compatibility monolith). Durable update-id claiming and domain dispatch remain
in the handler so multiple gateway instances do not rely on process-local
memory.

Configure each bot's webhook secret through the environment. Never put bot
tokens or webhook secrets in source, logs, or route responses.