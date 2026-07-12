// HouseholdMenu — the household / account surface (plan 16h). A small header
// button opens a dialog to see who's in the household, invite a partner by email
// (a pending household_invites row they auto-join on first sign-in), withdraw a
// pending invite, and sign out. Plan 50 adds the two lifecycle paths for someone
// who was already provisioned: an "accept invite to another household" banner and
// a "leave household" action, both via security-definer RPCs. All data access
// goes through lib/household.ts, which is RLS-scoped to the caller's household.
import { useEffect, useState } from 'react'
import AnimatedDialog from './AnimatedDialog'
import { supabase } from '../lib/supabase'
import {
  acceptInvite,
  createInvite,
  leaveHousehold,
  listInvites,
  listMembers,
  pendingInviteToJoin,
  removeInvite,
  signOut,
  type Invite,
  type Member,
} from '../lib/household'
import { persistenceErrorMessage } from '../lib/persistence-error'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function HouseholdMenu() {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        type="button"
        className="household-btn"
        title="Hushåll"
        aria-label="Hushåll"
        onClick={() => setOpen(true)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <circle cx="9" cy="8" r="3" />
          <path d="M15.5 11a2.6 2.6 0 1 0-2.3-3.8" />
          <path d="M3.5 19v-1a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v1" />
          <path d="M16.5 14.2A4 4 0 0 1 20.5 18v1" />
        </svg>
      </button>
      <AnimatedDialog open={open} onOpenChange={setOpen} contentClassName="modal modal-narrow">
        <HouseholdPanel open={open} onClose={() => setOpen(false)} />
      </AnimatedDialog>
    </>
  )
}

function roleLabel(role: string): string {
  return role === 'owner' ? 'Ägare' : 'Medlem'
}

function HouseholdPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [email, setEmail] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [invitedElsewhere, setInvitedElsewhere] = useState(false)
  const [invite, setInvite] = useState('')
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')

  // Load the current user + household state each time the dialog opens.
  useEffect(() => {
    if (!open) return
    let alive = true
    setConfirmLeave(false)
    setError('')
    setActionError('')
    supabase.auth.getUser().then(({ data }) => { if (alive) setEmail(data.user?.email ?? null) })
    Promise.all([listMembers(), listInvites(), pendingInviteToJoin()]).then(([m, i, pending]) => {
      if (!alive) return
      setMembers(m)
      setInvites(i)
      setInvitedElsewhere(pending)
    })
    return () => { alive = false }
  }, [open])

  // Accept an invite to another household, then fully reload so every store
  // re-reads under the new household. See lib/household.acceptInvite.
  async function onAccept() {
    setBusy(true)
    setActionError('')
    try {
      await acceptInvite()
      window.location.reload()
    } catch {
      setBusy(false)
      setActionError('Kunde inte gå med — försök igen.')
    }
  }

  // Leave the current household (two-step confirm). Reloads on success so the
  // stores fall back to the fresh household claim_household provisions next.
  async function onLeave() {
    if (!confirmLeave) { setConfirmLeave(true); setActionError(''); return }
    setBusy(true)
    setActionError('')
    try {
      await leaveHousehold()
      window.location.reload()
    } catch {
      setBusy(false)
      setConfirmLeave(false)
      setActionError('Kunde inte lämna hushållet — försök igen.')
    }
  }

  async function refreshInvites() {
    setInvites(await listInvites())
  }

  async function onInvite(e: React.FormEvent) {
    e.preventDefault()
    const addr = invite.trim().toLowerCase()
    setError('')
    if (!EMAIL_RE.test(addr)) { setError('Ogiltig e-postadress.'); return }
    if (addr === email?.toLowerCase()) { setError('Det är du.'); return }
    if (invites.some((i) => i.email === addr)) { setError('Redan inbjuden.'); return }
    setBusy(true)
    try {
      await createInvite(addr)
      setInvite('')
      await refreshInvites()
    } catch {
      setError('Kunde inte bjuda in — försök igen.')
    } finally {
      setBusy(false)
    }
  }

  async function onRemove(addr: string) {
    setBusy(true)
    setActionError('')
    try {
      await removeInvite(addr)
      await refreshInvites()
    } catch (error) {
      setActionError(persistenceErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }

  async function onSignOut() {
    setActionError('')
    try { await signOut() } catch (error) { setActionError(persistenceErrorMessage(error)) }
  }

  return (
    <>
      <div className="modal-header">
        <h2 className="modal-title">Hushåll</h2>
        <button type="button" className="modal-close" aria-label="Stäng" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        {invitedElsewhere && (
          <section className="hh-section hh-invite-banner">
            <p className="hh-banner-title">Du är inbjuden till ett annat hushåll</p>
            <p className="modal-note hh-banner-note">
              Gå med för att dela data med hushållet som bjöd in dig. Ditt nuvarande
              hushåll lämnas orört.
            </p>
            <button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy}>
              Gå med i hushållet
            </button>
            {actionError && <p className="auth-error hh-error">{actionError}</p>}
          </section>
        )}
        <section className="hh-section">
          <p className="const-group-title">Inloggad</p>
          <div className="hh-account-row">
            <span className="hh-email">{email ?? '…'}</span>
            <button type="button" className="btn btn-ghost hh-signout" onClick={() => void onSignOut()}>Logga ut</button>
          </div>
        </section>

        <section className="hh-section">
          <p className="const-group-title">Medlemmar</p>
          {members.length === 0 ? (
            <p className="modal-note">Bara du än så länge.</p>
          ) : (
            <ul className="hh-list">
              {members.map((m) => {
                const isYou = !!m.email && m.email.toLowerCase() === email?.toLowerCase()
                return (
                  <li key={m.user_id} className="hh-list-row">
                    <span className="hh-role-dot" data-role={m.role} aria-hidden="true" />
                    <span className="hh-member-email">
                      {m.email ?? 'Okänd medlem'}
                      {isYou && <span className="hh-you"> (du)</span>}
                    </span>
                    <span className="hh-role">{roleLabel(m.role)}</span>
                  </li>
                )
              })}
            </ul>
          )}
        </section>

        <section className="hh-section">
          <p className="const-group-title">Bjud in en partner</p>
          <p className="modal-note hh-invite-note">
            De går med automatiskt när de loggar in med sin länk första gången.
          </p>
          <form className="hh-invite-form" onSubmit={onInvite}>
            <input
              type="email"
              className="hh-invite-input"
              placeholder="partner@epost.se"
              value={invite}
              onChange={(e) => { setInvite(e.target.value); setError('') }}
              autoComplete="off"
            />
            <button type="submit" className="btn btn-primary" disabled={busy || !invite.trim()}>
              Bjud in
            </button>
          </form>
          {error && <p className="auth-error hh-error">{error}</p>}

          {invites.length > 0 && (
            <ul className="hh-list hh-invites">
              {invites.map((i) => (
                <li key={i.email} className="hh-list-row hh-invite-row">
                  <span className="hh-invite-email">{i.email}</span>
                  <span className="hh-pending">Väntar</span>
                  <button
                    type="button"
                    className="drift-delete"
                    aria-label={`Ta bort inbjudan till ${i.email}`}
                    disabled={busy}
                    onClick={() => onRemove(i.email)}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="hh-section hh-leave-section">
          <div className="hh-leave-row">
            <div className="hh-leave-copy">
              <p className="hh-leave-title">Lämna hushåll</p>
              <p className="modal-note hh-leave-note">
                Du tas bort från hushållet. Ett nytt, tomt hushåll skapas åt dig
                nästa gång du loggar in.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-ghost hh-leave-btn"
              data-confirm={confirmLeave}
              onClick={onLeave}
              disabled={busy}
            >
              {confirmLeave ? 'Bekräfta' : 'Lämna'}
            </button>
          </div>
          {!invitedElsewhere && actionError && (
            <p className="auth-error hh-error">{actionError}</p>
          )}
        </section>
      </div>
    </>
  )
}
