import "server-only";

import { db } from "@/lib/db/client";
import { closeOpenSessions, startSession } from "@/lib/db/queries";
import type { Level, User } from "@/lib/db/types";
import { openingTurn } from "@/lib/modes";
import { esc } from "@/lib/telegram/client";
import { formatTutorReply } from "@/lib/telegram/format";

/** Phases not built yet: say so plainly instead of failing silently. */
const NOT_READY: Record<string, string> = {
  review: "Spaced review isn't wired up yet — it's next. Use /chat for now.",
  drill: "Voice drills need the audio layer, which is the last piece. Soon.",
  listen: "Listening exercises need the audio layer too. Coming.",
  quick: "Quick mode arrives with the streak system. Use /chat meanwhile.",
  streak: "Streak tracking is being built right now. Almost there.",
  schedule: "Scheduling arrives with the reminder system.",
  pause: "Nothing to pause yet — I'm not sending reminders so far.",
  practice: "Automatic mode selection comes with the reminder system. Use /chat.",
};

const LEVELS: Record<string, Level> = {
  beginner: "principiante",
  principiante: "principiante",
  intermediate: "intermedio",
  intermedio: "intermedio",
  advanced: "avanzado",
  avanzado: "avanzado",
};

const LEVEL_NAME: Record<Level, string> = {
  principiante: "beginner",
  intermedio: "intermediate",
  avanzado: "advanced",
};

export interface CommandResult {
  text: string;
}

/** Returns `null` when the text isn't a command and should be treated as conversation. */
export async function handleCommand(user: User, text: string): Promise<CommandResult | null> {
  if (!text.startsWith("/")) return null;

  const [raw, ...args] = text.slice(1).split(/\s+/);
  const command = raw.split("@")[0].toLowerCase();

  switch (command) {
    case "start":
      return { text: welcome(user) };

    case "chat":
      return { text: await startConversation(user) };

    case "level":
      return { text: await changeLevel(user, args[0]) };

    case "mistakes":
      return { text: await listMistakes(user) };

    case "vocab":
      return { text: await listVocabulary(user) };

    default:
      return {
        text:
          NOT_READY[command] ??
          "I don't know that one. Try /chat to start talking, or /mistakes to see what you're working on.",
      };
  }
}

function welcome(user: User): string {
  return [
    `Hey${user.nombre ? ` ${esc(user.nombre)}` : ""} — I'm your English coach.`,
    "",
    "Here's the deal: I don't wait for you to feel motivated. I'll message you, " +
      "we'll practice, and I'll keep track of every mistake you make so we can " +
      "hunt it down later instead of letting it calcify.",
    "",
    `You're set to <b>${LEVEL_NAME[user.nivel]}</b>. Change it with ` +
      "<code>/level beginner</code>, <code>/level intermediate</code> or " +
      "<code>/level advanced</code>.",
    "",
    "Send /chat and let's start, or just write me something.",
  ].join("\n");
}

async function startConversation(user: User): Promise<string> {
  const session = await startSession(user.id, "free_conversation");
  const reply = await openingTurn(
    user,
    session,
    "Open the conversation. Bring a topic yourself — something you're actually " +
      "curious about, ideally connected to what you know about them. One or two " +
      "sentences, then a question that's easy to answer but hard to answer in " +
      "one word.",
  );
  return formatTutorReply(reply);
}

async function changeLevel(user: User, arg?: string): Promise<string> {
  if (!arg) {
    return (
      `You're on <b>${LEVEL_NAME[user.nivel]}</b>.\n\n` +
      "To change: <code>/level beginner</code>, <code>/level intermediate</code> " +
      "or <code>/level advanced</code>."
    );
  }

  const level = LEVELS[arg.toLowerCase()];
  if (!level) {
    return "That's not a level I know. Pick <code>beginner</code>, <code>intermediate</code> or <code>advanced</code>.";
  }

  await db().from("usuarios").update({ nivel: level }).eq("id", user.id);
  // Level changes the system prompt, so the in-flight session is no longer coherent.
  await closeOpenSessions(user.id);

  return `Done — <b>${LEVEL_NAME[level]}</b> from now on. I'll adjust how I talk to you. Send /chat when you're ready.`;
}

async function listMistakes(user: User): Promise<string> {
  const { data } = await db()
    .from("errores")
    .select("patron, correccion, frecuencia, nivel_dominio")
    .eq("usuario_id", user.id)
    .eq("estado", "activo")
    .order("frecuencia", { ascending: false })
    .limit(10);

  if (!data?.length) {
    return "Nothing on the list yet. Talk to me for a while and it'll fill up — it always does.";
  }

  const lines = data.map((m) => {
    const bar = "●".repeat(m.nivel_dominio) + "○".repeat(5 - m.nivel_dominio);
    const times = m.frecuencia > 1 ? ` ×${m.frecuencia}` : "";
    return `${bar}  ${esc(m.patron)}${times}\n     → <b>${esc(m.correccion)}</b>`;
  });

  return `📝 <b>What you're working on</b>\n\n${lines.join("\n\n")}`;
}

async function listVocabulary(user: User): Promise<string> {
  const { data } = await db()
    .from("vocabulario")
    .select("termino, ejemplo_en, nivel_dominio")
    .eq("usuario_id", user.id)
    .eq("estado", "activo")
    .order("introducido_en", { ascending: false })
    .limit(15);

  if (!data?.length) {
    return "No vocabulary saved yet. It builds up as we talk.";
  }

  const lines = data.map((v) => {
    const bar = "●".repeat(v.nivel_dominio) + "○".repeat(5 - v.nivel_dominio);
    return `${bar}  <b>${esc(v.termino)}</b>\n     <i>${esc(v.ejemplo_en ?? "")}</i>`;
  });

  return `💡 <b>Your vocabulary</b>\n\n${lines.join("\n\n")}`;
}
