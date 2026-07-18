// @vitest-environment jsdom
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { useOnline } from './useOnline'

function Probe({ onValue }: { onValue: (v: boolean) => void }) {
  onValue(useOnline())
  return null
}

describe('useOnline', () => {
  let originalOnLine: PropertyDescriptor | undefined

  beforeEach(() => {
    originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
  })

  afterEach(() => {
    if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine)
  })

  it('reflects the browser online/offline state and flips on events', () => {
    let latest: boolean | undefined
    render(<Probe onValue={(v) => { latest = v }} />)
    expect(latest).toBe(true)

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    act(() => { window.dispatchEvent(new Event('offline')) })
    expect(latest).toBe(false)

    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
    act(() => { window.dispatchEvent(new Event('online')) })
    expect(latest).toBe(true)
  })
})
