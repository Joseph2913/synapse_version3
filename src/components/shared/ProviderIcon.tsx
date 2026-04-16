import { getSourceConfig, getProviderConfig } from '../../config/sourceTypes'

interface ProviderIconProps {
  sourceType: string | null | undefined
  provider?: string | null
  size?: number
  borderRadius?: number
}

/**
 * Renders a provider-specific logo (YouTube, Circleback, Fireflies, etc.)
 * when available, falling back to the generic source-type emoji icon.
 *
 * Usage: <ProviderIcon sourceType="Meeting" provider="circleback" size={36} />
 */
export function ProviderIcon({
  sourceType,
  provider,
  size = 36,
  borderRadius = 8,
}: ProviderIconProps) {
  const cfg = getSourceConfig(sourceType)

  // Resolve provider: YouTube/GitHub sources always use their provider logo
  const effectiveProvider = sourceType === 'YouTube' ? 'youtube'
    : sourceType === 'GitHub' ? 'github'
    : provider
  const providerCfg = getProviderConfig(effectiveProvider)

  // Use provider color if available, otherwise source type color
  const bgColor = providerCfg?.color ?? cfg.color

  if (providerCfg?.logo) {
    return (
      <div
        style={{
          width: size,
          height: size,
          borderRadius,
          background: bgColor + '14',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          overflow: 'hidden',
        }}
      >
        <img
          src={providerCfg.logo}
          alt={providerCfg.label}
          width={size * 0.55}
          height={size * 0.55}
          style={{ objectFit: 'contain', borderRadius: 3 }}
        />
      </div>
    )
  }

  // Fallback: generic emoji icon
  return (
    <div
      style={{
        width: size,
        height: size,
        borderRadius,
        background: bgColor + '12',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.44,
        flexShrink: 0,
      }}
    >
      {cfg.icon}
    </div>
  )
}
