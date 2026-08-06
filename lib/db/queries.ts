import "server-only";

import { db } from "@/lib/db/client";
import type { Message, PracticeMode, Session, User } from "@/lib/db/types";
import { slugKey, type Correction, type NewVocab } from "@/lib/llm/schemas";

/** Turns sent verbatim to the LLM. Anything older lives in sesiones.resumen. */
export const MESSAGE_WINDOW = 12;
/** Past this point, older turns get compressed into the summary. */
export const SUMMARY_THRESHOLD = 24;

// ──────────────────────────── USERS ─────────────────────────────

export async function findUserByChat(chatId: number): Promise<User | null> {
  const { data } = await db()
    .from("usuarios")
    .select("*")
    .eq("telegram_chat_id", chatId)
    .maybeSingle();
  return data;
}

export async function createUser(chatId: number, name?: string): Promise<User> {
  const supabase = db();

  const { data, error } = await supabase
    .from("usuarios")
    .insert({ telegram_chat_id: chatId, nombre: name ?? null })
    .select()
    .single();

  if (error) throw new Error(`Could not create user: ${error.message}`);

  // The streak row is born with the user, so no code path has to check whether
  // it exists first.
  await supabase.from("racha").insert({ usuario_id: data.id });

  return data;
}

export async function getOrCreateUser(chatId: number, name?: string): Promise<User> {
  return (await findUserByChat(chatId)) ?? (await createUser(chatId, name));
}

// ─────────────────────────── SESSIONS ───────────────────────────

export async function openSession(userId: string): Promise<Session | null> {
  const { data } = await db()
    .from("sesiones")
    .select("*")
    .eq("usuario_id", userId)
    .eq("completada", false)
    .maybeSingle();
  return data;
}

export async function startSession(
  userId: string,
  mode: PracticeMode,
  context: Record<string, unknown> = {},
): Promise<Session> {
  // The partial unique index enforces one open session; we close the previous
  // one first rather than letting the insert fail.
  await closeOpenSessions(userId);

  const { data, error } = await db()
    .from("sesiones")
    .insert({ usuario_id: userId, modo: mode, contexto: context })
    .select()
    .single();

  if (error) throw new Error(`Could not start session: ${error.message}`);
  return data;
}

export async function closeOpenSessions(userId: string): Promise<void> {
  await db()
    .from("sesiones")
    .update({ completada: true, finalizada_en: new Date().toISOString() })
    .eq("usuario_id", userId)
    .eq("completada", false);
}

export async function updateSessionContext(
  sessionId: string,
  context: Record<string, unknown>,
): Promise<void> {
  await db().from("sesiones").update({ contexto: context }).eq("id", sessionId);
}

/** The open session if there is one, otherwise a fresh one in the given mode. */
export async function activeSession(
  userId: string,
  defaultMode: PracticeMode,
): Promise<Session> {
  return (await openSession(userId)) ?? (await startSession(userId, defaultMode));
}

// ─────────────────────────── MESSAGES ───────────────────────────

export async function saveMessage(
  sessionId: string,
  role: "user" | "assistant",
  content: string,
  extra: { wasAudio?: boolean; audioPath?: string } = {},
): Promise<void> {
  await db().from("mensajes").insert({
    sesion_id: sessionId,
    rol: role,
    contenido: content,
    fue_audio: extra.wasAudio ?? false,
    audio_path: extra.audioPath ?? null,
  });
}

/** The last N turns, in chronological order. */
export async function recentHistory(
  sessionId: string,
  limit = MESSAGE_WINDOW,
): Promise<Message[]> {
  const { data } = await db()
    .from("mensajes")
    .select("*")
    .eq("sesion_id", sessionId)
    .order("created_at", { ascending: false })
    .limit(limit);

  return (data ?? []).reverse();
}

export async function countMessages(sessionId: string): Promise<number> {
  const { count } = await db()
    .from("mensajes")
    .select("*", { count: "exact", head: true })
    .eq("sesion_id", sessionId);
  return count ?? 0;
}

/** The most recent summary from an already-closed session. */
export async function latestSummary(userId: string): Promise<string | null> {
  const { data } = await db()
    .from("sesiones")
    .select("resumen")
    .eq("usuario_id", userId)
    .eq("completada", true)
    .not("resumen", "is", null)
    .order("iniciada_en", { ascending: false })
    .limit(1)
    .maybeSingle();

  return data?.resumen ?? null;
}

export async function saveSummary(sessionId: string, summary: string): Promise<void> {
  await db().from("sesiones").update({ resumen: summary }).eq("id", sessionId);
}

// ───────────────────── MISTAKES AND VOCABULARY ───────────────────

/**
 * Records corrections, deduplicating by slug key.
 *
 * If the pattern already exists we bump its frequency and reactivate it: a
 * mistake that resurfaces is a mistake that wasn't mastered, and it belongs
 * back in today's review queue.
 */
export async function recordCorrections(
  userId: string,
  corrections: Correction[],
): Promise<void> {
  if (!corrections.length) return;

  const supabase = db();
  const today = new Date().toISOString().slice(0, 10);

  for (const c of corrections) {
    const key = slugKey(c.pattern);

    const { data: existing } = await supabase
      .from("errores")
      .select("id, frecuencia")
      .eq("usuario_id", userId)
      .eq("clave", key)
      .maybeSingle();

    if (existing) {
      await supabase
        .from("errores")
        .update({
          frecuencia: existing.frecuencia + 1,
          ultima_deteccion: new Date().toISOString(),
          estado: "activo",
          nivel_dominio: 0,
          repeticiones: 0,
          intervalo_dias: 1,
          proxima_revision: today,
        })
        .eq("id", existing.id);
    } else {
      await supabase.from("errores").insert({
        usuario_id: userId,
        tipo: c.type,
        patron: c.pattern,
        clave: key,
        ejemplo_incorrecto: c.wrong_example,
        correccion: c.correction,
        explicacion: c.explanation ?? null,
      });
    }
  }
}

export async function recordVocabulary(
  userId: string,
  sessionId: string,
  vocab: NewVocab[],
): Promise<void> {
  if (!vocab.length) return;

  const rows = vocab.map((v) => ({
    usuario_id: userId,
    termino: v.term,
    clave: slugKey(v.term),
    tipo: v.type,
    significado_es: v.meaning_es ?? null,
    ejemplo_en: v.example_en,
    sesion_origen: sessionId,
  }));

  // If they already knew it, don't reintroduce it or reset its SM-2 progress.
  await db().from("vocabulario").upsert(rows, {
    onConflict: "usuario_id,clave",
    ignoreDuplicates: true,
  });
}
