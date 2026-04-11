import { useState } from 'react'
import { supabase } from '../../services/supabase'
import { SynapseLogo } from '../shared/SynapseLogo'

export function LoginPage() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGoogleSignIn = async () => {
    setError(null)
    setLoading(true)

    const { error } = await supabase.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin },
    })

    if (error) {
      setError(error.message)
      setLoading(false)
    }
  }

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
          width: 380,
          background: 'var(--color-bg-card)',
          border: '1px solid var(--border-subtle)',
          borderRadius: 16,
          padding: '40px 36px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
        }}
      >
        <SynapseLogo size={48} />

        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontSize: 20,
            fontWeight: 800,
            color: 'var(--color-text-primary)',
            marginTop: 12,
            marginBottom: 28,
          }}
        >
          Synapse
        </div>

        {error && (
          <div
            style={{
              width: '100%',
              fontSize: 12,
              color: 'var(--color-semantic-red-500)',
              marginBottom: 12,
              textAlign: 'center',
            }}
          >
            {error}
          </div>
        )}

        <button
          type="button"
          onClick={handleGoogleSignIn}
          disabled={loading}
          style={{
            width: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            background: loading ? '#f5f5f5' : '#ffffff',
            border: '1px solid var(--border-subtle)',
            borderRadius: 8,
            padding: '11px 0',
            fontSize: 13,
            fontWeight: 500,
            color: 'var(--color-text-primary)',
            cursor: loading ? 'not-allowed' : 'pointer',
            transition: 'all 0.15s ease',
            fontFamily: 'var(--font-body)',
          }}
          onMouseEnter={(e) => {
            if (!loading) e.currentTarget.style.background = 'var(--color-bg-inset)'
          }}
          onMouseLeave={(e) => {
            if (!loading) e.currentTarget.style.background = '#ffffff'
          }}
        >
          {!loading && (
            <svg width="18" height="18" viewBox="0 0 48 48">
              <path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/>
              <path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/>
              <path fill="#FBBC05" d="M10.53 28.59a14.5 14.5 0 0 1 0-9.18l-7.98-6.19a24.01 24.01 0 0 0 0 21.56l7.98-6.19z"/>
              <path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/>
            </svg>
          )}
          {loading ? 'Redirecting...' : 'Sign in with Google'}
        </button>
      </div>
    </div>
  )
}
