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

  it('reserves layout space while offline and releases it on reconnect', () => {
    render(<OfflineBanner />)
    const root = document.documentElement

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(root.classList.contains('has-offline-banner')).toBe(true)
    expect(root.style.getPropertyValue('--offline-banner-h')).not.toBe('')

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(root.classList.contains('has-offline-banner')).toBe(false)
    expect(root.style.getPropertyValue('--offline-banner-h')).toBe('')
  })
})
