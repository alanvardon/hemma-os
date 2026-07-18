// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import OfflineBanner from './OfflineBanner'

describe('OfflineBanner', () => {
  let originalOnLine: PropertyDescriptor | undefined

  beforeEach(() => {
    originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
  })

  afterEach(() => {
    if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine)
  })

  it('renders nothing while online', () => {
    render(<OfflineBanner />)
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('shows the offline message once the browser reports offline', () => {
    render(<OfflineBanner />)
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(screen.getByRole('status')).toHaveTextContent(
      'Offline — ändringar sparas lokalt och synkas när du är online igen.',
    )
  })
})
