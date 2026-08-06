<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

# English Push

A proactive English tutor that contacts Sebastián on Telegram, alternates
practice modes, and uses spaced repetition on his own recorded mistakes.

Live at https://english-learn-murex.vercel.app · bot **@seb_english_push_bot**

## Where we are

| Phase | Status |
|---|---|
| 1 · Supabase schema + connection | ✅ done |
| 2 · `/api/chat` + Telegram text (FREE CONVERSATION) | ✅ done |
| 3 · Streak, mode selector, `/api/nudge`, cron | ✅ done |
| 4 · SPACED REVIEW with SM-2 | ✅ done |
| 5 · Voice — STT/TTS for VOICE DRILL and LISTENING | ✅ done |

## Phase 5 — voice

Providers, decided after benchmarking; do not re-litigate without new evidence:

- **STT: Groq `whisper-large-v3-turbo`.** Free tier is 2,000 requests/day and
  ~200x real-time. Local Whisper was rejected: Vercel is serverless, the model
  does not fit the bundle, and a second always-on service costs more and breaks
  more than the free tier it would replace.
- **TTS: Deepgram `aura-2-asteria-en`.** $200 of signup credit, **no card**, and
  it returns Ogg/Opus natively — the one format Telegram renders as a playable
  voice note. At ~40k characters/month ($0.030/1k) the credit lasts over a
  decade. Caveat: promotional credit, not a contractual free tier, so this is
  "free for years", not "free forever". Hard limit of **2000 characters** per
  request, measured; `fitToLimit` cuts at a sentence boundary and warns.

Both sit behind `STTProvider` / `TTSProvider` in `lib/audio/types.ts`. Nothing
above `lib/audio/` names a vendor.

**Google Chirp 3 HD was the original choice and lost on signup friction, not on
quality — 2026-08-06.** Its free tier is bigger and contractual (1M chars/month,
permanent) but GCP demanded a ~$10 card authorisation to start, which defeats
the point of a project that runs for free. `lib/audio/google-tts.ts` is written,
working and kept: setting `GOOGLE_TTS_API_KEY` with no Deepgram key switches
back. Note it allows 5000 characters where Deepgram allows 2000.

**Groq's own TTS was evaluated and rejected — measured, 2026-08-06.**
`canopylabs/orpheus-v1-english` is on the same key, needs no card, and works
after a one-click terms acceptance. Voices: autumn, diana, hannah, austin,
daniel, troy. It loses on format: `response_format` accepts **only `wav`** —
ogg, opus, mp3 and flac are all rejected outright. Telegram needs Ogg/Opus for a
playable voice bubble, so it would need transcoding, and the raw audio is
24kHz/16-bit mono at 47 KB/s: a 60-second listening passage is 2.9MB against
0.18MB in Opus, 16x the mobile data on every single reply. Its WAV header also
declares a placeholder 89478-second length because Groq streams it. Adding a
wasm Opus encoder for this is the same trade we already refused with local
Whisper. Re-open only if Groq starts returning Opus.

Both keys are configured (`GROQ_API_KEY`, `DEEPGRAM_API_KEY`). Voice still
degrades cleanly if one is pulled: `/drill` and `/listen` say which half is
missing, voice notes get "I can't listen yet", and `implementedModes()` keeps
unusable modes out of the nudge rotation. `/api/health` reports `voice_modes`
and `tts_provider`.

### How voice actually flows

- **In**: Telegram voice note → `downloadFile` → Groq → the transcript is echoed
  back to the student in italics, then run through `processTurn` as ordinary
  text. A voice note with no session open starts a VOICE DRILL; inside a session
  it stays in that session, so a review item can be answered out loud.
- **Out**: `lib/telegram/deliver.ts` decides text vs voice from the session mode.
  VOICE DRILL sends audio *and* the text; LISTENING sends audio only — a
  transcript underneath turns it into a reading exercise. Every path degrades to
  text, because losing the audio must never cost the turn.
- **`speakable()`** strips markdown, HTML and emoji before synthesis. The prompt
  already asks for spoken prose; this is the guard for when it slips, and it has
  tests, because the only symptom is the student hearing "asterisk asterisk".
- **Ogg/Opus end to end.** Google is pinned to `OGG_OPUS` because any other
  encoding uploads as a file attachment instead of a playable voice bubble, and
  Groq is handed a rewritten `.ogg` filename because Telegram's `.oga` is
  rejected on the extension alone.

## Deferred, agreed, not yet done

**Rename the database to English.** Table and column names are still Spanish
(`usuarios`, `nivel`, `proxima_revision`) while all application code is English.
Enum *values* are Spanish too (`'principiante'`, `'gramatica'`, `'activo'`) and
are pinned by CHECK constraints, so they need the same migration. This is the
only place the two languages mix; it is isolated to `lib/db/types.ts` and the
queries. Regenerate types after migrating.

## Conventions

- **All code, comments and identifiers in English.** Only the DB names above are
  the exception, pending that migration.
- Talk to Sebastián in **Spanish**. The bot speaks English to him; you don't.
- Ask before assuming on non-obvious design decisions — naming, folder layout,
  how to partition logic.
- For anything manual (accounts, env vars, dashboards), give **one step at a
  time** and wait for confirmation.
- Sebastián has authorised committing and pushing without asking each time.
- Never ask him to paste a secret into the chat. He adds it to `.env.local` and
  Vercel himself; `/api/health` reports which are configured, as booleans and a
  hash fingerprint.

## Verify before pushing

```bash
npx tsc --noEmit      # capture the exit code — do NOT pipe through head
npx eslint app lib scripts
npm test              # SM-2 scheduler + speakable(), 17 tests
npm run build
```

`npm run bench` re-runs the free-model benchmark against the real tutor prompt.
Free-tier quality drifts; reorder `OPENROUTER_MODEL` /
`OPENROUTER_MODEL_FALLBACK` (both accept comma-separated lists) when replies
degrade. Current chain was chosen on JSON validity first, latency second —
`openai/gpt-oss-20b:free` was dropped for returning invalid JSON.

## Architecture notes worth keeping

- **The tutor returns JSON, not prose**: `{ reply, corrections[], new_vocab[],
  review_quality, review_item_id, end_session }`. The extraction is what feeds
  the SM-2 tables — without it, spaced review has no real material.
- **Corrections travel outside `reply`** and are rendered as a separate block,
  so feedback never interrupts conversational flow.
- **`corrections[].pattern` is a deduplication key.** It must describe the rule
  ("past simple: uses base form instead of past tense"), never quote the
  student. The prompt carries good/bad examples; check them if the mistakes
  table starts filling with one-off entries.
- **Streaks are derived on read** from `ultima_practica`, never expired by a
  job. All date and window logic runs in the user's timezone, not the server's.
- **`/api/nudge` is safe to call at any time** — it re-derives whether each user
  is due rather than trusting the cron. `?dry=1` decides without sending.
- **The SM-2 ladder is deliberate**: `1/3/7/15/30/60` with the ease factor as a
  multiplier, not plain SM-2's `interval × ease`. See the comment in
  `lib/srs/sm2.ts`.
- **Known weak spot**: the model does not reliably emit `review_item_id`, so
  grading usually falls back to our own queue index. Logs warn on mismatch. If
  review starts asking odd things, look there first.

## Env and secrets

`CRON_SECRET` in `.env.local` is **local dev only** and intentionally differs
from production. What matters is that Vercel and the GitHub Actions secret match
each other. GitHub needs `CRON_SECRET` under *Secrets* and `APP_URL` under
*Variables* — different tabs, and the workflow fails with 401 if swapped.
