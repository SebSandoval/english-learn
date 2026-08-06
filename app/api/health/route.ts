import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

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

/** Verifies that Supabase is reachable and the schema is applied. */
export async function GET() {
  const supabase = db();
  const tables: Record<string, string> = {};
  let ok = true;

  for (const table of TABLES) {
    const { error } = await supabase.from(table).select("*", { count: "exact", head: true });
    if (error) {
      ok = false;
      tables[table] = `error: ${error.message}`;
    } else {
      tables[table] = "ok";
    }
  }

  const { error: viewError } = await supabase
    .from("srs_pendientes")
    .select("*", { count: "exact", head: true });
  tables["srs_pendientes (view)"] = viewError ? `error: ${viewError.message}` : "ok";
  if (viewError) ok = false;

  return NextResponse.json({ ok, tables, config: configured() }, { status: ok ? 200 : 500 });
}

/**
 * Which optional variables are present, as booleans only.
 *
 * A missing secret and a mismatched secret both surface as 401 at the endpoints
 * that use them, which makes deploys impossible to debug from outside. This
 * distinguishes the two without ever revealing a value.
 */
function configured(): Record<string, boolean | string | number> {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    telegram_token: Boolean(env.TELEGRAM_BOT_TOKEN),
    telegram_webhook_secret: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
    cron_secret: Boolean(env.CRON_SECRET),
    // Enough to compare two environments; far too little to reconstruct.
    cron_secret_len: env.CRON_SECRET?.length ?? 0,
    groq: Boolean(env.GROQ_API_KEY),
    google_tts: Boolean(env.GOOGLE_TTS_API_KEY),
    model: env.OPENROUTER_MODEL,
  };
}
