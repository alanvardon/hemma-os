// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { createMemoryRouter, RouterProvider } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ErrorBoundary from './ErrorBoundary'

function ThrowingRoute(): never {
  throw new Error('boom')
}

function renderThrowingRoute() {
  const router = createMemoryRouter(
    [{ path: '/', element: <ThrowingRoute />, errorElement: <ErrorBoundary /> }],
    { initialEntries: ['/'] },
  )
  return render(<RouterProvider router={router} />)
}

describe('ErrorBoundary', () => {
  let originalOnLine: PropertyDescriptor | undefined
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    originalOnLine = Object.getOwnPropertyDescriptor(window.navigator, 'onLine')
    // React Router logs the caught error to the console; keep test output clean.
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    if (originalOnLine) Object.defineProperty(window.navigator, 'onLine', originalOnLine)
    consoleErrorSpy.mockRestore()
  })

  it('shows the offline headline when navigator.onLine is false', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: false })
    renderThrowingRoute()
    expect(screen.getByRole('heading', { name: 'Du är offline' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Till startsidan' })).toBeInTheDocument()
  })

  it('shows the generic headline when navigator.onLine is true', () => {
    Object.defineProperty(window.navigator, 'onLine', { configurable: true, value: true })
    renderThrowingRoute()
    expect(screen.getByRole('heading', { name: 'Något gick fel' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Försök igen' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Till startsidan' })).toBeInTheDocument()
  })
})
