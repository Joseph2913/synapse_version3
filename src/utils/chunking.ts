/**
 * Canonical Stage 3 chunker.
 *
 * Structural-first split: Markdown headings -> paragraphs -> sentences -> hard
 * cap. Greedy pack to ~500 tokens (~2000 chars) with 100-char overlap.
 *
 * If you change anything here, also update the byte-equivalent paste-in copies
 * at:
 *   - api/pipeline/extract-pipeline.ts (chunkText)
 *   - api/content/backfill-chunks.ts   (chunkText)
 *
 * The two backend copies exist because Vercel bundles each serverless
 * function independently and forbids shared local imports.
 */

export const CHUNK_TARGET_CHARS = 2000
export const CHUNK_OVERLAP_CHARS = 100
export const CHUNK_MAX_CHARS = 3000

const ABBREVIATIONS = [
  'Dr', 'Mr', 'Mrs', 'Ms', 'Prof', 'Sr', 'Jr', 'St',
  'vs', 'etc', 'e.g', 'i.e', 'U.S', 'U.K', 'U.N',
  'No', 'Inc', 'Ltd', 'Co', 'Corp', 'Fig', 'cf', 'al',
]

// Sentinel used to mask the trailing dot of an abbreviation so the sentence
// splitter does not treat it as a sentence terminator. Restored at the end.
const DOT_SENTINEL = ''

const ABBREV_RE = new RegExp(
  '\\b(' + ABBREVIATIONS.map(a => a.replace(/\./g, '\\.')).join('|') + ')\\.',
  'g',
)

function splitSentences(text: string): string[] {
  const masked = text.replace(ABBREV_RE, (_, a) => `${a}${DOT_SENTINEL}`)
  const parts = masked.split(/(?<=[.!?])\s+(?=["'(\[]?[A-Z0-9])/g)
  return parts
    .map(p => p.split(DOT_SENTINEL).join('.').trim())
    .filter(Boolean)
}

function splitSections(text: string): string[] {
  const lines = text.split('\n')
  const sections: string[] = []
  let buf: string[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    const isHeading = /^#{1,6}\s/.test(line)
    const isRule = /^[-_*]{3,}$/.test(trimmed)
    if (isHeading || isRule) {
      if (buf.length) sections.push(buf.join('\n').trim())
      buf = [line]
    } else {
      buf.push(line)
    }
  }
  if (buf.length) sections.push(buf.join('\n').trim())
  return sections.filter(s => s.length > 0)
}

function splitParagraphs(text: string): string[] {
  return text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean)
}

/**
 * Split source content into ~500-token chunks for RAG retrieval.
 * Returns an empty array for empty or whitespace-only input.
 */
export function chunkSourceContent(
  content: string,
  targetChars: number = CHUNK_TARGET_CHARS,
  overlapChars: number = CHUNK_OVERLAP_CHARS,
  maxChars: number = CHUNK_MAX_CHARS,
): string[] {
  if (!content || !content.trim()) return []

  const units: string[] = []
  for (const section of splitSections(content)) {
    for (const para of splitParagraphs(section)) {
      if (para.length <= targetChars) {
        units.push(para)
        continue
      }
      for (const sent of splitSentences(para)) {
        if (sent.length <= maxChars) {
          units.push(sent)
        } else {
          for (let i = 0; i < sent.length; i += targetChars) {
            units.push(sent.slice(i, i + targetChars))
          }
        }
      }
    }
  }

  const chunks: string[] = []
  let current = ''
  for (const unit of units) {
    const sep = current ? '\n\n' : ''
    if (current.length + sep.length + unit.length > targetChars && current.length > 0) {
      chunks.push(current.trim())
      const overlapStart = Math.max(0, current.length - overlapChars)
      current = current.substring(overlapStart).trim() + '\n\n' + unit
    } else {
      current += sep + unit
    }
  }
  if (current.trim()) chunks.push(current.trim())

  const merged: string[] = []
  for (const c of chunks) {
    if (merged.length > 0 && c.length < 200) {
      merged[merged.length - 1] += '\n\n' + c
    } else {
      merged.push(c)
    }
  }
  return merged.filter(c => c.length > 0)
}

/** Build the text that will be embedded for a chunk. Includes the source title for retrieval context. */
export function buildEmbeddingInput(title: string | null | undefined, chunkContent: string): string {
  const t = (title ?? '').trim()
  return t ? `${t}\n\n${chunkContent}` : chunkContent
}
