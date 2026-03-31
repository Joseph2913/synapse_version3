import Card01WorkingMemory from './cards/Card01WorkingMemory';
import Card02SiloMap from './cards/Card02SiloMap';
import Card03ConversionPipeline from './cards/Card03ConversionPipeline';
import Card04AgentContext from './cards/Card04AgentContext';

const CARDS = [
  {
    num: '/01',
    title: 'Working Memory Drain',
    subtitle: 'Active cognitive load — current session',
    Illustration: Card01WorkingMemory,
  },
  {
    num: '/02',
    title: 'Knowledge Silo Map',
    subtitle: 'Cross-source relationship density — current state',
    Illustration: Card02SiloMap,
  },
  {
    num: '/03',
    title: 'Knowledge Conversion Pipeline',
    subtitle: 'Content ingested vs. structured knowledge extracted',
    Illustration: Card03ConversionPipeline,
  },
  {
    num: '/04',
    title: 'Agent Context Initialisation',
    subtitle: 'Knowledge available to AI — session start',
    Illustration: Card04AgentContext,
  },
];

export default function ProblemCard({ index, position }) {
  const card = CARDS[index];
  const { Illustration } = card;

  const posStyles = {
    front:     { transform: 'translateY(0) scale(1)', opacity: 1, filter: 'none', zIndex: 4 },
    'behind-1': { transform: 'translateY(28px) scale(0.96)', opacity: 0.55, filter: 'blur(0.5px)', zIndex: 3 },
    'behind-2': { transform: 'translateY(52px) scale(0.93)', opacity: 0.28, filter: 'blur(1px)', zIndex: 2 },
    exiting:   { transform: 'translateY(-48px) scale(0.97)', opacity: 0, filter: 'none', zIndex: 5 },
    hidden:    { transform: 'translateY(52px) scale(0.93)', opacity: 0, filter: 'none', zIndex: 1 },
  };

  const style = posStyles[position] || posStyles.hidden;

  return (
    <div
      className="lp-problem-card"
      data-pos={position}
      style={{
        ...style,
        transition: 'transform 1.2s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 1.2s ease-out, filter 1.2s ease-out',
      }}
    >
      {/* Card header */}
      <div className="lp-card-header">
        <div className="lp-card-icon">
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="3" fill="var(--lp-accent)" />
          </svg>
        </div>
        <div className="lp-card-meta">
          <span className="lp-card-num">{card.num}</span>
          <span className="lp-card-title">{card.title}</span>
          <span className="lp-card-subtitle">{card.subtitle}</span>
        </div>
      </div>

      {/* SVG illustration */}
      <div className="lp-card-svg-area">
        <Illustration />
      </div>
    </div>
  );
}
