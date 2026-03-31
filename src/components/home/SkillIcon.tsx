import {
  Brain, Code, Palette, PenTool, BarChart3, MessageSquare,
  Globe, Shield, Briefcase, Megaphone, Wrench, BookOpen,
  Heart, Microscope, Scale, Cog, Rocket, Users, Lightbulb,
  type LucideIcon,
} from 'lucide-react'

// Map common skill domains to specific icons
const DOMAIN_ICONS: Record<string, { icon: LucideIcon; color: string }> = {
  ai:             { icon: Brain,          color: '#7c3aed' },
  'artificial intelligence': { icon: Brain, color: '#7c3aed' },
  'machine learning': { icon: Brain,     color: '#7c3aed' },
  engineering:    { icon: Code,           color: '#2563eb' },
  software:       { icon: Code,           color: '#2563eb' },
  development:    { icon: Code,           color: '#2563eb' },
  programming:    { icon: Code,           color: '#2563eb' },
  design:         { icon: Palette,        color: '#ec4899' },
  ux:             { icon: Palette,        color: '#ec4899' },
  ui:             { icon: Palette,        color: '#ec4899' },
  writing:        { icon: PenTool,        color: '#0891b2' },
  content:        { icon: PenTool,        color: '#0891b2' },
  communication:  { icon: MessageSquare,  color: '#0ea5e9' },
  analytics:      { icon: BarChart3,      color: '#6366f1' },
  data:           { icon: BarChart3,      color: '#6366f1' },
  marketing:      { icon: Megaphone,      color: '#f59e0b' },
  sales:          { icon: Briefcase,      color: '#d97706' },
  business:       { icon: Briefcase,      color: '#d97706' },
  strategy:       { icon: Rocket,         color: '#059669' },
  management:     { icon: Users,          color: '#0891b2' },
  leadership:     { icon: Users,          color: '#0891b2' },
  security:       { icon: Shield,         color: '#dc2626' },
  compliance:     { icon: Scale,          color: '#7c3aed' },
  legal:          { icon: Scale,          color: '#7c3aed' },
  operations:     { icon: Cog,            color: '#6b7280' },
  research:       { icon: Microscope,     color: '#8b5cf6' },
  science:        { icon: Microscope,     color: '#8b5cf6' },
  health:         { icon: Heart,          color: '#ef4444' },
  education:      { icon: BookOpen,       color: '#10b981' },
  learning:       { icon: BookOpen,       color: '#10b981' },
  training:       { icon: BookOpen,       color: '#10b981' },
  tools:          { icon: Wrench,         color: '#f59e0b' },
  product:        { icon: Rocket,         color: '#059669' },
  innovation:     { icon: Lightbulb,      color: '#eab308' },
  international:  { icon: Globe,          color: '#0ea5e9' },
  global:         { icon: Globe,          color: '#0ea5e9' },
}

// Generate a deterministic color from a string
function hashColor(str: string): string {
  const colors = [
    '#d97706', '#7c3aed', '#0891b2', '#059669', '#e11d48',
    '#2563eb', '#dc2626', '#db2777', '#6366f1', '#0ea5e9',
    '#8b5cf6', '#14b8a6', '#ca8a04', '#4f46e5', '#65a30d',
  ]
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash)
  }
  return colors[Math.abs(hash) % colors.length] ?? '#6b7280'
}

function resolveDomainIcon(domain: string | null): { icon: LucideIcon; color: string } {
  if (!domain) return { icon: Lightbulb, color: '#6b7280' }

  const lower = domain.toLowerCase().trim()

  // Exact match
  if (DOMAIN_ICONS[lower]) return DOMAIN_ICONS[lower]!

  // Partial match — check if any key is contained in the domain
  for (const [key, val] of Object.entries(DOMAIN_ICONS)) {
    if (lower.includes(key) || key.includes(lower)) return val
  }

  // Fallback: deterministic color from domain name
  return { icon: Lightbulb, color: hashColor(domain) }
}

interface SkillIconProps {
  domain: string | null
  size?: number
}

export function SkillIcon({ domain, size = 28 }: SkillIconProps) {
  const { icon: Icon, color } = resolveDomainIcon(domain)

  return (
    <div
      className="shrink-0 flex items-center justify-center"
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `${color}12`,
      }}
    >
      <Icon size={size * 0.5} style={{ color }} />
    </div>
  )
}
