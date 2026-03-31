import {
  User, Building2, Users, BookOpen, FolderKanban, Target, Zap,
  AlertTriangle, ShieldAlert, Scale, Lightbulb, HelpCircle, Sparkles,
  Brain, GraduationCap, FileText, CalendarDays, MapPin, Cpu,
  Package, BarChart3, FlaskConical, Anchor,
  type LucideIcon,
} from 'lucide-react'
import { getEntityColor } from '../../config/entityTypes'

const ENTITY_ICONS: Record<string, LucideIcon> = {
  Person: User,
  Organization: Building2,
  Team: Users,
  Topic: BookOpen,
  Project: FolderKanban,
  Goal: Target,
  Action: Zap,
  Risk: AlertTriangle,
  Blocker: ShieldAlert,
  Decision: Scale,
  Insight: Lightbulb,
  Question: HelpCircle,
  Idea: Sparkles,
  Concept: Brain,
  Takeaway: GraduationCap,
  Lesson: GraduationCap,
  Document: FileText,
  Event: CalendarDays,
  Location: MapPin,
  Technology: Cpu,
  Product: Package,
  Metric: BarChart3,
  Hypothesis: FlaskConical,
  Anchor: Anchor,
}

interface EntityIconProps {
  entityType: string
  size?: number
}

export function EntityIcon({ entityType, size = 28 }: EntityIconProps) {
  const Icon = ENTITY_ICONS[entityType] ?? Brain
  const color = getEntityColor(entityType)

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
