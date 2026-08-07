import "server-only";

import { voiceCapabilities } from "@/lib/audio";
import { db } from "@/lib/db/client";
import { closeOpenSessions, openSession, startSession } from "@/lib/db/queries";
import type { Level, PracticeMode, Session, User } from "@/lib/db/types";
import { buildProgress } from "@/lib/engagement/progress";
import { markNudgeAnswered, masteredCount, readStreak } from "@/lib/engagement/streak";
import type { TutorReply } from "@/lib/llm/schemas";
import { openingTurn } from "@/lib/modes";
import { chooseMode } from "@/lib/modes/selector";
import { DRILL_OPENING, LISTENING_OPENING } from "@/lib/modes/voice";
import { openingInstruction, readContext, startReview } from "@/lib/modes/spaced-review";
import { esc } from "@/lib/telegram/client";

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

/**
 * A command either answers with plain text, or opens a session and hands back
 * the tutor's first turn.
 *
 * The distinction exists because of voice: a turn in a spoken mode has to be
 * synthesized and sent as a voice note, and only the caller knows how to do
 * that. Formatting it to a string here would make it unspeakable.
 */
export type CommandResult =
  | { kind: "text"; text: string }
  | { kind: "turn"; mode: PracticeMode; reply: TutorReply };

const text = (value: string): CommandResult => ({ kind: "text", text: value });
const turn = (session: Session, reply: TutorReply): CommandResult => ({
  kind: "turn",
  mode: session.modo,
  reply,
});

/** Returns `null` when the text isn't a command and should be treated as conversation. */
export async function handleCommand(user: User, input: string): Promise<CommandResult | null> {
  if (!input.startsWith("/")) return null;

  const [raw, ...args] = input.slice(1).split(/\s+/);
  const command = raw.split("@")[0].toLowerCase();

  switch (command) {
    case "start":
      return text(welcome(user));

    // Reaching here means the code was already accepted upstream and the user
    // exists — otherwise the gate answered and this never ran. Welcoming them
    // beats "I don't know that one" on their very first message.
    case "invite":
      return text(welcome(user));

    case "chat":
      return startConversation(user);

    case "level":
      return text(await changeLevel(user, args[0]));

    case "mistakes":
      return text(await listMistakes(user));

    case "vocab":
      return text(await listVocabulary(user));

    case "review":
      return startReviewSession(user);

    case "drill":
      return startVoiceMode(user, "voice_drill");

    case "listen":
      return startVoiceMode(user, "listening");

    case "streak":
      return text(await showStreak(user));

    case "progress":
      return text(await showProgress(user));

    case "practice":
      return startPractice(user, false);

    case "quick":
      return startPractice(user, true);

    case "schedule":
      return text(await changeSchedule(user, args));

    case "pause":
      return text(await togglePause(user, args[0]));

    case "resume":
      return text(await togglePause(user, "off"));

    default:
      return text(
        "I don't know that one. Try /chat to start talking, or /mistakes to see what you're working on.",
      );
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
    "Send /chat and let's start, or just write me something. Send me a voice " +
      "note any time and I'll answer out loud — or use /drill to speak on demand " +
      "and /listen to train your ear.",
  ].join("\n");
}

async function startConversation(user: User): Promise<CommandResult> {
  const session = await startSession(user.id, "free_conversation");
  const reply = await openingTurn(
    user,
    session,
    "Open the conversation. Bring a topic yourself — something you're actually " +
      "curious about, ideally connected to what you know about them. One or two " +
      "sentences, then a question that's easy to answer but hard to answer in " +
      "one word.",
  );
  return turn(session, reply);
}

/**
 * `/drill` and `/listen`. Both refuse rather than degrade: a voice drill
 * answered in writing is just a slower conversation, and a listening exercise
 * delivered as text is a reading exercise.
 */
