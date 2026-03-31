import { useState, useEffect, useRef } from 'react';
import ParticleGraph from './ParticleGraph';
import './LandingHero.css';

const TYPEWRITER_TEXT = 'Automatically. Permanently.';
const START_DELAY = 1200;
const CHAR_DELAY = 55;
const CURSOR_LINGER = 1800;

export default function LandingHero() {
  const [typed, setTyped] = useState('');
  const [cursorDone, setCursorDone] = useState(false);
  const indexRef = useRef(0);

  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  useEffect(() => {
    if (prefersReducedMotion) {
      setTyped(TYPEWRITER_TEXT);
      setCursorDone(true);
      return;
    }

    const startTimer = setTimeout(() => {
      const interval = setInterval(() => {
        indexRef.current++;
        if (indexRef.current > TYPEWRITER_TEXT.length) {
          clearInterval(interval);
          setTimeout(() => setCursorDone(true), CURSOR_LINGER);
          return;
        }
        setTyped(TYPEWRITER_TEXT.slice(0, indexRef.current));
      }, CHAR_DELAY);

      return () => clearInterval(interval);
    }, START_DELAY);

    return () => clearTimeout(startTimer);
  }, [prefersReducedMotion]);

  return (
    <section className="lp-hero">
      <div className="hero-grain" aria-hidden="true" />
      <div className="hero-glow" aria-hidden="true" />
      <ParticleGraph />

      <div className="lp-hero-inner">
        <div className="hero-content">
          <span className="hero-eyebrow">&mdash; YOUR SECOND BRAIN</span>

          <h1 className="hero-headline">
            Your knowledge,<br />
            finally <em className="hero-accent">connected</em>.
            <span className="hero-pulse-dot" />
          </h1>

          <div className="hero-typewriter-line" aria-label={TYPEWRITER_TEXT}>
            <span className="hero-typewriter-text">{typed}</span>
            {!cursorDone && (
              <span
                className={`hero-cursor${typed.length === TYPEWRITER_TEXT.length ? ' hero-cursor--fading' : ''}`}
                aria-hidden="true"
              />
            )}
          </div>

          <p className="hero-subheading">
            Synapse ingests your meetings, videos, documents, and notes —
            extracts every entity and relationship — and builds a living knowledge
            graph you can explore, query, and connect to any AI agent.
          </p>

          <div className="hero-cta-row">
            <button className="hero-btn-primary" type="button">
              Join the waitlist <span className="btn-arrow">&rarr;</span>
            </button>
            <button className="hero-btn-secondary" type="button">
              See how it works
            </button>
          </div>
        </div>
      </div>

      <div className="hero-scroll-hint">
        <div className="hero-scroll-mouse">
          <div className="hero-scroll-wheel" />
        </div>
        <span className="hero-scroll-label">scroll to explore</span>
      </div>
    </section>
  );
}
