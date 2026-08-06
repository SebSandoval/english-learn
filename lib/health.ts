import "server-only";

import { createHash } from "node:crypto";

import { ttsProvider, voiceCapabilities } from "@/lib/audio";
import { db } from "@/lib/db/client";
import { env } from "@/lib/env";
import { implementedModes } from "@/lib/modes/selector";

/**
 * One health check, two audiences.
 *
 * `/api/health` returns the whole thing for debugging a deploy; `/status`
 * renders only `capabilities`, because "is it working?" and "why isn't it?"
 * are different questions and answering both at once serves neither.
 */

const TABLES = [
  "usuarios",
  "sesiones",
  "mensajes",
  "errores",
  "vocabulario",
  "revisiones",
  "racha",
  "nudges",
] as const;

export interface Capability {
  key: string;
  /** Named for what it does, not for the vendor behind it. */
  label: string;
  ready: boolean;
  detail: string;
}

export interface HealthReport {
  ok: boolean;
  checkedAt: string;
  tables: Record<string, string>;
  capabilities: Capability[];
  /** Deploy-debugging detail. Exposed by the JSON endpoint only. */
  diagnostics: Record<string, string | number | boolean>;
}

export async function checkHealth(): Promise<HealthReport> {
  const supabase = db();
  const tables: Record<string, string> = {};
  let schemaOk = true;

  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true });
    tables[table] = error ? `error: ${error.message}` : "ok";
    if (error) schemaOk = false;
  }

  const { error: viewError } = await supabase
    .from("srs_pendientes")
    .select("*", { count: "exact", head: true });
  tables["srs_pendientes (view)"] = viewError ? `error: ${viewError.message}` : "ok";
  if (viewError) schemaOk = false;

  const voice = voiceCapabilities();

  const capabilities: Capability[] = [
    {
      key: "memory",
      label: "Recordar tus errores",
      ready: schemaOk,
      detail: schemaOk
        ? "La base de datos responde y el esquema está aplicado."
        : "Alguna tabla no responde. Mira el detalle abajo.",
    },
    {
      key: "conversation",
      label: "Conversar",
      ready: Boolean(env.OPENROUTER_API_KEY),
      detail: Boolean(env.OPENROUTER_API_KEY)
        ? "Puede pensar respuestas y corregirte."
        : "Falta la clave del modelo: no puede responder.",
    },
    {
      key: "telegram",
      label: "Hablar por Telegram",
      ready: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET),
      detail: Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_WEBHOOK_SECRET)
        ? "Recibe y envía mensajes."
        : "Falta el token o el secreto del webhook.",
    },
    {
      key: "reminders",
      label: "Escribirte primero",
      ready: Boolean(env.CRON_SECRET),
      detail: Boolean(env.CRON_SECRET)
        ? "El recordatorio programado puede dispararse."
        : "Sin secreto de cron, nadie puede lanzar el recordatorio.",
    },
    {
      key: "listening",
      label: "Escucharte",
      ready: voice.listen,
      detail: voice.listen
        ? "Transcribe tus notas de voz."
        : "Sin transcripción: mándale texto.",
    },
    {
      key: "speaking",
      label: "Hablarte en voz alta",
      ready: voice.speak,
      detail: voice.speak
        ? "Puede contestarte con notas de voz."
        : "Sin síntesis: contesta solo por escrito.",
    },
  ];

  return {
    ok: schemaOk,
    checkedAt: new Date().toISOString(),
    tables,
    capabilities,
    diagnostics: {
      model: env.OPENROUTER_MODEL,
      model_fallback: env.OPENROUTER_MODEL_FALLBACK,
      tts_provider: ttsProvider()?.name ?? "none",
      voice_modes:
        implementedModes()
          .filter((m) => m === "voice_drill" || m === "listening")
          .join(",") || "none",
      // A missing secret and a mismatched secret both surface as 401 at the
      // endpoints that use them. These distinguish the two without ever
      // revealing a value: 12 hex chars of a SHA-256 digest is enough to prove
      // two environments hold the same string, useless for recovering it.
      cron_secret_len: env.CRON_SECRET?.length ?? 0,
      cron_secret_fp: fingerprint(env.CRON_SECRET),
    },
  };
}

function fingerprint(value?: string): string {
  if (!value) return "none";
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
