import { FlameMark } from './FlameMark'

interface WordmarkProps {
  color?: string
  size?: number
}

export function Wordmark({ color = '#1A1612', size = 18 }: WordmarkProps) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 9,
      fontFamily: 'Cabinet Grotesk, sans-serif', fontWeight: 900,
      fontSize: size, letterSpacing: '-0.02em', color,
    }}>
      <FlameMark size={size * 0.95} />
      <span>synapse</span>
    </div>
  )
}
