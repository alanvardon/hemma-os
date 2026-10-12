// AuthGate — the top-level login wall (plan 16a). No Supabase session → a
// passwordless magic-link screen; a session → the app. Wraps the router in
// App.tsx, inside ThemeContext so the login screen is themed. Supabase persists
// the session in localStorage and refreshes it, so this asks for a link roughly
// once per device.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Session } from '@supabase/supabase-js'
import { supabase } from '../lib/supabase'
import { claimHousehold, signOut } from '../lib/household'
import {
  activateSyncIdentity,
  hasPendingDeviceRemoval,
  quarantineSyncIdentity,
  retryPendingDeviceRemoval,
} from '../lib/sync'
import {
  importLegacyToActiveNamespace,
  leaveLegacyQuarantined,
  quarantineLegacyData,
  removeLegacyQuarantine,
  shouldOfferLegacyImport,
} from '../lib/legacy-data'
import { persistenceErrorMessage } from '../lib/persistence-error'
import {
  OTP_LENGTH,
  OTP_RESEND_COOLDOWN_MS,
  otpErrorMessage,
  resendSecondsLeft,
  sanitizeOtpInput,
} from '../lib/auth-otp'
import { useTheme } from '../App'
import auroraMp4 from '../assets/auth/aurora.mp4'
import auroraPosterAvif from '../assets/auth/aurora-poster.avif'
import auroraPosterJpg from '../assets/auth/aurora-poster.jpg'

// undefined = still restoring the persisted session (brief); null = signed out.
type SessionState = Session | null | undefined
type ProvisioningState = 'loading' | 'ready' | 'error'

export default function AuthGate({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionState>(undefined)
  // A signed-in user might not have a household yet (fresh account / invitee).
  // Gate the app on claim_household so the tool stores never read before one
  // exists. A failed claim stays closed until Retry succeeds or the user signs
  // out.
  const [provisioning, setProvisioning] = useState<ProvisioningState>('loading')
  const [provisioningError, setProvisioningError] = useState('')
  const [retryCount, setRetryCount] = useState(0)
  const [legacyPrompt, setLegacyPrompt] = useState(false)
  const claimedFor = useRef<string | null>(null)

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      // Dev-only: on localhost against a local Supabase, auto-sign-in a throwaway
      // test user so we skip the magic-link screen. Gated on DEV + dynamically
      // imported, so devAuth (and its credentials) are excluded from prod builds.
      if (import.meta.env.DEV && !data.session) {
        void import('../lib/devAuth').then((m) => m.maybeDevSignIn()).catch(() => {
          // Local-only convenience failed; the normal login screen remains.
        })
      }
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (!session) {
      quarantineSyncIdentity()
      claimedFor.current = null
      setProvisioning('loading')
      setProvisioningError('')
      setLegacyPrompt(false)
      return
    }
    const uid = session.user.id
    if (claimedFor.current === uid) {
      setProvisioning('ready')
      return
    }
    let alive = true
    setProvisioning('loading')
    setProvisioningError('')
    claimHousehold()
      .then((householdId) => {
        if (!alive) return
        // Both claims are required. A user id alone must never select a cache
        // namespace or make queued household writes eligible for replay.
        activateSyncIdentity({ userId: uid, householdId })
        if (!quarantineLegacyData()) {
          quarantineSyncIdentity()
          throw new Error('legacy-quarantine-failed')
        }
        setLegacyPrompt(shouldOfferLegacyImport())
        claimedFor.current = uid
        setProvisioning('ready')
      })
      .catch((error) => {
        if (!alive) return
        quarantineSyncIdentity()
        setProvisioningError(error instanceof Error && error.message === 'legacy-quarantine-failed'
          ? 'Äldre lokal data kunde inte säkras. Kontrollera enhetens lagring och försök igen.'
          : persistenceErrorMessage(error))
        setProvisioning('error')
      })
    return () => { alive = false }
  }, [session, retryCount])

  if (session === undefined) {
    // Restoring session — keep it blank rather than flashing the login screen.
    return <div className="auth-splash" aria-hidden="true" />
  }

  if (session === null) return hasPendingDeviceRemoval()
    ? <PendingDeviceRemovalScreen />
    : <MagicLinkScreen />

  if (provisioning === 'error') {
    return (
      <ProvisioningErrorScreen
        message={provisioningError}
        onRetry={() => setRetryCount((n) => n + 1)}
      />
    )
  }

  // Session present but the household claim hasn't resolved yet — brief splash.
  if (provisioning !== 'ready') return <div className="auth-splash" aria-hidden="true" />

  if (legacyPrompt) return <LegacyDataScreen onDone={() => setLegacyPrompt(false)} />

  return <>{children}</>
}

