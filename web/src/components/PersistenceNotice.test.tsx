// @vitest-environment jsdom
import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import PersistenceNotice from './PersistenceNotice'
import { reportPersistenceError } from '../lib/persistence-error'

describe('PersistenceNotice', () => {
  it('renders stable copy for a background write failure without raw backend text', async () => {
    render(<PersistenceNotice />)

    reportPersistenceError({
      code: '23514',
      message: 'new row violates check constraint private_financial_schema',
    })

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Ändringen kunde inte sparas. Kontrollera uppgifterna och försök igen.',
    )
    expect(screen.queryByText(/private_financial_schema/i)).not.toBeInTheDocument()
  })
})
