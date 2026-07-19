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
  pendingInviteStatus,
  removeInvite,
  signOut,
  type Invite,
  type Member,
  type PendingInviteStatus,
} from '../lib/household'
import { persistenceErrorMessage } from '../lib/persistence-error'
import type { SyncIdentity } from '../lib/sync-coordinator'
import {
  prepareSyncForSignOut,
  prepareSyncForHouseholdTransition,
  completeSyncHouseholdTransition,
  completeSyncSignOut,
  restoreSyncAfterFailedHouseholdTransition,
  restoreSyncAfterFailedSignOut,
  syncCoordinator,
} from '../lib/sync'
import { hasLegacyQuarantine, removeLegacyQuarantine } from '../lib/legacy-data'
import HouseholdPeopleSection from './HouseholdPeopleSetup'
import { usePersonIdentity } from './usePersonIdentity'
import { PersonAvatar, PersonLabel, personInitials } from './PersonBadge'

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// The tool routes (Hushållsbudget, Månadsavslut, Bolånekoll) link to identity
// management once bound. They don't own the household dialog, so they ask for it
// via this event; the always-mounted HouseholdMenu opens itself in response.
const OPEN_EVENT = 'hemma:open-household'
export function openHouseholdDialog() {
  window.dispatchEvent(new CustomEvent(OPEN_EVENT))
}

