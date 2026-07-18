// Scrape the Riksbank policy-rate decision calendar from riksbank.se and
// accumulate the announcement dates into web/src/lib/riksbank-decisions.json.
//
// Run by .github/workflows/riksbank-calendar.yml monthly; opens a PR only when
// the committed JSON changes. See planning/completed/88-riksbank-calendar-automation.md.
//
// Design invariant (accumulate-and-gate): the committed set never shrinks from
// a bad fetch. The year listing shows ONLY upcoming events, so a single scrape
// cannot see history — we merge-union into the existing file and refuse to
// write (exit non-zero) if the scrape would regress coverage or fetching failed.
//
// Node ESM, no npm deps: uses global fetch (Node >= 18). The pure logic
// (mergeDecisions, checkGate) is exported for unit tests; the network + file
// I/O in main() runs only when the script is executed directly.

import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

// The exact decision SUMMARY phrase, matched case-insensitively both in the
// listing anchor text and in the per-event ICS body. Rejects auctions/speeches.
export const TITLE = 'decision on monetary policy including the policy rate'

const UA = { 'User-Agent': 'Mozilla/5.0 (hemma-os calendar bot)' } // bare UA -> 403
const BASE = 'https://www.riksbank.se/en-gb/press-and-published/calendar'
const ICS_DELAY_MS = 400 // be polite between per-event ICS fetches

const HERE = dirname(fileURLToPath(import.meta.url))
export const DECISIONS_PATH = resolve(HERE, '../web/src/lib/riksbank-decisions.json')

// --- Pure logic (exported, network-free, deterministic) --------------------

/**
 * Sorted, de-duped UNION of the existing committed decisions and the freshly
 * scraped ones. Existing dates are NEVER removed — the file only grows.
 */
export function mergeDecisions(existing, scraped) {
  return [...new Set([...(existing || []), ...(scraped || [])])].sort()
}

/**
 * The sanity gate. Returns { ok, reason }. Refuses (ok=false) if:
 *  - zero candidates were scraped, or
 *  - the fresh scrape has FEWER future dates (>= today) than the committed
 *    file already had — a degraded scrape (markup drift, partial fetch) that
 *    would regress upcoming coverage.
 *
 * Note on the coverage check: because the merge is a pure UNION, the *merged*
 * set can never have fewer future dates than `existing` — a merged-vs-existing
 * comparison is a tautology that can never trip. So the meaningful guard the
 * plan intends ("a scrape that would regress coverage") is the fresh scrape's
 * own future coverage vs. what the committed file already knows: a healthy
 * riksbank.se listing always re-lists every currently-upcoming decision, so a
 * shortfall signals the scrape broke. Any HTTP/fetch failure is handled by
 * main() throwing before we reach here (fail the whole run, write nothing).
 *
 * @param {object} p
 * @param {string[]} p.existing committed decisions
 * @param {string[]} p.scraped verified scraped decisions
 * @param {string}   p.today   ISO date 'YYYY-MM-DD'
 */
export function checkGate({ existing, scraped, today }) {
  if (!scraped || scraped.length === 0) {
    return { ok: false, reason: 'zero candidates scraped' }
  }
  const futureBefore = (existing || []).filter((d) => d >= today).length
  const futureAfter = (scraped || []).filter((d) => d >= today).length
  if (futureAfter < futureBefore) {
    return {
      ok: false,
      reason: `scraped future-date count regressed: ${futureAfter} < ${futureBefore}`,
    }
  }
  return { ok: true, reason: 'ok' }
}

// --- Network + I/O (only runs via main()) ----------------------------------

async function fetchText(url) {
  const res = await fetch(url, { headers: UA })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
  return res.text()
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Parse a year listing for anchors whose link text contains the decision
 * phrase (case-insensitive). Returns candidate ISO dates.
 */
export function parseCandidates(html) {
  const dates = new Set()
  const re =
    /href="\/en-gb\/press-and-published\/calendar\/calendar-\d{4}\/(\d{4}-\d{2}-\d{2})\/"([^>]*)>(.*?)<\/a>/gs
  for (const m of html.matchAll(re)) {
    const text = m[3].replace(/<[^>]+>/g, ' ').toLowerCase()
    if (text.includes(TITLE)) dates.add(m[1])
  }
  return [...dates]
}

/**
 * Extract the DTSTART date from an ICS body, but only if the body confirms it
 * is a policy-rate decision. Returns ISO date or null.
 */
export function dateFromIcs(ics) {
  if (!ics.toLowerCase().includes(TITLE)) return null
  const m = ics.match(/DTSTART:(\d{4})(\d{2})(\d{2})/)
  return m ? `${m[1]}-${m[2]}-${m[3]}` : null
}

async function candidatesForYear(year) {
  const html = await fetchText(`${BASE}/calendar-${year}/`)
  return parseCandidates(html)
}

async function verify(date) {
  const ics = await fetchText(`${BASE}/calendar-${date.slice(0, 4)}/${date}//Download`)
  return dateFromIcs(ics)
}

async function main() {
  const thisYear = new Date().getUTCFullYear()
  const years = [thisYear, thisYear + 1]
  const today = new Date().toISOString().slice(0, 10)

  // Gather candidates from both year listings.
  const candidates = new Set()
  for (const year of years) {
    for (const d of await candidatesForYear(year)) candidates.add(d)
  }

  // Verify each candidate against its per-event ICS. Any fetch error throws
  // and fails the whole run (write nothing).
  const verified = new Set()
  const sorted = [...candidates].sort()
  for (let i = 0; i < sorted.length; i++) {
    const date = sorted[i]
    const confirmed = await verify(date)
    if (confirmed) verified.add(confirmed)
    if (i < sorted.length - 1) await sleep(ICS_DELAY_MS)
  }

  const scraped = [...verified].sort()
  console.log(`Scraped ${scraped.length} verified decision date(s) for ${years.join(', ')}:`)
  console.log(scraped.join(', ') || '(none)')

  // Load existing committed file.
  const raw = await readFile(DECISIONS_PATH, 'utf8')
  const parsed = JSON.parse(raw)
  const existing = parsed.decisions || []

  // Sanity gate.
  const gate = checkGate({ existing, scraped, today })
  if (!gate.ok) {
    console.error(`Sanity gate FAILED (${gate.reason}). Writing nothing.`)
    process.exit(1)
  }

  const merged = mergeDecisions(existing, scraped)

  // Write only if changed.
  if (JSON.stringify(merged) === JSON.stringify(existing)) {
    console.log('No change — merged set matches committed file. Nothing written.')
    return
  }

  const out = { _comment: parsed._comment, decisions: merged }
  await writeFile(DECISIONS_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`Wrote ${merged.length} decision(s) to ${DECISIONS_PATH}`)
  console.log(`Added: ${merged.filter((d) => !existing.includes(d)).join(', ') || '(none)'}`)
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(`Fatal: ${err.message}`)
    process.exit(1)
  })
}
