import { useRef, useState, useEffect } from 'react';
import { useScrollProgress } from '../../hooks/useScrollProgress';
import useProblemCycle from './useProblemCycle';
import StepRail from './StepRail';
import TextPanel from './TextPanel';
import CardStack from './CardStack';
import CounterBadge from './CounterBadge';
import './LandingProblem.css';

export default function LandingProblem() {
  const sectionRef = useRef(null);
  const scrollFraction = useScrollProgress(sectionRef);
  const { activeIndex, stepProgress } = useProblemCycle(scrollFraction);
  const [hasEntered, setHasEntered] = useState(false);

  useEffect(() => {
    if (scrollFraction > 0 && !hasEntered) setHasEntered(true);
  }, [scrollFraction, hasEntered]);

  return (
    <section ref={sectionRef} className="lp-problem-section">
      <div className="lp-problem-noise" aria-hidden="true" />

      <div className="lp-problem-sticky">
        <div className="lp-problem-container">
          {/* Column 1: StepRail (desktop only, 56px wide) */}
          <StepRail
            activeIndex={activeIndex}
            stepProgress={stepProgress}
            hasEntered={hasEntered}
          />

          {/* Column 2: Header + TextPanel */}
          <div className="lp-problem-left">
            <div className="lp-problem-header">
              <span className="lp-problem-eyebrow">&mdash; THE HIDDEN COST</span>
              <h2 className="lp-problem-headline">
                Silent losses. <em>Real consequences.</em>
              </h2>
            </div>

            <TextPanel activeIndex={activeIndex} hasEntered={hasEntered} />
          </div>

          {/* Column 3: Card stack (desktop only) */}
          <div className="lp-problem-cards-column">
            <div className="lp-column-counter">
              <CounterBadge activeIndex={activeIndex} progress={stepProgress} />
            </div>
            <CardStack
              activeIndex={activeIndex}
              hasEntered={hasEntered}
            />
          </div>

          {/* Mobile only: bottom counter badge */}
          <div className="lp-problem-bottom-counter">
            <CounterBadge
              activeIndex={activeIndex}
              progress={stepProgress}
            />
          </div>
        </div>
      </div>
    </section>
  );
}
