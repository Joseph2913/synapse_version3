import { useState, useCallback, useRef } from 'react'

interface SpotlightReturn {
  spotlightRef: React.RefObject<HTMLDivElement | null>
  active: boolean
  position: { x: number; y: number }
  handlers: {
    onMouseMove: (e: React.MouseEvent) => void
    onMouseEnter: () => void
    onMouseLeave: () => void
  }
}

export function useSpotlight(): SpotlightReturn {
  const spotlightRef = useRef<HTMLDivElement | null>(null)
  const [active, setActive] = useState(false)
  const [position, setPosition] = useState({ x: 0, y: 0 })

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    const el = e.currentTarget as HTMLElement
    const rect = el.getBoundingClientRect()
    setPosition({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
    })
  }, [])

  const onMouseEnter = useCallback(() => setActive(true), [])
  const onMouseLeave = useCallback(() => setActive(false), [])

  return {
    spotlightRef,
    active,
    position,
    handlers: { onMouseMove, onMouseEnter, onMouseLeave },
  }
}
