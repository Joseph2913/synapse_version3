import { useRef, useState, useEffect } from 'react';
import ProblemCard from './ProblemCard';

const TOTAL = 4;

function getPosition(cardIndex, activeIndex) {
  if (cardIndex === activeIndex) return 'front';
  if (cardIndex === activeIndex + 1) return 'behind-1';
  if (cardIndex === activeIndex + 2) return 'behind-2';
  if (cardIndex === activeIndex - 1) return 'exiting';
  return 'hidden';
}

export default function CardStack({ activeIndex, hasEntered }) {
  // Track previous activeIndex for exiting card
  const prevRef = useRef(activeIndex);
  const [exitingIndex, setExitingIndex] = useState(-1);

  useEffect(() => {
    if (prevRef.current !== activeIndex) {
      setExitingIndex(prevRef.current);
      prevRef.current = activeIndex;
      const timer = setTimeout(() => setExitingIndex(-1), 1200);
      return () => clearTimeout(timer);
    }
  }, [activeIndex]);

  return (
    <div
      className="lp-card-stack"
      style={{
        opacity: hasEntered ? 1 : 0,
        transition: 'opacity 600ms var(--lp-ease-out)',
      }}
    >
      {Array.from({ length: TOTAL }).map((_, i) => {
        let pos = getPosition(i, activeIndex);
        if (i === exitingIndex && pos === 'hidden') {
          pos = 'exiting';
        }
        return <ProblemCard key={i} index={i} position={pos} />;
      })}
    </div>
  );
}
