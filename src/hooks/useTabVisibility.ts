import { useEffect, useRef } from 'react'

/**
 * Shared hook to detect browser tab visibility.
 * Used by all RAF loops to pause animation when the tab is hidden
 * and resume cleanly (without accumulated dt jumps) when visible.
 */
export function useTabVisibility(): {
  visibleRef: React.MutableRefObject<boolean>
  lastHiddenAtRef: React.MutableRefObject<number>
} {
  const visibleRef = useRef(!document.hidden)
  const lastHiddenAtRef = useRef(0)

  useEffect(() => {
    const handler = () => {
      if (document.hidden) {
        visibleRef.current = false
        lastHiddenAtRef.current = performance.now()
      } else {
        visibleRef.current = true
      }
    }
    document.addEventListener('visibilitychange', handler)
    return () => document.removeEventListener('visibilitychange', handler)
  }, [])

  return { visibleRef, lastHiddenAtRef }
}