function PendingDeviceRemovalScreen() {
  const { theme } = useTheme()
  const [error, setError] = useState('')
  const [done, setDone] = useState(false)

  function retry() {
    setError('')
    try {
      retryPendingDeviceRemoval()
      setDone(true)
    } catch {
      setError('Lokal data kunde inte tas bort. Kontrollera enhetens lagring och försök igen.')
    }
  }

  if (done) return <MagicLinkScreen />
  return (
    <div className="auth-screen">
      {theme === 'dark' && <AuroraBackdrop />}
      <div className="auth-card">
        <p className="auth-kicker">Hemma·OS</p>
        <h1 className="auth-title">Slutför lokal datarensning</h1>
        <p className="auth-lead">Du är utloggad, men hushållets lokala data kunde inte tas bort från enheten.</p>
        <button type="button" className="btn btn-primary" onClick={retry}>Försök ta bort igen</button>
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

function LegacyDataScreen({ onDone }: { onDone: () => void }) {
  const { theme } = useTheme()
  const [busy, setBusy] = useState(false)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [error, setError] = useState('')

  async function handleImport() {
    setBusy(true)
    setError('')
    try {
      await importLegacyToActiveNamespace()
      onDone()
    } catch {
      setError('Importen avbröts. Ingen äldre data har tagits bort. Försök igen.')
      setBusy(false)
    }
  }

  function handleLeave() {
    leaveLegacyQuarantined()
    onDone()
  }

  function handleRemove() {
    if (!confirmRemove) { setConfirmRemove(true); return }
    removeLegacyQuarantine()
    onDone()
  }

  return (
    <div className="auth-screen">
      {theme === 'dark' && <AuroraBackdrop />}
      <div className="auth-card">
        <p className="auth-kicker">Hemma·OS</p>
        <h1 className="auth-title">Äldre data på den här enheten</h1>
        <p className="auth-lead">
          Datan saknar konto- och hushållskoppling. Importera den bara om den
          tillhör hushållet du är inloggad i nu.
        </p>
        <div className="auth-recovery-actions">
          <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void handleImport()}>
            {busy ? 'Importerar…' : 'Importera till detta hushåll'}
          </button>
          <button type="button" className="btn btn-ghost" disabled={busy} onClick={handleLeave}>
            Lämna kvar på enheten
          </button>
        </div>
        <button type="button" className="btn btn-ghost auth-reset" disabled={busy} onClick={handleRemove}>
          {confirmRemove ? 'Bekräfta: ta bort äldre data' : 'Ta bort äldre data'}
        </button>
        {confirmRemove && (
          <p className="auth-error">Detta tar permanent bort den äldre lokala datan från enheten.</p>
        )}
        {error && <p className="auth-error" role="alert">{error}</p>}
      </div>
    </div>
  )
}

function ProvisioningErrorScreen({ message, onRetry }: { message: string; onRetry: () => void }) {
  const { theme } = useTheme()
  const [signOutError, setSignOutError] = useState('')

  async function handleSignOut() {
    setSignOutError('')
    try {
      await signOut()
    } catch (error) {
      setSignOutError(persistenceErrorMessage(error))
    }
  }

  return (
    <div className="auth-screen">
      {theme === 'dark' && <AuroraBackdrop />}
      <div className="auth-card" role="alert">
        <p className="auth-kicker">Hemma·OS</p>
        <h1 className="auth-title">Hushållet kunde inte öppnas</h1>
        <p className="auth-lead">{message || 'Försök igen om en stund.'}</p>
        <div className="auth-recovery-actions">
          <button type="button" className="btn btn-primary" onClick={onRetry}>Försök igen</button>
          <button type="button" className="btn btn-ghost" onClick={() => void handleSignOut()}>Logga ut</button>
        </div>
        {signOutError && <p className="auth-error">{signOutError}</p>}
      </div>
    </div>
  )
}

/* Aurora backdrop (plan 34) — real Lofoten footage behind the login card,
   dark theme only. Mounted conditionally so light theme never downloads a
   byte of it. The poster paints first; the video crossfades in once frames
   are actually flowing (`onPlaying`) — if autoplay is denied (iOS low-power
   mode) nothing fires and the poster simply stays. prefers-reduced-motion
   skips the <video> element entirely. */
function AuroraBackdrop() {
  const [playing, setPlaying] = useState(false)
  const reduceMotion = useRef(
    window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  ).current
  return (
    <div className="auth-scene" aria-hidden="true">
      <picture>
        <source srcSet={auroraPosterAvif} type="image/avif" />
        <img className="auth-scene-layer" src={auroraPosterJpg} alt="" />
      </picture>
      {!reduceMotion && (
        <video
          className="auth-scene-layer auth-scene-video"
          src={auroraMp4}
          autoPlay
          muted
          loop
          playsInline
          preload="auto"
          data-playing={playing || undefined}
          onPlaying={() => setPlaying(true)}
        />
      )}
      <div className="auth-scene-scrim" />
    </div>
  )
}

// Same options for the first send and every "Skicka ny kod", so a resend
// behaves exactly like the original request.
function requestEmailOtp(email: string) {
  // Hardening (plan 46): the server-side hook_before_user_created is the real
  // signup gate now. Backend details are deliberately not rendered. Always
  // requesting shouldCreateUser: true is safe: existing
  // users (the seeded couple) sign in as normal, invited partners self-onboard,
  // and strangers get the hook's rejection instead of a silent no-op email.
  return supabase.auth.signInWithOtp({
    email,
    // Land back on the bare app root (no hash route) so the magic-link tokens
    // don't collide with React Router — plan 16a.
    options: {
      emailRedirectTo: window.location.origin + window.location.pathname,
      shouldCreateUser: true,
    },
  })
}

function MagicLinkScreen() {
  const { theme } = useTheme()
  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')
  const [error, setError] = useState('')
  // Sent phase (plan 136): the email carries both the link and a 6-digit code.
  const [code, setCode] = useState('')
  const [verifying, setVerifying] = useState(false)
  const [codeError, setCodeError] = useState('')
  const [notice, setNotice] = useState('')
  const [resending, setResending] = useState(false)
  const [resendAt, setResendAt] = useState(0) // epoch ms when resend unlocks
  const [now, setNow] = useState(0)
  const codeInput = useRef<HTMLInputElement>(null)
  // Synchronous guard: state updates are async, so a fast double event could
  // otherwise fire two verifyOtp calls for one code.
  const verifyInFlight = useRef(false)

  // One ticking interval while the resend cooldown runs; cleared on unmount.
  useEffect(() => {
    if (resendAt <= Date.now()) return
    const id = window.setInterval(() => {
      const t = Date.now()
      setNow(t)
      if (t >= resendAt) window.clearInterval(id)
    }, 1000)
    return () => window.clearInterval(id)
  }, [resendAt])

  // After a failed verify the input is re-enabled; hand focus back to it.
  useEffect(() => {
    if (codeError && !verifying) codeInput.current?.focus()
  }, [codeError, verifying])

  function startCooldown() {
    const t = Date.now()
    setNow(t)
    setResendAt(t + OTP_RESEND_COOLDOWN_MS)
  }

  async function sendLink(e: React.FormEvent) {
    e.preventDefault()
    if (!email.trim()) return
    setStatus('sending')
    setError('')
    const { error } = await requestEmailOtp(email.trim())
    if (error) {
      setStatus('error')
      setError('Kunde inte skicka inloggningslänken. Försök igen.')
    } else {
      startCooldown()
      setStatus('sent')
    }
  }

  async function verify(token: string) {
    if (token.length !== OTP_LENGTH || verifyInFlight.current) return
    verifyInFlight.current = true
    setVerifying(true)
    setCodeError('')
    setNotice('')
    let message = ''
    try {
      const { error } = await supabase.auth.verifyOtp({ email: email.trim(), token, type: 'email' })
      // Success needs nothing here: onAuthStateChange swaps in the app.
      if (error) message = otpErrorMessage(error)
    } catch (thrown) {
      message = otpErrorMessage(thrown)
    }
    verifyInFlight.current = false
    setVerifying(false)
    setCodeError(message)
  }

  function onCodeChange(raw: string) {
    const next = sanitizeOtpInput(raw)
    if (next === code) return
    setCode(next)
    // Auto-submit from the change event rather than an effect, so it fires
    // once per completed code even when StrictMode re-runs effects.
    if (next.length === OTP_LENGTH) void verify(next)
  }

  async function resend() {
    if (resending) return
    setResending(true)
    setCodeError('')
    setNotice('')
    let failed = false
    try {
      failed = Boolean((await requestEmailOtp(email.trim())).error)
    } catch {
      failed = true
    }
    setResending(false)
    if (failed) {
      setCodeError('Kunde inte skicka en ny kod. Försök igen om en stund.')
      return
    }
    // The server invalidates the previous code, so drop the stale one.
    setCode('')
    startCooldown()
    setNotice('En ny kod har skickats. Den gamla slutar gälla.')
  }

  function resetToEmailForm() {
    setStatus('idle')
    setCode('')
    setCodeError('')
    setNotice('')
  }

  const secondsLeft = resendSecondsLeft(resendAt, now)

  return (
    <div className="auth-screen">
      {theme === 'dark' && <AuroraBackdrop />}
      <div className="auth-card">
        <p className="auth-kicker">Hemma·OS</p>
        {status === 'sent' ? (
          <>
            <h1 className="auth-title">Kolla din inkorg</h1>
            <p className="auth-lead">
              Vi har skickat ett mejl till <strong>{email}</strong>. Skriv in koden
              från mejlet, eller öppna länken på den här enheten.
            </p>
            <form
              className="auth-form"
              onSubmit={(e) => {
                e.preventDefault()
                void verify(code)
              }}
            >
              <label className="auth-label" htmlFor="auth-code">Kod från mejlet</label>
              {/* No maxLength: it would cut a pasted "123 456" to "123 45" before
                  onChange runs. sanitizeOtpInput caps the value at 6 digits. */}
              <input
                ref={codeInput}
                id="auth-code"
                type="text"
                className="auth-input auth-code"
                inputMode="numeric"
                autoComplete="one-time-code"
                pattern="[0-9]*"
                value={code}
                onChange={(e) => onCodeChange(e.target.value)}
                disabled={verifying}
                aria-invalid={codeError ? true : undefined}
                aria-describedby={codeError ? 'auth-code-error' : undefined}
                autoFocus
              />
              <button
                type="submit"
                className="btn btn-primary auth-submit"
                disabled={verifying || code.length !== OTP_LENGTH}
              >
                {verifying ? 'Loggar in…' : 'Logga in'}
              </button>
            </form>
            {/* Reserved height so the error/notice line doesn't shift the buttons. */}
            <div className="auth-code-feedback">
              {codeError ? (
                <p id="auth-code-error" className="auth-error" role="alert">{codeError}</p>
              ) : notice ? (
                <p className="auth-notice" role="status">{notice}</p>
              ) : null}
            </div>
            <div className="auth-code-actions">
              <button
                type="button"
                className="btn btn-ghost"
                onClick={() => void resend()}
                disabled={secondsLeft > 0 || resending}
              >
                {secondsLeft > 0 ? `Skicka ny kod (${secondsLeft} s)` : 'Skicka ny kod'}
              </button>
              <button type="button" className="btn btn-ghost" onClick={resetToEmailForm}>
                Använd en annan e-post
              </button>
            </div>
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
