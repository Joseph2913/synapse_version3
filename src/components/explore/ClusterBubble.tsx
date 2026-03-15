import { useState, useCallback } from 'react'
import { getEntityColor } from '../../config/entityTypes'
import type { ClusterData } from '../../types/explore'

interface ClusterBubbleProps {
  cluster: ClusterData
  dimmed: boolean
  isSuggested?: boolean
  duplicateCount?: number
  cameraZoom?: number
  isSubAnchor?: boolean
  subAnchorCount?: number
  isSelected?: boolean
  onHover: (cluster: ClusterData | null, event: React.MouseEvent) => void
  onClick: (cluster: ClusterData) => void
  onDoubleClick?: (cluster: ClusterData) => void
}

export function ClusterBubble({
  cluster,
  dimmed,
  isSuggested = false,
  duplicateCount = 0,
  cameraZoom = 1,
  isSubAnchor = false,
  subAnchorCount = 0,
  isSelected = false,
  onHover,
  onClick,
  onDoubleClick,
}: ClusterBubbleProps) {
  const [hovered, setHovered] = useState(false)
  const { cx, cy, r } = cluster.position
  const entityColor = getEntityColor(cluster.anchor.entityType)

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    setHovered(true)
    onHover(cluster, e)
  }, [cluster, onHover])

  const handleMouseLeave = useCallback((e: React.MouseEvent) => {
    setHovered(false)
    onHover(null, e)
  }, [onHover])

  const handleClick = useCallback(() => {
    onClick(cluster)
  }, [cluster, onClick])

  const handleDoubleClick = useCallback(() => {
    onDoubleClick?.(cluster)
  }, [cluster, onDoubleClick])

  const scale = hovered && !dimmed ? 1.08 : 1

  // Truncate label
  const maxChars = isSubAnchor ? 14 : 20
  const label = cluster.anchor.label.length > maxChars
    ? cluster.anchor.label.slice(0, maxChars - 1) + '…'
    : cluster.anchor.label

  return (
    <g
      transform={`translate(${cx}, ${cy})`}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
      style={{
        cursor: 'pointer',
        transition: 'opacity 0.18s ease',
        opacity: dimmed ? 0.12 : 1,
      }}
    >
      <g transform={`scale(${scale})`} style={{ transition: 'transform 0.15s ease' }}>
        {/* Selection ring */}
        {isSelected && !dimmed && (
          <circle
            r={r + 5}
            fill="none"
            stroke="var(--color-accent-500)"
            strokeWidth={2}
            opacity={0.6}
          />
        )}

        {/* Filled circle — dashed for sub-anchors, dotted for suggested, solid for roots */}
        <circle
          r={r}
          fill={isSuggested ? 'rgba(245,158,11,0.12)' : isSubAnchor ? `${entityColor}15` : `${entityColor}22`}
          stroke={isSuggested ? 'rgba(245,158,11,0.5)' : entityColor}
          strokeWidth={isSuggested ? 1 : isSubAnchor ? 1.5 : 2}
          strokeDasharray={isSuggested ? '3 2' : isSubAnchor ? '6 3' : 'none'}
          strokeOpacity={isSubAnchor ? 0.7 : 1}
        />

        {/* Hover glow ring */}
        {hovered && !dimmed && !isSelected && (
          <circle
            r={r + 4}
            fill="none"
            stroke={isSuggested ? 'rgba(245,158,11,0.25)' : `${entityColor}35`}
            strokeWidth={2}
          />
        )}

        {/* Entity count inside circle — on hover or deep zoom */}
        {(hovered || cameraZoom >= 1.8) && !isSuggested && cluster.entityCount > 0 && (
          <text
            y={1}
            textAnchor="middle"
            dominantBaseline="middle"
            style={{
              fontFamily: 'var(--font-body)',
              fontSize: Math.max(7, r * 0.5),
              fontWeight: 700,
              fill: entityColor,
              opacity: 0.45,
              pointerEvents: 'none',
              userSelect: 'none',
            }}
          >
            {cluster.entityCount}
          </text>
        )}

        {/* Suggested score inside circle — on hover */}
        {isSuggested && hovered && (
          <text
            y={1} textAnchor="middle" dominantBaseline="middle"
            style={{ fontFamily: 'var(--font-body)', fontSize: 7, fontWeight: 700, fill: '#d97706', pointerEvents: 'none', userSelect: 'none' }}
          >
            {Math.round(((cluster as ClusterData & { compositeScore?: number }).compositeScore ?? 0) * 100)}%
          </text>
        )}

        {/* Sub-anchor count badge on parent clusters */}
        {subAnchorCount > 0 && !isSubAnchor && (
          <g transform={`translate(${r * 0.6}, ${r * 0.6})`}>
            <circle r={7} fill={`${entityColor}26`} stroke={entityColor} strokeWidth={1} strokeOpacity={0.4} />
            <text textAnchor="middle" dominantBaseline="middle"
              style={{ fontFamily: 'var(--font-body)', fontSize: 7, fontWeight: 700, fill: entityColor, pointerEvents: 'none', userSelect: 'none' }}>
              {subAnchorCount}
            </text>
          </g>
        )}
      </g>

      {/* ── Label BELOW the circle — always visible ── */}
      <text
        y={r + 12}
        textAnchor="middle"
        style={{
          fontFamily: 'var(--font-display)',
          fontSize: isSubAnchor ? 7 : 9,
          fontWeight: 600,
          fill: isSuggested ? 'rgba(217,119,6,0.7)'
            : isSelected ? 'var(--color-accent-500)'
            : hovered ? 'var(--color-text-primary)'
            : 'var(--color-text-secondary)',
          pointerEvents: 'none',
          userSelect: 'none',
          transition: 'fill 0.15s ease',
        }}
      >
        {label}
      </text>

      {/* Suggested ✦ marker below label */}
      {isSuggested && (
        <text
          y={r + 21}
          textAnchor="middle"
          style={{ fontFamily: 'var(--font-body)', fontSize: 7, fontWeight: 700, fill: '#d97706', pointerEvents: 'none', userSelect: 'none' }}
        >
          ✦ Suggested
        </text>
      )}

      {/* +N similar — on hover */}
      {isSuggested && duplicateCount > 0 && hovered && (
        <text
          y={r + 29} textAnchor="middle"
          style={{ fontFamily: 'var(--font-body)', fontSize: 6, fontWeight: 600, fill: 'var(--color-text-secondary)', pointerEvents: 'none', userSelect: 'none' }}
        >
          +{duplicateCount} similar
        </text>
      )}
    </g>
  )
}
