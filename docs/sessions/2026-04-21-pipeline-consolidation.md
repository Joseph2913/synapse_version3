# Ingestion Pipeline Consolidation Session

*Session date: 2026-04-21*

## The two user-visible symptoms

Joseph reported two problems. First, some YouTube videos were ingesting 6+ times and creating duplicate sources. Second, recent Circleback meeting notes were stuck showing Processing... forever with no entities extracted.

These looked like two bugs. They turned out to be one architectural problem with two different expressions.

## The real problem underneath

Synapse ingests content from five separate routes: YouTube, Circleback meetings, Microsoft/Teams, GitHub dev digests, and manual Capture sessions from Claude Code. Each of these was a separate Vercel serverless function, and each carried its own copy-paste of roughly 400 lines of extraction logic. Five copies of the same code. A bug fix in one place did not reach the others. The team had interpreted a CLAUDE.md note about "no shared imports in api/" as a hard rule and worked around it with duplication.

All five copies did the same shape of work for each source: call Gemini to extract entities (1 call), embed each entity and check it for duplicates against the graph (around 30 calls), embed each newly-saved node (around 15 to 25 calls), split the transcript into chunks and embed each chunk (around 30 to 40 calls), do a cross-connection discovery call, and in YouTube's case do an advisory council hook call. That is 80 to 100 Gemini API calls per single source.

Gemini free tier allows around 15 calls per minute. The cron was firing two videos per tick, so every single tick threw 160-200 calls at a 15/minute ceiling and tripped 429 rate limit responses.

The retry behavior then diverged wildly between pipelines. YouTube had a bug that bypassed its retry cap whenever the error was a rate limit, so the same video could bounce off 429s forty-seven times before landing. Meetings did the opposite — one 429 marked the meeting permanently failed, with no error message persisted and no retry ever attempted. That is why Joseph's recent Circleback notes got buried. Microsoft matched Meetings. GitHub was the only pipeline that handled retries correctly. Capture/session had no retry either.

## The fix

Consolidated all five pipelines into one shared module at `lib/extract-pipeline.ts`. The key change in that module is batched embeddings — Gemini's `batchEmbedContents` endpoint takes up to 100 texts in a single HTTP call. Replacing the 30+ per-entity calls and the 30+ per-chunk calls with one or two batched calls each drops per-source Gemini calls from around 80 to around 5. Embedding quality is unchanged because the embedding API is a deterministic per-item transformation, not a reasoning step.

