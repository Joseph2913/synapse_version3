# Stage 1 — Capture (Front Door)

**Status:** Done. All five adapters shipped, contract-tested, wired into the live UI.
**Owner:** Joseph Thomas
**Completed:** 2026-04-26
**Test command:** `npm test` (Vitest) — 42 of 42 passing as of close-out.

---

## Why this stage exists

Stage 1 is the front door of the 13-stage ingestion pipeline. Every piece of content entering Synapse — pasted notes, web pages, files, YouTube videos, meeting transcripts — flows through one of five adapters here. Before this hardening pass, the five adapters produced inconsistent payload shapes, used different title rules, had different (or missing) size limits, and in some cases didn't actually do their job (the live URL and YouTube tabs were sending raw URL strings to extraction without ever fetching the content).

Stage 1's job is to convert any input into a single, predictable shape — `CapturedSource` — so that Stages 2–13 never have to branch on `source_type` to decide how to read content.

---

## The contract

Every adapter returns the same shape, defined in [src/types/capture.ts](../src/types/capture.ts):

```ts
type CapturedSource = {
  content: string;          // canonical text for downstream stages
  title: string;            // derived per adapter rule, never empty
  source_type: 'paste' | 'url' | 'file' | 'youtube' | 'meeting';
  source_url: string | null;
  metadata: Record<string, unknown>;
};
```

`CaptureError` (from the same file) is the canonical rejection. Every adapter throws it with a `code` and a human-readable `message` when input is too large, the wrong type, malformed, or unrecoverable.

**Downstream rule:** nothing in Stages 2–13 should branch on `source_type` to decide how to read content. If you find yourself writing `if (source_type === 'youtube') ...` to extract content, you're in the wrong layer.

---

## Adapter 1 — Paste

**File:** [src/adapters/capture/paste.ts](../src/adapters/capture/paste.ts)
**UI entry point:** [src/components/automate/ManualUploadPanel.tsx](../src/components/automate/ManualUploadPanel.tsx) — "Add Text" tab
**Test:** [tests/capture/paste.test.ts](../tests/capture/paste.test.ts) (9 tests)
**Fixture:** [tests/fixtures/capture/paste.txt](../tests/fixtures/capture/paste.txt)

| Property | Value |
|---|---|
| Title rule | First non-empty line, trimmed, max 80 characters. Fallback `Untitled paste`. |
| Size limit | `PASTE_MAX_CHARS = 500_000` characters. Reject above. |
| MIME validation | Not applicable (text by definition). |
| Failure modes | Empty input → return; oversize → throw `PASTE_OVERSIZE`. |
| Metadata fields | `char_count` |

---

## Adapter 2 — URL fetch

**Browser file:** [src/adapters/capture/url.ts](../src/adapters/capture/url.ts)
**Serverless file:** [api/capture/url.ts](../api/capture/url.ts)
**UI entry point:** [src/components/automate/ManualUploadPanel.tsx](../src/components/automate/ManualUploadPanel.tsx) — "Add URL" tab
**Test:** [tests/capture/url.test.ts](../tests/capture/url.test.ts) (6 tests)

| Property | Value |
|---|---|
| Mechanism | Gemini URL Context tool. Google's infrastructure fetches and reads the page. We do not parse HTML ourselves. |
| Title rule | Gemini-extracted: og:title → `<title>` → first `<h1>` → URL hostname. Fallback to URL hostname. |
| Size limit | `URL_MAX_CHARS = 400_000` characters of extracted text. Reject above. |
| MIME validation | Server validates http/https only. Gemini handles content-type internally. |
| Fallback policy | **None.** If Gemini cannot read the URL, the adapter throws `URL_UNREADABLE` and the user sees a clear error. |
| Metadata fields | `hostname`, `char_count`, `language`, `duration_ms` |
| Known limitations | Pages requiring authentication, certain anti-bot blocks, or aggressive rate limits will fail. |

---

## Adapter 3 — File upload

**Browser file:** [src/adapters/capture/file.ts](../src/adapters/capture/file.ts)
**Serverless file:** [api/capture/file.ts](../api/capture/file.ts)
**UI entry point:** [src/components/automate/ManualUploadPanel.tsx](../src/components/automate/ManualUploadPanel.tsx) — "Upload Document" tab
**Test:** [tests/capture/file.test.ts](../tests/capture/file.test.ts) (7 tests)
**Fixture:** [tests/fixtures/capture/file-success.json](../tests/fixtures/capture/file-success.json)

