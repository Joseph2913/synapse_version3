import { useState, useEffect, useCallback } from 'react';

export function useScrollProgress(ref) {
  const [progress, setProgress] = useState(0);

  const calculate = useCallback(() => {
    if (!ref.current) return;
    const rect = ref.current.getBoundingClientRect();
    const totalScroll = ref.current.offsetHeight - window.innerHeight;
    const scrolled = -rect.top;
    setProgress(Math.max(0, Math.min(1, scrolled / totalScroll)));
  }, [ref]);

  useEffect(() => {
    window.addEventListener('scroll', calculate, { passive: true });
    calculate();
    return () => window.removeEventListener('scroll', calculate);
  }, [calculate]);

  return progress;
}
