const STEPS = ['01', '02', '03', '04'];

export default function StepRail({ activeIndex, stepProgress, hasEntered }) {
  return (
    <div className="lp-step-rail" aria-hidden="true">
      <div className="lp-step-rail-line" />
      {STEPS.map((num, i) => {
        const isPast = i < activeIndex;
        const isActive = i === activeIndex;

        let dotStyle = {};
        if (isActive) {
          dotStyle = {
            border: '1.5px solid var(--lp-accent)',
            background: 'var(--lp-accent)',
          };
        } else if (isPast) {
          dotStyle = {
            border: '1.5px solid rgba(232,98,42,0.35)',
            background: 'rgba(232,98,42,0.20)',
          };
        } else {
          dotStyle = {
            border: '1.5px solid rgba(240,237,230,0.15)',
            background: 'transparent',
          };
        }

        return (
          <div
            key={num}
            className="lp-step-rail-dot-group"
            style={{
              opacity: hasEntered ? 1 : 0,
              transform: hasEntered ? 'translateX(0)' : 'translateX(-8px)',
              transition: `opacity 400ms var(--lp-ease-out) ${i * 60}ms, transform 400ms var(--lp-ease-out) ${i * 60}ms`,
            }}
          >
            <div className="lp-step-rail-dot" style={dotStyle} />
            <span
              className="lp-step-rail-num"
              style={{
                color: isActive ? 'var(--lp-inv-text)' : 'rgba(240,237,230,0.20)',
              }}
            >
              {num}
            </span>
          </div>
        );
      })}
    </div>
  );
}
