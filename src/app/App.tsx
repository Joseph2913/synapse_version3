import { AuthProvider } from './providers/AuthProvider'
import { SettingsProvider } from './providers/SettingsProvider'
import { GraphProvider } from './providers/GraphProvider'
import { ProcessingProvider } from './providers/ProcessingProvider'
import { Router } from './Router'
import { LoginPage } from '../components/auth/LoginPage'
import { useAuth } from '../hooks/useAuth'

function AuthGate({ children }: { children: React.ReactNode }) {
  const { session, loading } = useAuth()

  if (loading) {
    return (
      <div
        style={{
          width: '100vw',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-bg-content)',
        }}
      >
        <div
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--border-subtle)',
            borderTopColor: 'var(--color-accent-500)',
            borderRadius: '50%',
            animation: 'spin 0.8s linear infinite',
          }}
        />
      </div>
    )
  }

  if (!session) {
    return <LoginPage />
  }

  return <>{children}</>
}

export default function App() {
  return (
    <AuthProvider>
      <AuthGate>
        <SettingsProvider>
          <GraphProvider>
            <ProcessingProvider>
              <Router />
            </ProcessingProvider>
          </GraphProvider>
        </SettingsProvider>
      </AuthGate>
    </AuthProvider>
  )
}
