import { NextResponse } from "next/server";
import { z } from "zod";

import { denyUnauthorized } from "@/lib/admin-auth";
import { sttProvider, ttsProvider, voiceCapabilities } from "@/lib/audio";
import { speakable } from "@/lib/audio/speakable";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Anything longer is a bug in the caller, not a passage. */
const MAX_TEXT = 4500;

const ttsSchema = z.object({
  text: z.string().min(1).max(MAX_TEXT),
  /** 1 is the voice's natural pace. */
  rate: z.number().min(0.5).max(2).optional(),
});

/**
 * The audio layer, exercised directly.
 *
 * Telegram drives both providers through the webhook; this route exists so they
 * can be tested without a phone, and so a deploy can be checked in one curl:
 *
 *   curl -F audio=@note.ogg  $APP/api/voice
 *   curl -H 'content-type: application/json' -d '{"text":"hello"}' $APP/api/voice --output out.ogg
 */
export async function GET() {
  const caps = voiceCapabilities();
  return NextResponse.json({
    ...caps,
    stt: sttProvider()?.name ?? null,
    tts: ttsProvider()?.name ?? null,
  });
}

/**
 * Only POST is guarded. GET reports which providers are configured, which
 * `/api/health` already publishes by design, and it spends nothing.
 */
export async function POST(req: Request) {
  const denied = denyUnauthorized(req);
  if (denied) return denied;

  const contentType = req.headers.get("content-type") ?? "";

  try {
    return contentType.includes("multipart/form-data")
      ? await transcribe(req)
      : await synthesize(req);
  } catch (e) {
    console.error("[/api/voice]", e);
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "internal error" },
      { status: 500 },
    );
  }
}

/** multipart with an `audio` file → the transcript. */
async function transcribe(req: Request): Promise<Response> {
  const stt = sttProvider();
  if (!stt) return NextResponse.json({ error: "GROQ_API_KEY not configured" }, { status: 503 });

  const form = await req.formData();
  const file = form.get("audio");

  if (!(file instanceof File)) {
    return NextResponse.json({ error: "expected an `audio` file field" }, { status: 400 });
  }

  const transcript = await stt.transcribe({
    data: await file.arrayBuffer(),
    mimeType: file.type || "audio/ogg",
    filename: file.name,
  });

  return NextResponse.json({ ...transcript, provider: stt.name });
}

/** JSON `{ text }` → an Ogg/Opus body, the same bytes Telegram would receive. */
async function synthesize(req: Request): Promise<Response> {
  const tts = ttsProvider();
  if (!tts) {
    return NextResponse.json({ error: "GOOGLE_TTS_API_KEY not configured" }, { status: 503 });
  }

  const parsed = ttsSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid body", details: parsed.error.issues }, { status: 400 });
  }

  const clip = await tts.synthesize(speakable(parsed.data.text), { rate: parsed.data.rate });

  return new Response(clip.data, {
    headers: {
      "Content-Type": clip.mimeType,
      "Content-Disposition": 'inline; filename="voice.ogg"',
      "X-Voice-Provider": tts.name,
    },
  });
}
