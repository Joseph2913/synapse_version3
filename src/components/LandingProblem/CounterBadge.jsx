const RADIUS = 14;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;
const TOTAL_STEPS = 4;

export default function CounterBadge({ activeIndex, progress }) {
  const offset = CIRCUMFERENCE * (1 - progress);
  const display = String(activeIndex + 1).padStart(2, '0');

  return (
    <div className="lp-counter-badge">
      <svg width="36" height="36" viewBox="0 0 36 36">
        {/* Track */}
        <circle
          cx="18" cy="18" r={RADIUS}
          fill="none"
          stroke="rgba(240,237,230,0.12)"
          strokeWidth="2"
        />
        {/* Progress arc */}
        <circle
          cx="18" cy="18" r={RADIUS}
          fill="none"
          stroke="var(--lp-accent)"
          strokeWidth="2"
          strokeLinecap="round"
          strokeDasharray={CIRCUMFERENCE}
          strokeDashoffset={offset}
          style={{ transform: 'rotate(-90deg)', transformOrigin: 'center' }}
        />
      </svg>

      {/* Pip dots */}
      <div className="lp-counter-pips">
        {Array.from({ length: TOTAL_STEPS }).map((_, i) => (
          <span
            key={i}
            className="lp-counter-pip"
            style={{
              background: i <= activeIndex ? 'var(--lp-accent)' : 'rgba(240,237,230,0.15)',
            }}
          />
        ))}
      </div>

      {/* Counter text */}
      <span className="lp-counter-text">
        {display} / {String(TOTAL_STEPS).padStart(2, '0')}
      </span>
    </div>
  );
}