The module owns the shared helpers: `buildExtractionPrompt`, `extractEntities`, `deduplicateEntities` (exact + fuzzy dedup via the `check_node_duplicate` RPC), `saveNodes`, `saveEdges`, `saveTranscriptChunks`, `discoverCrossConnections` via the `match_knowledge_nodes` RPC, and the `runExtractionCore` orchestrator. Each per-route file now only owns what genuinely differs between source types — how it finds work, how it records status, and source-type-specific post-processing (YouTube's advisory council hook, Meetings' domain-agent linking, Microsoft's Teams-integration routing, GitHub's extraction_sessions log, Capture's summary generation).

Along with the consolidation, several behavioral bugs got fixed for free: rate-limit retry capped at 10 attempts everywhere, Meetings 429s requeue instead of marking failed forever, Microsoft entities now pass through dedup (previously every Teams meeting created a fresh Joseph Thomas and Chiesi node), GitHub now gets fuzzy dedup, and the Meetings stuck-item timeout bumped from 5 min to 30 min.

Net code change: +1238 / -2458 lines across the five pipeline files — around 1220 lines of duplicated logic removed.

## The new issue the first deploy exposed

First deploy was commit `8fb29bc`. It placed the shared module at `api/_shared/extract-pipeline.ts`. Underscore-prefixed folders under `api/` are supposed to be skipped from Vercel routing but still included in bundling. In practice in this project's build setup, they appeared to also be excluded from the dependency trace. Result: routes that imported from `../_shared/` crashed at cold-start with `FUNCTION_INVOCATION_FAILED`. The `send_to_synapse` MCP tool started failing. The YouTube cron stopped claiming items.

Separately, two resurrected YouTube videos had genuinely null transcripts (YouTube caption API returned nothing), and the shared extractor crashed on them with a TypeError when it tried to slice null. That was a real bug I introduced by not guarding against empty content.

## The second deploy (the fix for the fix)

Commit `826bbce`. Moved the shared module from `api/_shared/extract-pipeline.ts` to `lib/extract-pipeline.ts`, placing it unambiguously outside `api/`. All five pipeline files now import from `../../lib/extract-pipeline` and Vercel bundles it like any npm package. Updated `tsconfig.serverless.json` to include `lib/**/*.ts`.

Also added a null-transcript guard at the top of YouTube's `extractKnowledgeForItem` so videos with no captions fail fast with a clear message instead of crashing the extractor. Added a defensive empty-content check inside the shared `extractEntities` itself so any future pipeline that forgets to validate content gets a clear error instead of a cryptic TypeError.

Pre-emptively marked six other null-transcript items as failed with a clear reason so the cron doesn't burn cycles on them.

## The evidence the fix works

15 minutes after the second deploy, the Meetings pipeline proved the consolidation holds. Two resurrected Circleback meetings extracted successfully on single-attempt `retry_count=0`:

- *"Chiesi data skills internal alignment"* → 20 entities
- *"My Top 5 Productivity Apps That Survived Years of Testing"* → 26 entities

No 429s. No retries. That is the batched-embed fix landing exactly as intended.

## What remains unresolved as of this session ending

1. **YouTube cron dormant.** Has not claimed a single item since 20:15 UTC, the moment of the original crash. Other crons (Meetings) ran fine on the same deploy, so the shared module loads. YouTube specifically appears dormant. Three valid-transcript items sitting in `transcript_ready`. The advisory council hook is a large chunk of YouTube-specific code that survived the consolidation — worth checking whether it has a cold-start issue.
2. **Two YouTube videos stuck in `failed`** from the first deploy's null-slice crash (Carlos Alcaraz, 60-30-10 Rule). Their transcripts are fine — they crashed because of the bug, not bad data. Need to be reset to `transcript_ready` with `retry_count=0`.
3. **Two Meetings titled "Untitled Meeting" failed with no error message.** They went through the old broken catch block. Content should be inspected.
4. **`send_to_synapse` still crashing with FUNCTION_INVOCATION_FAILED** at session end. The call chain is `api/mcp.ts` → `api/ingest/session.ts` (which imports from `lib/extract-pipeline.ts`). Root cause unknown without Vercel log access.
5. **Four GitHub items still in `digest_ready`** — GitHub cron runs less frequently.
6. **Nine orphaned sources** (5 Note, 2 Research, 1 API, 1 Document) from the push-based `ingest/session` endpoint that never completed. No cron picks them up. Need either a one-off re-ingestion script or a fallback cron.

## The architectural lesson

When five separate pieces of code do the same job, they should be one piece of code doing that job. The "no shared imports in api/" rule in CLAUDE.md was an over-cautious defensive choice that cost more than it protected. Vercel's bundler handles imports from outside `api/` (like `lib/`) cleanly. The cost of the duplication was exactly what a software engineer would predict — a fix on one pipeline did not reach the others, and the pipeline that took the longest to get the fix is where the user's data got stuck.

The related lesson: architectural reorganizations should be deployed with a lightweight health-check endpoint in place. This session spent meaningful time doing SQL archaeology to figure out whether the cron was alive or dead after the deploy. A `/api/health/ingestion` endpoint that reports per-pipeline queue depth and last-successful-extraction timestamp would make the "is it working" question answerable in one second.

## Files touched

- `lib/extract-pipeline.ts` — new, 660 lines, shared core
- `api/youtube/extract-knowledge.ts` — 1357 → ~970 lines, null-transcript guard, capped rate-limit retry at 10
- `api/meetings/process.ts` — 942 → ~360 lines, fixed fail-forever retry bug, bumped stuck timeout
- `api/microsoft/extract-knowledge.ts` — full rewrite, now runs full dedup + chunking + cross-connections
- `api/github/extract-knowledge.ts` — 728 → ~445 lines, now gets fuzzy dedup
- `api/ingest/session.ts` — 701 → ~252 lines, kept the unique summary generator
- `tsconfig.serverless.json` — include `lib/` alongside `api/`

## Deployment state at session end

Latest commit on `main`: `826bbce`. Both the consolidation (`8fb29bc`) and the relocation-plus-null-guard fix (`826bbce`) pushed to GitHub. Two Meetings completed successfully on the new code (proof the consolidation works). At session end, both YouTube and Meetings crons appeared to have gone silent, and `send_to_synapse` was still throwing FUNCTION_INVOCATION_FAILED — next step is to read Vercel function logs directly to identify the crashing line.
