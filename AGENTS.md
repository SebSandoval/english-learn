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
| 5 · Voice — STT/TTS for VOICE DRILL and LISTENING | ⬜ **next** |

## Phase 5 — the plan already agreed

Decided after benchmarking; do not re-litigate without new evidence:

- **STT: Groq `whisper-large-v3-turbo`.** Free tier is 2,000 requests/day and
  ~200x real-time. Local Whisper was rejected: Vercel is serverless, the model
  does not fit the bundle, and a second always-on service costs more and breaks
  more than the free tier it would replace.
- **TTS: Google Cloud `Chirp 3 HD`.** 1M characters/month free, permanently.
  Expected usage is ~40k/month, so it never bills. ElevenLabs' 10k/month would
  last two days. Requires a card on the GCP project even though the free tier
  never charges.

Both go behind `STTProvider` / `TTSProvider` interfaces in `lib/audio/`.

Manual steps Sebastián still has to do (walk him through them ONE at a time and
wait for confirmation):
1. Groq account → API key → `GROQ_API_KEY` in `.env.local` and Vercel
2. Google Cloud project → enable Text-to-Speech API → key → `GOOGLE_TTS_API_KEY`

Then: `/api/voice`, Telegram voice notes both directions, `voice_drill` and
`listening` added to `IMPLEMENTED_MODES` in `lib/modes/selector.ts`, and the
`NOT_READY` stubs for `/drill` and `/listen` removed from
`lib/telegram/commands.ts`.

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
npm test              # SM-2 scheduler, 9 tests
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
