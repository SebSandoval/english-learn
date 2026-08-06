#!/usr/bin/env node
/**
 * Registers the Telegram webhook.
 *
 *   node scripts/set-webhook.mjs https://your-app.vercel.app
 *   node scripts/set-webhook.mjs --info      (inspect current state)
 *   node scripts/set-webhook.mjs --delete
 *
 * Reads TELEGRAM_BOT_TOKEN and TELEGRAM_WEBHOOK_SECRET from .env.local.
 */
import { readFileSync } from "node:fs";

function loadEnv() {
  try {
    for (const line of readFileSync(".env.local", "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m && !process.env[m[1]]) {
        process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
      }
    }
  } catch {
    console.error("Could not find .env.local");
    process.exit(1);
  }
}

loadEnv();

const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error("Missing TELEGRAM_BOT_TOKEN in .env.local");
  process.exit(1);
}

const api = (method, body) =>
  fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  }).then((r) => r.json());

const arg = process.argv[2];

if (arg === "--info") {
  console.log(JSON.stringify(await api("getWebhookInfo"), null, 2));
  process.exit(0);
}

if (arg === "--delete") {
  console.log(await api("deleteWebhook", { drop_pending_updates: true }));
  process.exit(0);
}

if (!arg?.startsWith("https://")) {
  console.error("Usage: node scripts/set-webhook.mjs https://your-app.vercel.app");
  process.exit(1);
}

const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
if (!secret) {
  console.error(
    "Missing TELEGRAM_WEBHOOK_SECRET in .env.local.\n" +
      "Generate one with:  openssl rand -hex 24",
  );
  process.exit(1);
}

const url = `${arg.replace(/\/$/, "")}/api/telegram/webhook`;
const res = await api("setWebhook", {
  url,
  secret_token: secret,
  allowed_updates: ["message"],
  drop_pending_updates: true,
});

console.log(res.ok ? `✅ Webhook set to ${url}` : `❌ ${JSON.stringify(res)}`);

const info = await api("getWebhookInfo");
console.log(JSON.stringify(info.result, null, 2));