| Property | Value |
|---|---|
| Mechanism | Browser uploads multipart to our serverless endpoint. Endpoint streams the file to Gemini File API, then calls `generateContent` with a `fileData` reference. Gemini reads the file directly (PDFs, audio transcribed, video transcribed, images OCR'd). |
| Title rule | Gemini-extracted from content (PDF metadata title, document heading, etc.). Fallback to filename without extension. Fallback to `Untitled file`. |
| Inline file size cap | `FILE_MAX_BYTES = 25 MB` for v1. (Gemini File API ceiling is 2 GB; reaching it requires a Supabase Storage staging path — see Follow-ups.) |
| Extracted text cap | 400,000 characters. Reject above. |
| Supported MIME types | `application/pdf`, `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `text/plain`, `text/markdown`, `audio/mpeg`, `audio/mp4`, `audio/x-m4a`, `audio/wav`, `audio/x-wav`, `video/mp4`, `video/quicktime`, `image/jpeg`, `image/png` (PDF, DOCX, TXT, MD, MP3, M4A, WAV, MP4, MOV, JPG, PNG). |
| Fallback policy | **None.** If Gemini cannot extract content, the adapter throws `FILE_UNREADABLE`. |
| Metadata fields | `filename`, `mime_type`, `file_extension`, `file_size_bytes`, `char_count`, `language`, `page_count`, `duration_seconds`, `duration_ms` |

---

## Adapter 4 — YouTube

**Browser file:** [src/adapters/capture/youtube.ts](../src/adapters/capture/youtube.ts)
**Serverless file:** [api/capture/youtube.ts](../api/capture/youtube.ts)
**Background pipeline (cron-driven, for playlists):** [api/youtube/fetch-transcripts.ts](../api/youtube/fetch-transcripts.ts) — tier order matches the manual capture path.
**UI entry point:** [src/components/automate/ManualUploadPanel.tsx](../src/components/automate/ManualUploadPanel.tsx) — "Add YouTube Video" tab
**Test:** [tests/capture/youtube.test.ts](../tests/capture/youtube.test.ts) (9 tests)
**Fixture:** [tests/fixtures/capture/youtube-success.json](../tests/fixtures/capture/youtube-success.json)

| Property | Value |
|---|---|
| Tier 1 (default) | **Apify** — `streamers~youtube-scraper` actor. Synchronous polling up to 45 seconds in the manual capture path; fire-and-forget in the background cron pipeline. Reliable, paid, what gets used by default. |
| Tier 2 (free fallback) | **`youtube-caption-extractor` npm package** — scrapes the public YouTube `timedtext` endpoint. Free. Used only when Apify fails or is unavailable. (Note: original spec said "YouTube Data API v3 captions" but that endpoint requires OAuth as the channel owner and is not available for third-party videos. The caption-extractor package is the practical replacement.) |
| Tier 3 (escape hatch) | **Gemini video understanding** — `fileData` with the YouTube URL. Used only when both prior tiers fail. Slower and more expensive per video, so this is genuinely last-resort. |
| Title rule | Video title from YouTube Data API v3. Fallback to `YouTube video {videoId}`. |
| Size limit | `TRANSCRIPT_MAX_CHARS = 400_000` characters. Reject above. |
| Metadata fields | `video_id`, `channel`, `duration_seconds`, `published_at`, `thumbnail_url`, `char_count`, `language`, `tier_used` (1, 2, or 3), `duration_ms` |
| Cost flag | Apify runs on **every** YouTube capture by default. Per-video cost is small but volume now matches usage volume. Monitor if usage scales. |

---

## Adapter 5 — Meeting webhook (Circleback)

**File:** [api/meetings/webhook.ts](../api/meetings/webhook.ts) — pure `circlebackToCapturedSource()` exported for tests
**Test:** [tests/capture/meeting.test.ts](../tests/capture/meeting.test.ts) (11 tests)
**Fixture:** [tests/fixtures/capture/circleback-success.json](../tests/fixtures/capture/circleback-success.json)

| Property | Value |
|---|---|
| Mechanism | Inbound webhook from Circleback. Payload contains meeting name, transcript segments, action items, attendees. Pure transformation produces `CapturedSource`. |
| Title rule | `payload.name` → `Meeting on YYYY-MM-DD` (from `createdAt`) → `Untitled meeting`. |
| Size limit | `MEETING_MAX_CHARS = 400_000` characters. Reject above (previously: silent truncation at 100,000 — gone). |
| MIME validation | Not applicable (JSON payload). |
| Authentication | uid query param required. **Optional** shared-secret signature check via `CIRCLEBACK_WEBHOOK_SECRET` env var; if set, the `x-signature` header must match. If unset, the webhook keeps the legacy uid-only path and emits a warning log. |
| Idempotency | Database-level: unique index on `(user_id, circleback_meeting_id)`. Title+date safety net for legacy rows. (Stage 0 Item 6.) |
| Metadata fields | `provider: 'circleback'`, `circleback_meeting_id`, `duration_seconds`, `meeting_url`, `recording_url`, `attendees`, `tags`, `ical_uid`, `action_item_count`, `transcript_segment_count`, `char_count`, `participants`, `received_at` |
| Content composition | `notes` + `--- TRANSCRIPT ---` (formatted with timestamps + speakers) + `--- ACTION ITEMS ---` |

---

## Required environment variables

| Variable | Adapters | Required? |
|---|---|---|
| `SUPABASE_URL` | All serverless | Yes |
| `SUPABASE_ANON_KEY` | URL, File, YouTube | Yes |
| `SUPABASE_SERVICE_ROLE_KEY` | Meeting webhook (uses admin API) | Yes |
| `GEMINI_API_KEY` | URL, File, YouTube Tier 3 | Yes |
| `GEMINI_MODEL` | URL, File, YouTube Tier 3 | Optional. Defaults to `gemini-2.5-flash`. |
| `APIFY_API_KEY` | YouTube Tier 1 | Required for Tier 1. Without it, capture falls through to Tier 2 and Tier 3. |
| `YOUTUBE_API_KEY` | YouTube metadata | Required for video title/channel/duration. Without it, falls back to `YouTube video {videoId}`. |
| `CIRCLEBACK_WEBHOOK_SECRET` | Meeting webhook | **Optional but recommended.** When set, requires the `x-signature` header to match. |

---

## Known follow-ups (deliberately out of Stage 1 scope)

1. **2 GB file uploads.** The current 25 MB inline cap is set by Vercel function body limits. Lifting it to the Gemini File API ceiling (2 GB) requires a Supabase Storage staging path: browser → Storage → serverless → Gemini Files. The adapter logic is unchanged; only the upload mechanism differs.

2. **Stage 2 persistence cutover.** All five adapters today still write directly to `knowledge_sources` from inside the Stage 1 layer. The original Stage 1 spec wanted persistence moved to Stage 2 entirely. Decision **D-006** (in [PIPELINE-IMPLEMENTATION-LOG.md](PIPELINE-IMPLEMENTATION-LOG.md)) confirms this lives in Stage 2, not Stage 1. The `CapturedSource` contract is already in place, so when Stage 2's `persistSource()` lands, it slots in cleanly.

3. **Source-type string rename across the database-facing code.** `CapturedSource.source_type` is lowercase (`paste`, `url`, `file`, `youtube`, `meeting`). The `knowledge_sources.source_type` column today still uses the legacy strings (`Note`, `Web`, `Document`, `YouTube`, `Meeting`). Translation happens at the persistence boundary; the rename is owned by Stage 2.

4. **Legacy dead-code cleanup.** These files still exist and are still imported by the Skills feature, so they cannot be deleted yet. Remove when Skills migrates to the canonical adapters:
   - `api/content/fetch.ts` (regex HTML parser, replaced by `api/capture/url.ts`)
   - `src/utils/fileParser.ts` (browser-side PDF/DOCX parser, replaced by `api/capture/file.ts`)
   - `src/components/ingest/QuickCaptureTab.tsx` (legacy capture screen, not router-active)
   - `src/views/CaptureView.tsx` (legacy capture view, not router-active)

5. **Meeting signature verification upgrade.** The current implementation is shared-secret string match. If Circleback supports HMAC signing, upgrade to that. Until then the shared-secret check is a meaningful improvement over the current uid-only auth.

---

## Validation gate

Stage 1 is considered complete because:

1. ✅ All five adapters return a unified `CapturedSource` shape.
2. ✅ Every adapter has documented title rules, size limits, and validation behaviour.
3. ✅ Every adapter has at least one contract test passing against a saved fixture. **42 of 42 tests pass.**
4. ✅ TypeScript strict-mode build is clean (`npx tsc --noEmit`).
5. ✅ Each adapter rejects oversized or wrong-format content with a clear error.
6. ✅ Chrome extension fully removed from code and docs (pre-task).
7. ✅ Pipeline log updated; Decision D-006 records the Stage 2 boundary.

**Stage 1 is complete and validated.**
