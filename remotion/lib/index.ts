/**
 * Synapse Remotion Design Kit
 *
 * Import from here in any composition:
 *   import { fonts, accent, Heading, FadeIn, SynapseLogo } from "../lib";
 */

// Design tokens
export { bg, text, accent, semantic, entity, border, typeScale, spacing } from "./tokens";
export type { EntityType } from "./tokens";

// Font families
export { fonts, fontsReady } from "./fonts";

// Logo components
export { SynapseLogo } from "./SynapseLogo";

// Layout & typography components
export {
  DarkBackground,
  LightBackground,
  LinkedInBackground,
  Heading,
  BodyText,
  EditorialText,
  SectionLabel,
  AccentBar,
  EntityBadge,
  FadeIn,
  GrowBar,
} from "./components";
