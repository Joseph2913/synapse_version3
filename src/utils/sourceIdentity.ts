// Stage 2 — source identity utilities.
//
// Single source of truth for the dedup identity rules used by persistSource().
// Each Vercel serverless function that calls persistSource() must inline the
// equivalent of these helpers (no shared local imports — Vercel rule).

const TRACKING_PARAMS = new Set<string>([
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'gclid',
  'fbclid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'ref',
  'ref_src',
  'ref_url',
  'igshid',
  '_ga',
  'yclid',
  'dclid',
  'oly_anon_id',
  'oly_enc_id',
])

/**
 * Canonicalise a URL for dedup. Lowercases the host, drops the fragment, strips
 * known tracking params, and removes a trailing slash on the root path. Leaves
 * the protocol intact (we never silently rewrite http→https). Returns the
 * trimmed input unchanged when parsing fails.
 */
export function canonicalUrl(input: string): string {
  const trimmed = input.trim()
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return trimmed
  }
  url.hostname = url.hostname.toLowerCase()
  url.hash = ''
  const keep: Array<[string, string]> = []
  url.searchParams.forEach((value, key) => {
    if (!TRACKING_PARAMS.has(key.toLowerCase())) keep.push([key, value])
  })
  // Reset and re-add in original (filtered) order.
  const newSearch = new URLSearchParams()
  for (const [k, v] of keep) newSearch.append(k, v)
  url.search = newSearch.toString()
  let out = url.toString()
  // Drop trailing slash only when the path is exactly "/".
  if (url.pathname === '/' && out.endsWith('/')) out = out.slice(0, -1)
  return out
}

const YT_VIDEO_ID = /^[a-zA-Z0-9_-]{11}$/
const YT_HOST_RE = /(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/i

/**
 * Extracts the 11-character YouTube videoId from any of the known URL forms:
 *   - youtu.be/<id>
 *   - youtube.com/watch?v=<id>
 *   - youtube.com/embed/<id>
 *   - youtube.com/shorts/<id>
 *   - youtube.com/v/<id>
 *   - raw <id>
 * Returns null if no videoId can be located.
 */
export function extractYouTubeVideoId(input: string): string | null {
  const trimmed = input.trim()
  if (!trimmed) return null
  if (YT_VIDEO_ID.test(trimmed)) return trimmed

  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (!YT_HOST_RE.test(url.hostname)) return null

  const v = url.searchParams.get('v')
  if (v && YT_VIDEO_ID.test(v)) return v

  const segments = url.pathname.split('/').filter(Boolean)
  if (url.hostname.replace(/^www\./, '') === 'youtu.be') {
    const id = segments[0]
    return id && YT_VIDEO_ID.test(id) ? id : null
  }
  // /embed/<id>, /shorts/<id>, /v/<id>
  if (segments.length >= 2) {
    const head = segments[0]?.toLowerCase()
    const id = segments[1]
    if (
      (head === 'embed' || head === 'shorts' || head === 'v') &&
      id &&
      YT_VIDEO_ID.test(id)
    ) {
      return id
    }
  }
  return null
}

/** Returns the canonical YouTube watch URL for a video, or null if input has no videoId. */
export function canonicalYouTubeUrl(input: string): string | null {
  const id = extractYouTubeVideoId(input)
  return id ? `https://www.youtube.com/watch?v=${id}` : null
}

/** SHA-256 hex of `input` using Web Crypto. */
export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input)
  const buffer = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
}

/**
 * Compute a content-stable signature for a Circleback meeting payload. Two
 * webhook deliveries for the same meeting will produce the same signature
 * unless the transcript or action items have actually changed. Used by
 * persistSource() to decide skip-vs-replace on meeting re-ingest (decision A2
 * in the Stage 2 Wave A proposal).
 */
export async function meetingPayloadSignature(parts: {
  transcriptSegmentCount: number
  actionItemCount: number
  contentLength: number
  content: string
}): Promise<string> {
  const seed = `${parts.transcriptSegmentCount}|${parts.actionItemCount}|${parts.contentLength}|${parts.content.slice(0, 4096)}`
  return sha256Hex(seed)
}
