// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { PersonAvatar, PersonLabel, PersonColumnHeader, personInitials } from './PersonBadge'

describe('personInitials', () => {
  it('takes first + last initial for multi-word names, first two chars otherwise', () => {
    expect(personInitials('Alex Vardon')).toBe('AV')
    expect(personInitials('Sam')).toBe('SA')
    expect(personInitials('  alex   ')).toBe('AL')
    expect(personInitials('Åsa Öberg')).toBe('ÅÖ')
  })
})

describe('PersonAvatar', () => {
  it('is decorative by default (no accessible name)', () => {
    render(<PersonAvatar name="Alex" self />)
    expect(screen.queryByRole('img')).not.toBeInTheDocument()
  })

  it('carries a name + "du" accessible label when standalone and self', () => {
    render(<PersonAvatar name="Alex" self decorative={false} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAccessibleName('Alex, du')
    expect(img.className).toContain('is-self')
  })

  it('uses the outlined "other" tone for the partner', () => {
    render(<PersonAvatar name="Sam" other decorative={false} />)
    const img = screen.getByRole('img')
    expect(img).toHaveAccessibleName('Sam')
    expect(img.className).toContain('is-other')
  })
})

describe('PersonLabel', () => {
  it('renders the name plus a visible "Du" chip for self (compact)', () => {
    const { container } = render(<PersonLabel name="Alex" self />)
    expect(screen.getByText('Alex')).toBeInTheDocument()
    // The marker is visible text, not colour-only, so it is in the a11y tree.
    expect(screen.getByText('Du')).toBeInTheDocument()
    expect(container.querySelector('.person-avatar')).not.toBeInTheDocument()
  })

  it('never renders "Du" alone — the other person shows just the name', () => {
    render(<PersonLabel name="Sam" other />)
    expect(screen.getByText('Sam')).toBeInTheDocument()
    expect(screen.queryByText('Du')).not.toBeInTheDocument()
  })

  it('uses the inline "(du)" audit form for dense/history rows', () => {
    render(<PersonLabel name="Alex" self variant="audit" />)
    expect(screen.getByText('Alex (du)')).toBeInTheDocument()
    expect(screen.queryByText('Du')).not.toBeInTheDocument()
  })

  it('shows no marker at all for an unmapped/neutral person', () => {
    render(<PersonLabel name="Alex" />)
    expect(screen.getByText('Alex')).toBeInTheDocument()
    expect(screen.queryByText('Du')).not.toBeInTheDocument()
    expect(screen.queryByText(/\(du\)/)).not.toBeInTheDocument()
  })
})

describe('PersonColumnHeader', () => {
  it('gives the self column a name + "du" accessible label and the self tone', () => {
    const { container } = render(<PersonColumnHeader name="Alex" self sub="70 %" />)
    const header = container.querySelector('.person-col-header') as HTMLElement
    expect(header.getAttribute('aria-label')).toBe('Alex, du')
    expect(header.className).toContain('is-self')
    expect(screen.getByText('70 %')).toBeInTheDocument()
    expect(header.querySelector('.person-avatar')).not.toBeInTheDocument()
  })

  it('does not label the other column as self and uses the other tone', () => {
    const { container } = render(<PersonColumnHeader name="Sam" other />)
    const header = container.querySelector('.person-col-header') as HTMLElement
    expect(header.getAttribute('aria-label')).toBeNull()
    expect(header.className).toContain('is-other')
  })
})
