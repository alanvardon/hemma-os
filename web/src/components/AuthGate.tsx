// AuthGate — the top-level login wall (plan 16a). No Supabase session → a
// passwordless magic-link screen; a session → the app. Wraps the router in
// App.tsx, inside ThemeContext so the login screen is themed. Supabase persists
// the session in localStorage and refreshes it, so this asks for a link roughly
// once per device.
import { useEffect, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'

// undefined = still restoring the persisted session (brief); null = signed out.
type SessionState = Session | null | undefined

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>(undefined)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setSession(data.session))
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  if (session === undefined) {
    // Restoring session — keep it blank rather than flashing the login screen.
    return <div className="auth-splash" aria-hidden="true" />
  }

  if (session === null) return <MagicLinkScreen />

  return <>{children}</>
}

function MagicLinkScreen() {
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')

  async function sendLink(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setStatus('sending')
    setError('')
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      // Land back on the bare app root (no hash route) so the magic-link tokens
      // don't collide with React Router — plan 16a.
      options: { emailRedirectTo: window.location.origin + window.location.pathname },
    })
    if (error) {
      setStatus('error')
      setError(error.message)
    } else {
      setStatus('sent')
    }
  }

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <p className="auth-kicker">Hemma·OS</p>
        {status === 'sent' ? (
          <>
            <h1 className="auth-title">Kolla din inkorg</h1>
            <p className="auth-lead">
              Vi har skickat en inloggningslänk till <strong>{email}</strong>. Öppna
              den på den här enheten för att logga in.
            </p>
            <button
              type="button"
              className="btn btn-ghost auth-reset"
              onClick={() => setStatus('idle')}
            >
              Använd en annan e-post
            </button>
          </>
        ) : (
          <>
            <h1 className="auth-title">Logga in</h1>
            <p className="auth-lead">
              Ange din e-post så skickar vi en inloggningslänk — inget lösenord
              behövs.
            </p>
            <form className="auth-form" onSubmit={sendLink}>
              <input
                type="email"
                className="auth-input"
                placeholder="din@epost.se"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="email"
                required
                autoFocus
              />
              <button
                type="submit"
                className="btn btn-primary auth-submit"
                disabled={status === 'sending'}
              >
                {status === 'sending' ? 'Skickar…' : 'Skicka länk'}
              </button>
            </form>
            {status === 'error' && <p className="auth-error">{error}</p>}
          </>
        )}
      </div>
    </div>
  )
}
