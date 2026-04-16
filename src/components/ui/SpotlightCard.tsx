import { useRef, useState, useCallback } from 'react'

interface SpotlightCardProps {
  children: React.ReactNode
  color?: string
  radius?: number
  className?: string
  style?: React.CSSProperties
  onClick?: (e: React.MouseEvent) => void
  onMouseEnter?: (e: React.MouseEvent) => void
  onMouseLeave?: (e: React.MouseEvent) => void
}

export function SpotlightCard({
  children,
  color = 'rgba(214, 58, 0, 0.4)',
  radius = 200,
  className,
  style,
  onClick,
  onMouseEnter: externalMouseEnter,
  onMouseLeave: externalMouseLeave,
}: SpotlightCardProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const [active, setActive] = useState(false)
  const [pos, setPos] = useState({ x: 0, y: 0 })

  const handleMouseMove = useCallback((e: React.MouseEvent) => {
    const el = containerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setPos({ x: e.clientX - rect.left, y: e.clientY - rect.top })
  }, [])

  const handleMouseEnter = useCallback((e: React.MouseEvent) => {
    setActive(true)
    externalMouseEnter?.(e)
  }, [externalMouseEnter])

  const handleMouseLeave = useCallback((e: React.MouseEvent) => {
    setActive(false)
    externalMouseLeave?.(e)
  }, [externalMouseLeave])

  return (
    <div
      ref={containerRef}
      className={className}
      style={{ ...style, position: 'relative', overflow: 'hidden' }}
      onClick={onClick}
      onMouseMove={handleMouseMove}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
    >
      {children}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          inset: -1,
          borderRadius: 'inherit',
          pointerEvents: 'none',
          opacity: active ? 1 : 0,
          transition: 'opacity 0.3s var(--ease-out-expo)',
          background: `radial-gradient(${radius}px circle at ${pos.x}px ${pos.y}px, ${color}, transparent 65%)`,
          padding: 1,
          WebkitMask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          mask: 'linear-gradient(#fff 0 0) content-box, linear-gradient(#fff 0 0)',
          WebkitMaskComposite: 'xor',
          maskComposite: 'exclude' as React.CSSProperties['maskComposite'],
        }}
      />
    </div>
  )
}
