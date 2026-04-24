import { useState } from 'react'
import type { AddressingEvidenceEntry } from '../../types/council'

interface Props {
  status: 'open' | 'partially_addressed' | 'answered' | 'dismissed'
  addressingEvidence: AddressingEvidenceEntry[] | null
}

const STATUS_STYLE: Record<Props['status'], { label: string; className: string }> = {
  open:                { label: 'Open',      className: 'bg-[var(--color-bg-subtle)] text-[var(--color-text-secondary)]' },
  partially_addressed: { label: 'Partial',   className: 'bg-[var(--color-accent-50)] text-[var(--color-accent-500)]' },
  answered:            { label: 'Answered',  className: 'bg-[#e7f6ec] text-[#1f6f43]' },
  dismissed:           { label: 'Dismissed', className: 'bg-[var(--color-bg-subtle)] text-[var(--color-text-tertiary)]' },
}

export function QuestionStatusBadge({ status, addressingEvidence }: Props) {
  const [open, setOpen] = useState(false)
  const nonLegacyCount = (addressingEvidence ?? []).filter(e => e.verdict !== 'legacy').length
  const hasEvidence = nonLegacyCount > 0
  const { label, className } = STATUS_STYLE[status]

  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => hasEvidence && setOpen(v => !v)}
        className={`inline-flex items-center rounded-[20px] px-[13px] py-[5px] text-[12px] font-body font-semibold ${className} ${hasEvidence ? 'cursor-pointer' : 'cursor-default'}`}
      >
        {label}
        {hasEvidence && <span className="ml-1.5 text-[10px] opacity-70">({nonLegacyCount})</span>}
      </button>
      {open && hasEvidence && addressingEvidence && (
        <div className="absolute z-10 mt-2 w-80 rounded-lg border border-[var(--border-subtle)] bg-[var(--color-bg-card)] p-3 shadow-lg">
          {addressingEvidence.filter(e => e.verdict !== 'legacy').slice(-3).reverse().map((ev, i) => (
            <div key={i} className="mb-3 last:mb-0">
              <div className="text-[11px] uppercase tracking-wide text-[var(--color-text-tertiary)]">
                {ev.verdict}{ev.confidence != null ? ` · ${Math.round(ev.confidence * 100)}%` : ''}
              </div>
              <div className="text-[12px] text-[var(--color-text-secondary)]">{ev.snippet}</div>
              {ev.source_id && (
                <a href={`/explore?source=${ev.source_id}`}
                   className="text-[11px] text-[var(--color-accent-500)] hover:underline">
                  Open source →
                </a>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
