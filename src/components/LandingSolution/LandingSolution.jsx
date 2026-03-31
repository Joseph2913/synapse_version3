import IngestSVG from './cards/IngestSVG';
import ExtractSVG from './cards/ExtractSVG';
import McpSVG from './cards/McpSVG';
import AskSVG from './cards/AskSVG';
import AnchorsSVG from './cards/AnchorsSVG';
import './LandingSolution.css';

const CARDS = [
  {
    key: 'ingest',
    label: 'INGEST ANYTHING',
    desc: 'Drop any format in — YouTube, meetings, documents, notes, web clips. Synapse processes everything automatically.',
    SVG: IngestSVG,
  },
  {
    key: 'extract',
    label: 'EXTRACT ENTITIES & RELATIONSHIPS',
    desc: '24 typed entities extracted automatically. People, decisions, risks, insights — all connected across your history.',
    SVG: ExtractSVG,
  },
  {
    key: 'mcp',
    label: 'CONNECT AI AGENTS VIA MCP',
    desc: 'Synapse exposes your graph as a live MCP server. Claude, GPT-4, or any agent can query your nodes directly.',
    SVG: McpSVG,
  },
  {
    key: 'ask',
    label: 'ASK YOUR KNOWLEDGE BASE',
    desc: 'Natural language Graph RAG. Every answer cited and grounded exclusively in your own ingested sources.',
    SVG: AskSVG,
  },
  {
    key: 'anchors',
    label: 'AUTO-DISCOVER ANCHORS',
    desc: 'Nodes scored continuously across centrality, diversity, velocity, and engagement. The most important concepts surface automatically.',
    SVG: AnchorsSVG,
  },
];

export default function LandingSolution() {
  return (
    <section className="lp-solution-section">
      <div className="lp-solution-inner">
        <span className="lp-solution-eyebrow">&mdash; OUR SOLUTION</span>
        <h2 className="lp-solution-headline">
          Five ways your knowledge starts <em>working for you.</em>
        </h2>

        <div className="lp-solution-grid">
          {CARDS.map((card) => (
            <div key={card.key} className={`lp-sol-card lp-sol-card--${card.key}`}>
              <span className="lp-sol-card-label">{card.label}</span>
              <p className="lp-sol-card-desc">{card.desc}</p>
              <div className="lp-sol-card-svg">
                <card.SVG />
              </div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
