import { useState, useEffect, useRef } from 'react';

const PROBLEMS = [
  {
    num: '/01',
    category: 'COGNITIVE LOAD',
    headline: 'The Thinking Tax',
    body: 'Your brain was built to think, not to remember. Every open loop you carry — the insight from that meeting, the pattern you noticed last month — is occupying compute that should be generating new thought. The cost isn\'t forgetting. It\'s the thinking that never happened.',
    cta: 'See how Synapse thinks \u2192',
  },
  {
    num: '/02',
    category: 'KNOWLEDGE FRAGMENTATION',
    headline: 'The Missing Link',
    body: 'The raw material for your best thinking already exists — scattered across transcripts, documents, highlights, and recordings. A concept from six months ago that directly challenges your current strategy. Those links never form automatically. You\'re not missing information. You\'re missing infrastructure.',
    cta: 'See how Synapse connects \u2192',
  },
  {
    num: '/03',
    category: 'KNOWLEDGE CONVERSION',
    headline: 'Input \u2260 Understanding',
    body: 'You\'ve read it, watched it, highlighted it, noted it. But consuming knowledge and building knowledge are not the same thing. Information only becomes knowledge when it\'s connected, tested, and integrated into a structure that can be built upon. Storage isn\'t thinking.',
    cta: 'See how Synapse extracts \u2192',
  },
  {
    num: '/04',
    category: 'AGENT INFRASTRUCTURE',
    headline: 'Every Session. Zero Memory.',
    body: 'Every AI conversation you have begins with amnesia. The context from last week, the pattern you noticed across three client calls, the framework you built over months — none of it is visible to the model. Every time a more capable model ships, a well-structured knowledge graph gets smarter automatically. The infrastructure compounds. The gap widens.',
    cta: 'See how Synapse feeds agents \u2192',
  },
];

export default function TextPanel({ activeIndex, hasEntered }) {
  const [displayIndex, setDisplayIndex] = useState(activeIndex);
  const [isTransitioning, setIsTransitioning] = useState(false);
  const timeoutRef = useRef(null);

  useEffect(() => {
    if (activeIndex === displayIndex) return;

    setIsTransitioning(true);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setDisplayIndex(activeIndex);
      setIsTransitioning(false);
    }, 220);

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [activeIndex, displayIndex]);

  const problem = PROBLEMS[displayIndex];

  return (
    <div
      className="lp-text-panel"
      style={{
        opacity: hasEntered ? 1 : 0,
        transition: 'opacity 400ms var(--lp-ease-out)',
      }}
    >
      <div
        className="lp-text-panel-inner"
        style={{
          opacity: isTransitioning ? 0 : 1,
          transform: isTransitioning ? 'translateY(-16px)' : 'translateY(0)',
          transition: isTransitioning
            ? 'opacity 200ms ease, transform 200ms ease'
            : 'opacity 400ms var(--lp-ease-out), transform 400ms var(--lp-ease-out)',
        }}
      >
        <span className="lp-text-category">
          {problem.num} &mdash; {problem.category}
        </span>
        <h3 className="lp-text-headline">{problem.headline}</h3>
        <p className="lp-text-body">{problem.body}</p>
        <span className="lp-text-cta">{problem.cta}</span>
      </div>
    </div>
  );
}
