import { esc } from "@/lib/telegram/client";
import type { TutorReply } from "@/lib/llm/schemas";

const LABEL: Record<string, string> = {
  gramatica: "Grammar",
  vocabulario: "Word choice",
  pronunciacion: "Pronunciation",
  uso: "Usage",
};

/**
 * Turns the tutor's reply into the Telegram message.
 *
 * Conversation first, corrections after, kept apart: reading the exchange and
 * reading the feedback are two different acts. Mixing them breaks the flow,
 * which is exactly what we're training.
 */
export function formatTutorReply(r: TutorReply): string {
  const blocks = [esc(r.reply.trim())];

  if (r.corrections.length) {
    const items = r.corrections.map((c) => {
      const lines = [
        `<b>${LABEL[c.type] ?? c.type}</b>`,
        `❌ <s>${esc(c.wrong_example)}</s>`,
        `✅ <b>${esc(c.correction)}</b>`,
      ];
      if (c.explanation) lines.push(`<i>${esc(c.explanation)}</i>`);
      return lines.join("\n");
    });

    blocks.push(`━━━━━━━━━━\n📝 <b>Notes</b>\n\n${items.join("\n\n")}`);
  }

  if (r.new_vocab.length) {
    const items = r.new_vocab.map((v) => {
      const parts = [`<b>${esc(v.term)}</b>`];
      if (v.meaning_es) parts.push(` — ${esc(v.meaning_es)}`);
      return `${parts.join("")}\n<i>${esc(v.example_en)}</i>`;
    });

    blocks.push(`💡 <b>New for you</b>\n\n${items.join("\n\n")}`);
  }

  return blocks.join("\n\n");
}
