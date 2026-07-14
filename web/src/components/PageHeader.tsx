import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { markVtTransition } from '../lib/viewTransition'

// The shared tool-page header: back-link to the hub (with the view transition),
// title + tagline, the "Saved ✓" flash, and a slot for per-tool action buttons
// (Settings, Reset, and the ThemeToggle). Replaces the near-identical header
// markup that each route hand-wrote.
export default function PageHeader({ backTo, title, tagline, saveVisible = false, actions }: {
  /** Route path for markVtTransition, e.g. '/bolanekoll'. */
  backTo: string
  title: ReactNode
  tagline: ReactNode
  saveVisible?: boolean
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      <div className="header-brand">
        <Link className="hub-link" to="/" viewTransition onClick={() => markVtTransition(backTo, 'back')}>‹ Hemma</Link>
        <div>
          <h1>{title}</h1>
          <p className="tagline">{tagline}</p>
        </div>
      </div>
      <div className="header-actions">
        <span className={'save-state' + (saveVisible ? ' show' : '')}>Sparat ✓</span>
        {actions}
      </div>
    </header>
  )
}
