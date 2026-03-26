export type { EntityType, SourceType, RelationType, KnowledgeNode, KnowledgeEdge, KnowledgeSource, UserProfile, ExtractionSettings } from './database'
export type { RightPanelContent, FeedItem } from './panels'
export type { NavItem, CommandPaletteItem } from './navigation'

export type {
  AnchorCandidateStatus,
  AnchorScoringProfile,
  VelocityDirection,
  AnchorCandidate,
  AnchorCandidateWithNode,
  AnchorUserConfig,
  AnchorCandidateUpsert,
  AnchorCandidateStatusUpdate,
  AnchorHealthSummary,
  SignalWeights,
  ThresholdPreset,
} from './anchors'

export {
  SCORING_PROFILE_LABELS,
  SCORING_PROFILE_DESCRIPTIONS,
  SIGNAL_WEIGHTS_BY_PROFILE,
  DEFAULT_ANCHOR_USER_CONFIG,
  THRESHOLD_PRESETS,
} from './anchors'

export type { AnchorCandidateRow, PotentialDuplicateRow } from './database'
