/**
 * Parses participant names from Circleback meeting transcript content.
 *
 * Strategy (in order):
 * 1. Look for **People**:/**Participants**:/**Attendees**: in the content header
 * 2. Fall back to metadata.attendees array from the Circleback webhook payload
 *
 * All names are normalized to title case and deduplicated.
 */

function toTitleCase(name: string): string {
  return name
    .trim()
    .split(/\s+/)
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

function dedup(names: string[]): string[] {
  const seen = new Set<string>()
  return names.filter(n => {
    const key = n.toLowerCase()
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** Parse from content header line */
function parseFromContent(content: string): string[] | null {
  const lines = content.split('\n').slice(0, 30)

  for (const line of lines) {
    const match = line.match(/^\*\*(?:People|Participants|Attendees)\*\*:\s*(.+)$/i)
    if (!match?.[1]) continue

    const raw = match[1].trim()
    if (!raw) continue

    const parts = raw.split(',').map(s => s.trim()).filter(Boolean)

    const result: string[] = []
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i] ?? ''
      if (i === parts.length - 1 && /\band\b/i.test(part)) {
        const subParts = part.split(/\band\b/i).map(s => s.trim()).filter(Boolean)
        result.push(...subParts.map(toTitleCase))
      } else {
        result.push(toTitleCase(part))
      }
    }

    return result.length > 0 ? result : null
  }

  return null
}

/** Parse from metadata.attendees array (Circleback webhook payload) */
function parseFromMetadata(metadata: Record<string, unknown> | null | undefined): string[] | null {
  const attendees = metadata?.attendees
  if (!Array.isArray(attendees) || attendees.length === 0) return null
  const names = attendees.map(a => toTitleCase(String(a))).filter(Boolean)
  return names.length > 0 ? dedup(names) : null
}

export function parseParticipants(
  content: string,
  metadata?: Record<string, unknown> | null
): string[] | null {
  if (!content && !metadata) return null

  // Try content header first (most precise)
  if (content) {
    const fromContent = parseFromContent(content)
    if (fromContent) return dedup(fromContent)
  }

  // Fall back to metadata.attendees
  if (metadata) {
    return parseFromMetadata(metadata)
  }

  return null
}