async function startVoiceMode(user: User, mode: "voice_drill" | "listening"): Promise<CommandResult> {
  const { listen, speak } = voiceCapabilities();

  if (!speak) {
    return text(
      "I can't speak yet — the text-to-speech key isn't configured on my side. " +
        "Send /chat and we'll practise in writing.",
    );
  }
  if (mode === "voice_drill" && !listen) {
    return text(
      "I can talk but I can't listen yet — the transcription key isn't configured. " +
        "Try /listen instead, that one only needs my voice.",
    );
  }

  const session = await startSession(user.id, mode);
  const reply = await openingTurn(
    user,
    session,
    mode === "voice_drill" ? DRILL_OPENING : LISTENING_OPENING,
  );
  return turn(session, reply);
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

async function startReviewSession(user: User): Promise<CommandResult> {
  const started = await startReview(user);

  if (!started) {
    const upcoming = await nextDueDate(user.id);
    return text(
      upcoming
        ? `Nothing due today — your next review lands on <b>${upcoming}</b>. ` +
            "Spacing them out is the point; cramming today would undo it. Send /chat instead."
        : "Nothing to review yet. Talk to me for a while and I'll collect the things " +
            "you get wrong — those become your review deck.",
    );
  }

  const reply = await openingTurn(
    user,
    started.session,
    openingInstruction(started.context),
  );
  return turn(started.session, reply);
}

async function nextDueDate(userId: string): Promise<string | null> {
  const { data } = await db()
    .from("srs_pendientes")
    .select("proxima_revision")
    .eq("usuario_id", userId)
    .order("proxima_revision", { ascending: true })
    .limit(1)
    .maybeSingle();

  return data?.proxima_revision ?? null;
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

/**
 * `/progress` — the answer to "am I getting better?", which `/streak` cannot
 * give: showing up and improving are different things.
 *
 * Every number here is stated with its sample size. "73%" on its own invites
 * belief it hasn't earned, and the whole point of the command is that the
 * student can trust it.
 */
async function showProgress(user: User): Promise<string> {
  const p = await buildProgress(user);

  if (!p.recent) {
    return p.totalReviews > 0
      ? `Only ${p.totalReviews} graded answer${p.totalReviews === 1 ? "" : "s"} so far — ` +
          "not enough to tell you anything honest yet. Do a few rounds of /review and ask me again."
      : "No reviews graded yet, so there's nothing to measure. Talk to me for a while, " +
          "then /review turns what you get wrong into the deck this tracks.";
  }

  const lines = [
    "📈 <b>Progress</b>",
    "",
    `Last ${p.recent.total} reviews: <b>${p.recent.right} right (${p.recent.percent}%)</b>`,
  ];

  if (p.previous) {
    const delta = p.recent.percent - p.previous.percent;
    const verdict =
      Math.abs(delta) < 5
        ? "about the same — steady"
        : delta > 0
          ? `up ${delta} points`
          : `down ${Math.abs(delta)} points`;

    lines.push(
      `The ${p.previous.total} before that: ${p.previous.right} right (${p.previous.percent}%)`,
      `<i>${verdict}</i>`,
    );
  } else {
    lines.push("<i>Not enough history yet to compare against.</i>");
  }

  const { mistakes, vocab, avgDaysToMaster } = p.mastered;
  if (mistakes || vocab) {
    const parts = [
      mistakes ? `${mistakes} mistake${mistakes === 1 ? "" : "s"}` : null,
      vocab ? `${vocab} word${vocab === 1 ? "" : "s"}` : null,
    ].filter(Boolean);

    lines.push("", `✓ <b>Retired for good:</b> ${parts.join(", ")}`);
    if (avgDaysToMaster !== null) {
      lines.push(`   Took about ${avgDaysToMaster} days each.`);
    }
  }

  if (p.stubborn.length) {
    lines.push("", "<b>Still fighting you</b>");
    for (const s of p.stubborn) {
      const bar = "●".repeat(s.mastery) + "○".repeat(5 - s.mastery);
      lines.push(`${bar}  ${esc(s.pattern)} ×${s.frequency}`);
    }
  }

  return lines.join("\n");
}

const QUICK_INSTRUCTION =
  "Open a two-minute session. One single question they can answer in one short " +
  "message. Say up front that this is the quick version and that it counts. " +
  "Two sentences, no more.";

/** `/practice` picks the mode for you; `/quick` forces the two-minute version. */
async function startPractice(user: User, quick: boolean): Promise<CommandResult> {
  const choice = await chooseMode(user);

  // Review needs its queue built before the session exists; delegate rather
  // than opening an empty spaced_review session here.
  if (choice.mode === "spaced_review" && !quick) {
    return startReviewSession(user);
  }

  const session = await startSession(user.id, choice.mode, { quick_mode: quick });

  return turn(session, await openingTurn(user, session, quick ? QUICK_INSTRUCTION : openingFor(choice.mode)));
}

/**
 * The button on a reminder, taken.
 *
 * The reminder already opened a session in the mode it proposed, with the
 * review queue built when that was the mode — so we continue in it instead of
 * starting over. Calling `/practice` here would close that session, re-score
 * the modes, and lose both the queue and the link back to the `nudges` row that
 * tells us which tones actually get answered.
 */
export async function startFromNudge(user: User, quick: boolean): Promise<CommandResult> {
  const session = await openSession(user.id);
  if (!session) return startPractice(user, quick);

  await markNudgeAnswered(session.id).catch(() => {});

  // A review queue outranks the quick version: the exercises are already
  // chosen, and there is no shorter way to do five of them than to do them.
  const review = readContext(session);
  const instruction = review
    ? openingInstruction(review)
    : quick
      ? QUICK_INSTRUCTION
      : openingFor(session.modo);

  return turn(session, await openingTurn(user, session, instruction));
}

function openingFor(mode: PracticeMode): string {
  if (mode === "voice_drill") return DRILL_OPENING;
  if (mode === "listening") return LISTENING_OPENING;

  return (
    "Open the session. Bring the topic yourself, and end with something easy to " +
    "reply to but impossible to answer in one word."
  );
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
