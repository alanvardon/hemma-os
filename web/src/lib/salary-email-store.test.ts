import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createSupabaseMock } from './testSupabaseMock'

const holder = vi.hoisted(() => ({ current: undefined as unknown as ReturnType<typeof createSupabaseMock> }))
vi.mock('./supabase', () => {
  holder.current = createSupabaseMock()
  return { supabase: holder.current.supabase }
})
vi.mock('./persistence-error', () => ({ reportPersistenceWarning: vi.fn() }))
const mock = () => holder.current

import { reportPersistenceWarning } from './persistence-error'
import { listResultsEmailStatus, requestResultsEmail } from './salary-email-store'

beforeEach(() => {
  vi.clearAllMocks()
  mock().control.fail = false
  mock().control.failing.clear()
  mock().control.rpcHandlers = {}
})

describe('requestResultsEmail', () => {
  it.each(['queued', 'already_queued'])('returns %s and passes the submission id', async (answer) => {
    const handler = vi.fn(() => answer)
    mock().control.rpcHandlers.request_salary_results_email = handler
    await expect(requestResultsEmail('sub-1')).resolves.toBe(answer)
    expect(handler).toHaveBeenCalledWith({ p_submission_id: 'sub-1' })
  })

  it('throws on an RPC error', async () => {
    mock().control.failing.add('request_salary_results_email')
    await expect(requestResultsEmail('sub-1')).rejects.toBeTruthy()
  })

  it('throws on an unexpected value', async () => {
    mock().control.rpcHandlers.request_salary_results_email = () => 'sent'
    await expect(requestResultsEmail('sub-1')).rejects.toThrow(/Unexpected/)
  })
})

describe('listResultsEmailStatus', () => {
  it('keys the rows by submission id and skips rows without one', async () => {
    mock().control.rpcHandlers.salary_results_email_status = () => [
      { submission_id: 's1', last_sent_at: '2026-10-20T08:00:00Z', queued: false },
      { submission_id: 's2', last_sent_at: null, queued: true },
      { submission_id: null, last_sent_at: null, queued: true },
    ]
    const map = await listResultsEmailStatus()
    expect([...map.keys()]).toEqual(['s1', 's2'])
    expect(map.get('s1')).toEqual({ submission_id: 's1', last_sent_at: '2026-10-20T08:00:00Z', queued: false })
    expect(map.get('s2')).toEqual({ submission_id: 's2', last_sent_at: null, queued: true })
    expect(reportPersistenceWarning).not.toHaveBeenCalled()
  })

  it('an empty answer is an empty map', async () => {
    mock().control.rpcHandlers.salary_results_email_status = () => []
    expect((await listResultsEmailStatus()).size).toBe(0)
  })

  it('on a failed read warns and returns an empty map', async () => {
    mock().control.failing.add('salary_results_email_status')
    const map = await listResultsEmailStatus()
    expect(map.size).toBe(0)
    expect(reportPersistenceWarning).toHaveBeenCalledTimes(1)
  })
})
