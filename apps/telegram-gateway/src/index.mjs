import { createServiceServer } from "@ayzen/service-runtime";
import { getBotDescriptor, normalizeTelegramUpdate, normalizeTelegramMessage, verifyWebhookSecret } from "@ayzen/telegram";
import { listTelegramCommands } from "@ayzen/capabilities";

const handlerBaseUrl = (process.env.TELEGRAM_HANDLER_URL ?? "http://127.0.0.1:8080/api/telegram/gateway").replace(/\/+$/, "");
const claimedUpdates = new Map();
const failedUpdates = new Map();
let receivedUpdates = 0;
let forwardedUpdates = 0;

async function readJson(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > 1_048_576) throw Object.assign(new Error("Telegram update is too large"), { code: "TELEGRAM_UPDATE_TOO_LARGE" });
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Telegram update is not valid JSON"), { code: "INVALID_TELEGRAM_UPDATE" });
  }
}

async function handle({ req, url }) {
  const match = url.pathname.match(/^\/api\/telegram\/gateway\/([a-z0-9-]+)\/webhook$/);
  if (req.method === "GET" && url.pathname === "/api/telegram/gateway/failures") {
    // Operational data: require TELEGRAM_GATEWAY_ADMIN_TOKEN as a bearer token.
    // Unset (or shorter than 16 chars) = endpoint disabled, never open.
    const bearer = String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!verifyWebhookSecret(process.env.TELEGRAM_GATEWAY_ADMIN_TOKEN, bearer)) {
      return { status: 401, body: { error: "Unauthorized", code: "TELEGRAM_GATEWAY_ADMIN_TOKEN_REQUIRED" } };
    }
    return { status: 200, body: { items: [...failedUpdates.entries()].map(([receiptKey, value]) => ({ receiptKey, ...value })) } };
  }
  if (req.method !== "POST" || !match) return { status: 404, body: { error: "Route not found" } };
  const botKey = match[1];
  const descriptor = getBotDescriptor(botKey);
  if (!descriptor) return { status: 404, body: { error: "Unknown Telegram bot", code: "UNKNOWN_TELEGRAM_BOT" } };
  const configuredSecret = process.env[descriptor.secretEnv];
  if (!configuredSecret) return { status: 503, body: { error: "Telegram webhook is not configured", code: "TELEGRAM_GATEWAY_NOT_CONFIGURED" } };
  const providedSecret = req.headers["x-telegram-bot-api-secret-token"];
  if (!verifyWebhookSecret(configuredSecret, providedSecret)) {
    return { status: 401, body: { error: "Invalid Telegram webhook secret", code: "INVALID_TELEGRAM_WEBHOOK" } };
  }
  const payload = await readJson(req);
  const envelope = normalizeTelegramUpdate(botKey, payload);
  if (!envelope) return { status: 400, body: { error: "Invalid Telegram update", code: "INVALID_TELEGRAM_UPDATE" } };
  receivedUpdates += 1;
  const receiptKey = `${botKey}:${envelope.updateId}`;
  const existing = claimedUpdates.get(receiptKey);
  if (existing?.status === "forwarded") return { status: 200, body: { ok: true, duplicate: true, updateId: envelope.updateId } };
  if (existing?.status === "inflight") return { status: 202, body: { ok: true, accepted: true, updateId: envelope.updateId } };
  claimedUpdates.set(receiptKey, { status: "inflight", createdAt: Date.now() });
  while (claimedUpdates.size > 10_000) claimedUpdates.delete(claimedUpdates.keys().next().value);

  // Durable claiming and domain dispatch stay in the existing API handler.
  // This process owns only transport validation and forwarding.
  try {
    const message = normalizeTelegramMessage(envelope);
    const response = await fetch(`${handlerBaseUrl}/${botKey}/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-telegram-bot-api-secret-token": providedSecret,
        "x-ayzen-telegram-gateway": "telegram-gateway",
        "x-telegram-bot-key": botKey,
        "x-telegram-update-id": String(envelope.updateId),
        ...(message?.command ? { "x-telegram-command": message.command } : {}),
        ...(message?.capability?.capability ? { "x-ayzen-capability": message.capability.capability } : {}),
      },
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({ error: "Telegram handler returned an invalid response" }));
    if (!response.ok) {
      claimedUpdates.delete(receiptKey);
      failedUpdates.set(receiptKey, { status: response.status, at: new Date().toISOString() });
    } else {
      claimedUpdates.set(receiptKey, { status: "forwarded", createdAt: Date.now() });
      failedUpdates.delete(receiptKey);
      forwardedUpdates += 1;
    }
    return { status: response.status, body };
  } catch (error) {
    claimedUpdates.delete(receiptKey);
    failedUpdates.set(receiptKey, { status: 502, code: error?.code ?? "TELEGRAM_FORWARD_FAILED", at: new Date().toISOString() });
    return { status: 502, body: { error: "Telegram update forwarding failed", code: "TELEGRAM_FORWARD_FAILED" } };
  }
}

createServiceServer({
  service: "telegram-gateway",
  displayName: "Telegram Gateway",
  port: Number(process.env.PORT ?? 8090),
  routePrefixes: ["/api/telegram"],
  handle,
  dependencies: { handlerConfiguration: Boolean(process.env.TELEGRAM_HANDLER_URL) },
}).start();

setInterval(() => {
  const cutoff = Date.now() - 24 * 60 * 60 * 1_000;
  for (const [key, value] of claimedUpdates) if (value.createdAt < cutoff) claimedUpdates.delete(key);
  while (failedUpdates.size > 10_000) failedUpdates.delete(failedUpdates.keys().next().value);
  console.log(JSON.stringify({
    timestamp: new Date().toISOString(),
    service: "telegram-gateway",
    event: "telegram.gateway.metrics",
    received_updates: receivedUpdates,
    forwarded_updates: forwardedUpdates,
    failed_updates: failedUpdates.size,
    registered_commands: listTelegramCommands().length,
  }));
}, 60_000).unref();