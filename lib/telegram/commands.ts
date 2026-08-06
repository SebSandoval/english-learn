import "server-only";

import { db } from "@/lib/db/client";
import { closeOpenSessions, startSession } from "@/lib/db/queries";
import type { Level, User } from "@/lib/db/types";
import { masteredCount, readStreak } from "@/lib/engagement/streak";
import { openingTurn } from "@/lib/modes";
import { chooseMode } from "@/lib/modes/selector";
import { esc } from "@/lib/telegram/client";
import { formatTutorReply } from "@/lib/telegram/format";

/** Phases not built yet: say so plainly instead of failing silently. */
const NOT_READY: Record<string, string> = {
  review: "Spaced review isn't wired up yet — it's next. Use /chat for now.",
  drill: "Voice drills need the audio layer, which is the last piece. Soon.",
  listen: "Listening exercises need the audio layer too. Coming.",
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

    case "streak":
      return { text: await showStreak(user) };

    case "practice":
      return { text: await startPractice(user, false) };

    case "quick":
      return { text: await startPractice(user, true) };

    case "schedule":
      return { text: await changeSchedule(user, args) };

    case "pause":
      return { text: await togglePause(user, args[0]) };

    case "resume":
      return { text: await togglePause(user, "off") };

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

async function showStreak(user: User): Promise<string> {
  const [streak, mastered] = await Promise.all([readStreak(user), masteredCount(user.id)]);

  if (streak.totalSessions === 0) {
    return "No streak yet — it starts the first day you practice. Send /chat.";
  }

  const lines = [
    streak.current > 0
      ? `🔥 <b>${streak.current} day${streak.current === 1 ? "" : "s"}</b> running`
      : "Streak's at zero right now — one session today restarts it.",
    `Best ever: <b>${streak.best}</b>  ·  Sessions: <b>${streak.totalSessions}</b>`,
  ];

  if (mastered > 0) {
    lines.push(`Fully mastered: <b>${mastered}</b> item${mastered === 1 ? "" : "s"}`);
  }
  if (streak.daysSince === 0) lines.push("\nAlready practised today. ✅");

  return lines.join("\n");
}

/** `/practice` picks the mode for you; `/quick` forces the two-minute version. */
async function startPractice(user: User, quick: boolean): Promise<string> {
  const choice = await chooseMode(user);
  const session = await startSession(user.id, choice.mode, { quick_mode: quick });

  const instruction = quick
    ? "Open a two-minute session. One single question they can answer in one short " +
      "message. Say up front that this is the quick version and that it counts. " +
      "Two sentences, no more."
    : "Open the session. Bring the topic yourself, and end with something easy to " +
      "reply to but impossible to answer in one word.";

  return formatTutorReply(await openingTurn(user, session, instruction));
}

async function changeSchedule(user: User, args: string[]): Promise<string> {
  const range = args.join(" ").match(/(\d{1,2}):?(\d{2})?\s*(?:-|to|–)\s*(\d{1,2}):?(\d{2})?/);

  if (!range) {
    return (
      `I contact you between <b>${user.ventana_inicio.slice(0, 5)}</b> and ` +
      `<b>${user.ventana_fin.slice(0, 5)}</b> (${user.zona_horaria}).\n\n` +
      "To change it: <code>/schedule 19:00-21:30</code>\n" +
      "It's a window, not an exact time — I'll show up somewhere inside it."
    );
  }

  const pad = (h: string, m?: string) => `${h.padStart(2, "0")}:${(m ?? "00").padStart(2, "0")}`;
  const start = pad(range[1], range[2]);
  const end = pad(range[3], range[4]);

  if (Number(range[1]) > 23 || Number(range[3]) > 23) {
    return "Those aren't real hours. Try something like <code>/schedule 19:00-21:30</code>.";
  }

  await db()
    .from("usuarios")
    .update({ ventana_inicio: start, ventana_fin: end })
    .eq("id", user.id);

  return `Done — I'll reach out between <b>${start}</b> and <b>${end}</b>.`;
}

async function togglePause(user: User, arg?: string): Promise<string> {
  const resuming = arg === "off" || arg === "resume";

  await db().from("usuarios").update({ activo: resuming }).eq("id", user.id);

  return resuming
    ? "Reminders back on. I'll bother you again — that's the point."
    : "Reminders off. You can still message me any time, and your streak keeps its " +
        "record. Send /resume when you want me back.";
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
