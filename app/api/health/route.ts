import { NextResponse } from "next/server";

import { db } from "@/lib/db/client";

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

  return NextResponse.json({ ok, tables }, { status: ok ? 200 : 500 });
}