export default function HouseholdMenu() {
  const [open, setOpen] = useState(false)
  // When the signed-in account is mapped to a household person, the trigger
  // becomes that person's initial avatar (plan 111); it keeps the same
  // accessible label and still opens the household dialog.
  const { myPerson } = usePersonIdentity()

  useEffect(() => {
    const openIt = () => setOpen(true)
    window.addEventListener(OPEN_EVENT, openIt)
    return () => window.removeEventListener(OPEN_EVENT, openIt)
  }, [])

  return (
    <>
      <button
        type="button"
        className="household-btn"
        title="Hushåll"
        aria-label="Hushåll"
        onClick={() => setOpen(true)}
      >
        {myPerson ? (
          <span className="household-btn-avatar" aria-hidden="true">{personInitials(myPerson.display_name)}</span>
        ) : (
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="9" cy="8" r="3" />
            <path d="M15.5 11a2.6 2.6 0 1 0-2.3-3.8" />
            <path d="M3.5 19v-1a4 4 0 0 1 4-4h3a4 4 0 0 1 4 4v1" />
            <path d="M16.5 14.2A4 4 0 0 1 20.5 18v1" />
          </svg>
        )}
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
  const { myPerson } = usePersonIdentity()
  const [email, setEmail] = useState<string | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [invites, setInvites] = useState<Invite[]>([])
  const [inviteStatus, setInviteStatus] = useState<PendingInviteStatus>('none')
  const [invite, setInvite] = useState('')
  const [confirmLeave, setConfirmLeave] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [actionError, setActionError] = useState('')
  const [signOutChoice, setSignOutChoice] = useState<'closed' | 'choose' | 'confirm-remove'>('closed')
  const [confirmLegacyRemove, setConfirmLegacyRemove] = useState(false)

  // Load the current user + household state each time the dialog opens.
  useEffect(() => {
    if (!open) return
    let alive = true
    setConfirmLeave(false)
    setError('')
    setActionError('')
    supabase.auth.getUser().then(({ data }) => { if (alive) setEmail(data.user?.email ?? null) })
    Promise.all([listMembers(), listInvites(), pendingInviteStatus()]).then(([m, i, pending]) => {
      if (!alive) return
      setMembers(m)
      setInvites(i)
      setInviteStatus(pending)
    })
    return () => { alive = false }
  }, [open])

  // Accept an invite to another household, then fully reload so every store
  // re-reads under the new household. See lib/household.acceptInvite.
  async function onAccept() {
    setBusy(true)
    setActionError('')
    let snapshot: SyncIdentity | null = null
    try {
      snapshot = await prepareSyncForHouseholdTransition()
      if (!snapshot) throw new Error('No active household')
      await acceptInvite()
      completeSyncHouseholdTransition(snapshot)
      window.location.reload()
    } catch (error) {
      if (snapshot) restoreSyncAfterFailedHouseholdTransition(snapshot)
      setBusy(false)
      setActionError(persistenceErrorMessage(error))
    }
  }

  // Leave the current household (two-step confirm). Reloads on success so the
  // stores fall back to the fresh household claim_household provisions next.
  async function onLeave() {
    if (!confirmLeave) { setConfirmLeave(true); setActionError(''); return }
    setBusy(true)
    setActionError('')
    let snapshot: SyncIdentity | null = null
    try {
      snapshot = await prepareSyncForHouseholdTransition()
      if (!snapshot) throw new Error('No active household')
      await leaveHousehold()
      completeSyncHouseholdTransition(snapshot)
      window.location.reload()
    } catch {
      if (snapshot) restoreSyncAfterFailedHouseholdTransition(snapshot)
      setBusy(false)
      setConfirmLeave(false)
      setActionError('Kunde inte lämna hushållet — försök igen.')
    }
  }

  async function refreshInvites() {
    setInvites(await listInvites())
  }

  async function refreshMembers() {
    setMembers(await listMembers())
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

  async function onSignOut(removeLocalData: boolean) {
    setActionError('')
    setBusy(true)
    let snapshot: SyncIdentity | null = null
    let serverSignedOut = false
    try {
      snapshot = await prepareSyncForSignOut(removeLocalData)
      if (!snapshot) throw new Error('No active household')
      await signOut()
      serverSignedOut = true
      completeSyncSignOut(snapshot, removeLocalData)
      setSignOutChoice('closed')
      onClose()
    } catch (error) {
      if (snapshot && !serverSignedOut) restoreSyncAfterFailedSignOut(snapshot)
      setBusy(false)
      setActionError(serverSignedOut
        ? 'Du är utloggad, men lokal data kunde inte tas bort. Försök igen från inloggningssidan.'
        : persistenceErrorMessage(error))
    }
  }

  function onRemoveLegacy() {
    if (!confirmLegacyRemove) { setConfirmLegacyRemove(true); return }
    removeLegacyQuarantine()
    setConfirmLegacyRemove(false)
  }

  return (
    <>
      <div className="modal-header">
        <h2 className="modal-title">Hushåll</h2>
        <button type="button" className="modal-close" aria-label="Stäng" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">
        {inviteStatus !== 'none' && (
          <section className="hh-section hh-invite-banner">
            <p className="hh-banner-title">
              {inviteStatus === 'ambiguous' ? 'Flera hushåll har bjudit in dig' : 'Du är inbjuden till ett annat hushåll'}
            </p>
            {inviteStatus === 'ambiguous' ? (
              <p className="modal-note hh-banner-note">
                Du kan gå med när bara en aktiv inbjudan återstår. Be hushållen du
                inte vill gå med i att ta bort sina inbjudningar.
              </p>
            ) : (
              <>
                <p className="modal-note hh-banner-note">
                  Gå med för att dela data med hushållet som bjöd in dig. Om du är
                  ensam i ditt nuvarande hushåll måste det vara tomt på sparad data.
                </p>
                <button type="button" className="btn btn-primary" onClick={onAccept} disabled={busy}>
                  Gå med i hushållet
                </button>
              </>
            )}
            {actionError && <p className="auth-error hh-error">{actionError}</p>}
          </section>
        )}
        <section className="hh-section">
          <p className="const-group-title">Inloggad</p>
          <div className="hh-account-row">
            {myPerson && (
              <PersonAvatar name={myPerson.display_name} self size="md" decorative={false} />
            )}
            <div className="hh-account-identity">
              {myPerson && (
                <PersonLabel name={myPerson.display_name} self className="hh-account-name" />
              )}
              <span className="hh-email">{email ?? '…'}</span>
            </div>
            <button type="button" className="btn btn-ghost hh-signout" onClick={() => setSignOutChoice('choose')}>Logga ut</button>
          </div>
          {signOutChoice !== 'closed' && (
            <div className="hh-signout-choice" role="group" aria-label="Välj hur lokal data ska hanteras">
              <p className="modal-note">
                {syncCoordinator.getOutbox().length > 0
                  ? 'Det finns ändringar som väntar på att synkas. Behåll dem på enheten om du vill försöka igen senare.'
                  : 'Välj om hushållets lokala data ska finnas kvar på den här enheten.'}
              </p>
              {signOutChoice === 'confirm-remove' ? (
                <>
                  <p className="auth-error">All lokal hushållsdata och väntande ändringar för ditt konto tas bort från enheten efter att utloggningen lyckats.</p>
                  <button type="button" className="btn btn-danger" disabled={busy} onClick={() => void onSignOut(true)}>Bekräfta och logga ut</button>
                </>
              ) : (
                <>
                  <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void onSignOut(false)}>Behåll på enheten och logga ut</button>
                  <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setSignOutChoice('confirm-remove')}>Ta bort från enheten och logga ut</button>
                </>
              )}
              <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setSignOutChoice('closed')}>Avbryt</button>
              <p className="modal-note">Äldre data i karantän hanteras separat.</p>
            </div>
          )}
          {hasLegacyQuarantine() && (
            <div className="hh-legacy-data">
              <button type="button" className="btn btn-ghost" onClick={onRemoveLegacy}>
                {confirmLegacyRemove ? 'Bekräfta: ta bort äldre lokal data' : 'Ta bort äldre lokal data'}
              </button>
              {confirmLegacyRemove && <p className="auth-error">Detta går inte att ångra.</p>}
            </div>
          )}
        </section>

        <HouseholdPeopleSection members={members} myEmail={email} onSaved={() => void refreshMembers()} />

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
                    {m.person_display_name && (
                      <PersonAvatar name={m.person_display_name} self={isYou} other={!isYou} size="sm" />
                    )}
                    <span className="hh-member-email">
                      {m.person_display_name ? (
                        <PersonLabel name={m.person_display_name} self={isYou} variant="audit" className="hh-member-person" />
                      ) : (
                        isYou && <span className="hh-you">(du) </span>
                      )}
                      <span className="hh-member-addr">{m.email ?? 'Okänd medlem'}</span>
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
          {inviteStatus === 'none' && actionError && (
            <p className="auth-error hh-error">{actionError}</p>
          )}
        </section>
      </div>
    </>
  )
}
