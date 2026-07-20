// PersonBadge — shared visual primitives for the signed-in-person treatment
// (plan 111, Stage 4). One small, genuinely shared set used by HouseholdMenu,
// Bolånekoll, Hushållsbudget, Månadsavslut and the hub summaries so the "Du"
// language is identical everywhere:
//
//   • PersonAvatar       — initials; filled accent for self, outlined copper for other.
//   • PersonLabel        — canonical name + a visible, accessibly-named "Du" chip.
//   • PersonColumnHeader — the shared comparison-column treatment (accent edge for self).
//
// This is a PERSPECTIVE treatment, not a hierarchy: self is emphasized in place,
// never enlarged, reordered, or coloured positive/negative. `self` is always
// paired with text ("Du"), so the distinction is never colour-only. A person
// that is neither self nor other (joint/unknown) uses the neutral treatment.
import type { ReactNode } from 'react'

/** Initials for an avatar: first letters of the first and last word, else the
    first two characters of a single word. Locale-aware upper-casing (sv-SE). */
export function personInitials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const raw = words.length >= 2
    ? (words[0][0] ?? '') + (words[words.length - 1][0] ?? '')
    : (words[0] ?? '').slice(0, 2)
  return raw.toLocaleUpperCase('sv-SE')
}

export type PersonTone = 'self' | 'other' | 'neutral'

function toneOf(self: boolean | undefined, other: boolean | undefined): PersonTone {
  if (self) return 'self'
  if (other) return 'other'
  return 'neutral'
}

interface PersonAvatarProps {
  name: string
  self?: boolean
  other?: boolean
  size?: 'sm' | 'md'
  /** When false, the avatar carries its own accessible name (name + "du" for
      self) — use for a standalone avatar (e.g. the homepage trigger). Default
      true: the avatar is decorative because a text label sits beside it. */
  decorative?: boolean
  className?: string
}

/** Initials avatar. Filled accent = self, outlined copper = other, neutral
    otherwise. Decorative by default; pass decorative={false} when it stands
    alone. */
export function PersonAvatar({
  name, self, other, size = 'md', decorative = true, className,
}: PersonAvatarProps) {
  const tone = toneOf(self, other)
  const cls = ['person-avatar', `person-avatar-${size}`, `is-${tone}`, className]
    .filter(Boolean)
    .join(' ')
  const ariaProps = decorative
    ? { 'aria-hidden': true as const }
    : { role: 'img', 'aria-label': self ? `${name}, du` : name }
  return (
    <span className={cls} {...ariaProps}>
      {personInitials(name)}
    </span>
  )
}

interface PersonLabelProps {
  name: string
  self?: boolean
  other?: boolean
  /** 'compact' → `Alex` + a `Du` chip; 'audit' → inline `Alex (du)` for history
      and dense audit rows. Never renders "Du" alone. */
  variant?: 'compact' | 'audit'
  /** Show the initials avatar before the name. */
  avatar?: boolean
  avatarSize?: 'sm' | 'md'
  className?: string
  /** Extra trailing content (e.g. a percentage) rendered after the name/chip. */
  suffix?: ReactNode
}

/** Canonical name plus the "Du" marker for the signed-in person. The marker is
    always paired with the name (never "Du" alone) and is both visible and part
    of the accessible name, so self is distinguishable without relying on colour. */
export function PersonLabel({
  name, self, other, variant = 'compact', avatar = false, avatarSize = 'sm', className, suffix,
}: PersonLabelProps) {
  const tone = toneOf(self, other)
  const cls = ['person-label', `is-${tone}`, className].filter(Boolean).join(' ')
  return (
    <span className={cls}>
      {avatar && <PersonAvatar name={name} self={self} other={other} size={avatarSize} />}
      {variant === 'audit'
        ? <span className="person-name">{self ? `${name} (du)` : name}</span>
        : (
          <>
            <span className="person-name">{name}</span>
            {self && <span className="person-du-chip">Du</span>}
          </>
        )}
      {suffix}
    </span>
  )
}

interface PersonColumnHeaderProps {
  name: string
  self?: boolean
  other?: boolean
  /** Optional secondary line under the name (e.g. a percentage or role). */
  sub?: ReactNode
  avatar?: boolean
  className?: string
}

/** The shared comparison-column header treatment: a restrained accent edge and
    tinted header for self, an outlined copper avatar for the other person, and
    the same neutral header otherwise. Values below it are never enlarged. */
export function PersonColumnHeader({
  name, self, other, sub, avatar = true, className,
}: PersonColumnHeaderProps) {
  const tone = toneOf(self, other)
  const cls = ['person-col-header', `is-${tone}`, className].filter(Boolean).join(' ')
  return (
    <div className={cls} aria-label={self ? `${name}, du` : undefined}>
      <span className="person-col-head-main">
        {avatar && <PersonAvatar name={name} self={self} other={other} size="sm" />}
        <PersonLabel name={name} self={self} other={other} />
      </span>
      {sub != null && <span className="person-col-head-sub">{sub}</span>}
    </div>
  )
}
