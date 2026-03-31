import { Loader2 } from 'lucide-react'

interface ProcessingCardProps {
  type: 'skill' | 'anchor'
  title?: string
  index: number
}

export function ProcessingCard({ type, title, index }: ProcessingCardProps) {
  const label = type === 'skill' ? 'Extracting skill' : 'Creating anchor'
  const accentColor = type === 'skill' ? '#3b82f6' : 'var(--color-accent-500)'

  return (
    <div
      style={{
        background: 'var(--color-bg-card)',
        border: '1px dashed var(--border-subtle)',
        borderRadius: 12,
        padding: '16px 18px',
        opacity: 0.85,
        animation: `fadeUp 0.4s ease ${index * 0.05}s both`,
        position: 'relative',
        overflow: 'hidden',
        borderLeft: `3px dashed ${accentColor}`,
      }}
    >
      <div className="flex items-center gap-3">
        <Loader2
          size={16}
          style={{
            color: accentColor,
            animation: 'spin 1.2s linear infinite',
            flexShrink: 0,
          }}
        />
        <div className="flex flex-col gap-1 min-w-0">
          <span
            className="font-display"
            style={{
              fontSize: 14,
              fontWeight: 700,
              color: 'var(--color-text-primary)',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
          >
            {title || (type === 'skill' ? 'New skill' : 'New anchor')}
          </span>
          <span
            className="font-body"
            style={{
              fontSize: 11,
              color: 'var(--color-text-secondary)',
            }}
          >
            {label}… This may take a moment.
          </span>
        </div>
      </div>

      {/* Animated progress bar */}
      <div
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 2,
          background: 'var(--color-bg-inset)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            height: '100%',
            width: '40%',
            background: accentColor,
            opacity: 0.6,
            borderRadius: 1,
            animation: 'processingSlide 1.8s ease-in-out infinite',
          }}
        />
      </div>

      <style>{`
        @keyframes processingSlide {
          0% { transform: translateX(-100%); }
          50% { transform: translateX(200%); }
          100% { transform: translateX(-100%); }
        }
      `}</style>
    </div>
  )
}
