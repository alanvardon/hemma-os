# Plan 106 — Publish Huskalendern as a subscribable Apple Calendar (ICS/webcal) feed

**Status:** plan · **Owner model:** Opus (small surface, but the crux is a
**public, unauthenticated Edge Function that serves household data**, guarded
only by an unguessable per-household token embedded in a URL — the token design,
the `verify_jwt = false` decision, the RLS on the token table, and *what fields
leak* through the feed must be reasoned from security principles, not
pattern-matched from the existing browser-auth'd tools) · **Source:** idea
session 2026-07-14 (owner asked "can the calendar sync to Apple Calendar?";
option A — one-way ICS subscription feed — chosen over CalDAV two-way and
one-shot export) · **Sequencing:** independent — no dependency on the 103→105
mortgage batch; can be built any time. · **Touches:** new migration
`supabase/migrations/<ts>_calendar_feeds.sql`; new Edge Function
`supabase/functions/house-calendar/` (`index.ts`, `ics.ts`, `ics.test.ts`,
`README.md`); `supabase/config.toml` (one `[functions.house-calendar]` block);
`web/src/lib/calendar-feed.ts` + `calendar-feed.test.ts` (token RPC wrapper + URL
builder); `web/src/routes/huskalendern/SubscribeDialog.tsx` (new);
`web/src/routes/Huskalendern.tsx` (one action button); `web/src/styles/` (dialog
copy styles if needed).

> **Owner approval — GRANTED 2026-07-14.** This adds a new table + RLS (schema
> change) **and** a public function that exposes household data at a bearer-token
> URL (security boundary change); per AGENTS.md both gates apply. The owner has
> approved (a) the token model as specified and (b) both §5 recommendations:
> **`cost`/`notes` are included** in the feed, and **`verify_jwt = false`** is
> accepted for this one function with the token as the sole credential. Clear to
> implement.

## Goal

Let the owner and partner see Huskalendern's upcoming milestones — contract
expiries and "due again ≈" interval projections — inside Apple Calendar (iPhone
and Mac), refreshing on their own, without re-entering anything. Today those
dates live only inside the app's vertical timeline ([Huskalendern.tsx](../web/src/routes/Huskalendern.tsx));
a service contract that lapses in 40 days is invisible unless someone opens the
tool. After this, each household subscribes **once** to a `webcal://` link and
the milestones appear as all-day events with reminders, kept in sync by Apple's
own periodic refresh.

**One-way, read-only, eventual.** Hemma OS is the source of truth; Apple only
renders. The feed is a snapshot Apple re-polls (typically hourly-to-daily — Apple
controls the cadence, the device's "Hämta nya data" setting overrides it, and we
can only *hint* a TTL). Nobody edits a contract expiry in Apple Calendar. This is
exactly why the ICS-subscription shape fits and CalDAV two-way (with its
mandatory conflict/retry model, which AGENTS.md forbids promising without one)
would be over-engineering.

The pure timeline core was **deliberately written dependency-free "so it can be
imported by a Deno Edge Function later"** ([huskalendern.ts:1-5](../web/src/lib/huskalendern.ts#L1-L5)) —
this plan is that later. The milestone selection is `nextDue` +
`status` ([huskalendern.ts:79-106](../web/src/lib/huskalendern.ts#L79-L106)); the
feed reuses that logic (mirrored into the Deno function — see §3, matching the
existing riksbank/policy-rate convention that hand-mirrors web logic because the
Deno runtime cannot import from `web/src`).

## 1. What the feed contains — the decision

Emit a `VEVENT` for every **future or overdue** milestone, i.e. every item's
`nextDue(item)` ([huskalendern.ts:79-85](../web/src/lib/huskalendern.ts#L79-L85)):

- **Contracts** → their expiry `date` (kind `expiry`).
- **Logs with `interval_years > 0`** → `date + interval` (kind `interval`, soft
  estimate).
- **Plain history logs** (a one-off maintenance record, no interval) → **not
  emitted.** They have no future date; a calendar of "what's coming" should not
  be polluted with years of past receipts. (Deferred — see Out of scope.)

This mirrors the app's own `needsAttention` / `nextMilestone` framing
([huskalendern.ts:229-251](../web/src/lib/huskalendern.ts#L229-L251)): the
calendar answers "what's coming up," not "what's the full ledger."

Each event:

| ICS property | Source | Notes |
|---|---|---|
| `UID` | `<item.id>-<kind>@hemma-os.se` | **Stable** per item+kind so Apple updates the event in place instead of duplicating on every refresh. |
| `DTSTART;VALUE=DATE` | milestone date `YYYY-MM-DD` → `YYYYMMDD` | All-day event. |
| `DTEND;VALUE=DATE` | milestone date **+ 1 day** | Required for all-day per RFC 5545 (DTEND is exclusive). |
| `DTSTAMP` | `item.created_at` | Deterministic (not `now()`) so output is testable and diff-stable. |
| `SUMMARY` | `title`, `≈ ` prefix when `kind === 'interval'` | e.g. `Serviceavtal panna` / `≈ Byt FTX-filter`. The `≈` matches the app's "soft" rendering. |
| `DESCRIPTION` | `vendor`, `cost` (kr, sv formatting), `notes`, + `Beräknad tidpunkt` line when soft | Escaped + folded (see §3). |
| `CATEGORIES` | `category` | `underhåll` / `avtal` / `besiktning` / `övrigt`. |
| `VALARM` | contracts: `TRIGGER:-P{remind_days}D`; intervals: `TRIGGER:-P{INTERVAL_SOON_DAYS}D` (90) | A display alarm so the phone reminds ahead of the date, matching each item's own window ([huskalendern.ts:37,102-104](../web/src/lib/huskalendern.ts#L37-L104)). |

Calendar-level: `PRODID:-//Hemma OS//Huskalendern//SV`, `VERSION:2.0`,
`CALSCALE:GREGORIAN`, `METHOD:PUBLISH`, `X-WR-CALNAME:Huskalendern`,
`X-WR-TIMEZONE:Europe/Stockholm`, and a refresh hint
`REFRESH-INTERVAL;VALUE=DURATION:PT12H` + `X-PUBLISHED-TTL:PT12H`.

## 2. Data model — the per-household token

**New table `public.calendar_feeds`** (own migration; never edit an applied one).
Follows the household-scoped, service-role-writes / authenticated-reads pattern
of `notification_state` ([20260712110000_notification_state.sql](../supabase/migrations/20260712110000_notification_state.sql)):

```sql
-- Plan 106 — calendar_feeds: the per-household bearer token that authorises the
-- public house-calendar Edge Function to serve that household's ICS feed. One
-- row per household. The token is the ONLY credential Apple Calendar can present
-- (a subscription URL can carry no JWT), so it must be long-random, rotatable,
-- and revocable. Authenticated members may READ their own household's token (to
-- render the subscribe link); only the security-definer RPCs below (and the
-- service role) ever write it. Idempotent.
create table if not exists public.calendar_feeds (
  household_id uuid primary key references public.households(id) on delete cascade,
  token        uuid not null unique default gen_random_uuid(),
  created_at   timestamptz not null default now(),
  revoked      boolean not null default false
);

alter table public.calendar_feeds enable row level security;

-- Members may read their own household's row (to show the link). No client
-- INSERT/UPDATE/DELETE — the RPCs below own writes; the Edge Function reads via
-- the service role (bypasses RLS).
drop policy if exists hh_select on public.calendar_feeds;
create policy hh_select on public.calendar_feeds for select to authenticated
  using (household_id = (select private.current_household()));

grant select on table public.calendar_feeds to authenticated;
grant all    on table public.calendar_feeds to service_role;

-- get_or_create: return the caller's household feed token, minting one on first
-- call. Security definer so the browser needn't hold INSERT rights on the table.
create or replace function public.get_or_create_calendar_feed()
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  hh uuid := private.current_household();
  tok uuid;
begin
  if hh is null then raise exception 'no household'; end if;
  insert into public.calendar_feeds (household_id)
    values (hh)
    on conflict (household_id) do nothing;
  select token into tok from public.calendar_feeds
    where household_id = hh and revoked = false;
  return tok;  -- null only if the row is currently revoked (see rotate)
end;
$$;

-- rotate: replace the token (invalidates the old subscription immediately) and
-- clear any revoked flag. Returns the new token.
create or replace function public.rotate_calendar_feed()
returns uuid
language plpgsql
security definer
set search_path = public, private
as $$
declare
  hh uuid := private.current_household();
  tok uuid := gen_random_uuid();
begin
  if hh is null then raise exception 'no household'; end if;
  insert into public.calendar_feeds (household_id, token, revoked)
    values (hh, tok, false)
    on conflict (household_id) do update set token = excluded.token, revoked = false;
  return tok;
end;
$$;

revoke all on function public.get_or_create_calendar_feed() from public;
revoke all on function public.rotate_calendar_feed()        from public;
grant execute on function public.get_or_create_calendar_feed() to authenticated;
grant execute on function public.rotate_calendar_feed()        to authenticated;
```

**Why a token table and not a column on `households`:** rotation/revocation is a
first-class need (a leaked `webcal` link is the whole risk surface), and a
dedicated row keeps the capability out of the frequently-read `households` record.
The `uuid` token is 122 random bits — not enumerable.

## 3. The Edge Function — `supabase/functions/house-calendar/`

Two files + tests + runbook, mirroring the `policy-rate-notify` layout (pure
logic in a sibling module, Deno-tested — [policy-rate-notify/logic.test.ts](../supabase/functions/policy-rate-notify/logic.test.ts)):

**`ics.ts` (pure, no Deno/DB APIs — unit-testable):**

- Mirror the milestone math from `huskalendern.ts`: `parseISO`, `toISO`,
  `addYearsISO`, `nextDue` (kinds `expiry`/`interval`). Header comment must state
  the hand-mirror obligation and point at [huskalendern.ts](../web/src/lib/huskalendern.ts),
  exactly as `riksbank-proxy` and `policy-rate-notify/logic.ts` already do.
- `buildIcs(items: HouseItem[]): string` — selects future milestones, emits the
  VCALENDAR/VEVENT text from §1.
- **Correctness details that MUST be handled (these are the test targets):**
  - **Text escaping** per RFC 5545: `\` → `\\`, `;` → `\;`, `,` → `\,`, newline →
    `\n`, in `SUMMARY`/`DESCRIPTION`/`CATEGORIES`.
  - **Line folding** at 75 octets: long lines continue with CRLF + a single
    leading space. Swedish `å/ä/ö` are multi-byte in UTF-8 — fold on **octet**
    count, not character count, or Apple rejects the line.
  - **CRLF** line endings throughout (`\r\n`), not `\n`.
  - All-day `DTEND` = date **+1 day** via `addDaysISO` (add a tiny helper; do not
    reuse `addYearsISO`).
  - Deterministic output: no `Date.now()` in `ics.ts` — `DTSTAMP` comes from
    `created_at`. (This keeps the golden-file test stable and is why the builder
    is pure.)

**`index.ts` (the HTTP surface):**

```ts
// house-calendar — serves a household's Huskalendern as a subscribable ICS feed
// (plan 106). PUBLIC + UNAUTHENTICATED by necessity: Apple Calendar subscribes
// with a plain URL and cannot present a Supabase JWT, so the ?t=<token> query
// IS the credential. verify_jwt is disabled for this function (config.toml +
// --no-verify-jwt on deploy). The token maps to exactly one household via
// calendar_feeds; the service role reads that household's house_items (bypassing
// RLS) and nothing else. No CORS (not browser-called).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { buildIcs } from './ics.ts'

Deno.serve(async (req: Request) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    return new Response('method not allowed', { status: 405 })
  }
  const token = new URL(req.url).searchParams.get('t')
  // 404 (never 403) on a missing/bad token so the endpoint never confirms which
  // tokens exist.
  if (!token) return new Response('not found', { status: 404 })

  const supabase = createClient(
    Deno.env.get('SUPABASE_URL')!,               // auto-injected
    Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,  // auto-injected
  )
  const { data: feed } = await supabase
    .from('calendar_feeds').select('household_id')
    .eq('token', token).eq('revoked', false).maybeSingle()
  if (!feed) return new Response('not found', { status: 404 })

  const { data: items, error } = await supabase
    .from('house_items').select('*').eq('household_id', feed.household_id)
  if (error) return new Response('error', { status: 500 })

  const ics = buildIcs(items ?? [])
  return new Response(req.method === 'HEAD' ? null : ics, {
    status: 200,
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="huskalendern.ics"',
      'Cache-Control': 'public, max-age=3600',
    },
  })
})
```

**`config.toml`** — add (functions default to `verify_jwt = true`; this one must
be public):

```toml
[functions.house-calendar]
verify_jwt = false
```

**Deploy** carries `--no-verify-jwt` as belt-and-suspenders (see runbook).

**`README.md`** — prod runbook in the style of
[policy-rate-notify/README.md](../supabase/functions/policy-rate-notify/README.md):
owner-run `supabase functions deploy house-calendar --no-verify-jwt`; note that
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are auto-injected (no secrets to
set); a `curl` smoke test against a known token; and a device subscription test.

## 4. Web UI — the subscribe affordance

**`web/src/lib/calendar-feed.ts`** (+ `.test.ts`):

- `getOrCreateFeedToken(): Promise<string>` → `supabase.rpc('get_or_create_calendar_feed')`.
- `rotateFeedToken(): Promise<string>` → `supabase.rpc('rotate_calendar_feed')`.
- `feedUrls(token, scheme)` → build from `import.meta.env.VITE_SUPABASE_URL`
  ([supabase.ts:8](../web/src/lib/supabase.ts#L8)):
  `https://<ref>.supabase.co/functions/v1/house-calendar?t=<token>` and its
  `webcal://` twin (swap the scheme — `webcal:` is what makes iOS/macOS offer to
  *subscribe* rather than download). Pure + unit-tested (URL building, scheme
  swap, token interpolation).

**`web/src/routes/huskalendern/SubscribeDialog.tsx`** (new, uses `DialogShell`
like [ItemDialog.tsx:84](../web/src/routes/huskalendern/ItemDialog.tsx#L84)):

- On open, calls `getOrCreateFeedToken()`.
- Shows a **"Lägg till i Apple Kalender"** primary link (`href={webcalUrl}`) and
  a copyable `https` URL with a copy button.
- Swedish explainer copy, concise: one-way (ändringar i appen syns i kalendern,
  inte tvärtom), read-only, uppdateras inom ca ett dygn, **och att vem som helst
  med länken kan se listan** — så dela den inte.
- **"Skapa ny länk"** (rotate) behind a confirm — warns that the old
  subscription stops updating and must be re-added on every device.

**`web/src/routes/Huskalendern.tsx`** — add one action in the `PageHeader`
actions slot ([Huskalendern.tsx:117-120](../web/src/routes/Huskalendern.tsx#L117-L120)),
e.g. a `CalendarPlus` icon button opening the dialog. No other route change.

## 5. Security — the load-bearing decisions (owner sign-off)

1. **The feed URL is a bearer capability.** Anyone holding it reads that
   household's upcoming maintenance/contract items — including **`vendor`,
   `cost`, and `notes`**. Mitigations: 122-bit random `uuid` token (not
   enumerable); rotate/revoke RPCs; the function serves **only** `house_items`
   for the one matched household and nothing else; HTTPS; `404` (not `403`) on a
   bad token so the endpoint never confirms a token exists.
   **Decided (owner, 2026-07-14):** ship with `cost`/`notes` **included** —
   they're useful in the reminder — as a conscious, documented exposure.
2. **`verify_jwt = false` makes the function internet-reachable without auth.**
   That is unavoidable for a subscription feed; the token is the auth. The blast
   radius is one household's calendar, capped by the service-role query being
   hard-scoped to `feed.household_id`.
3. **No new RLS weakening elsewhere.** `calendar_feeds` is select-only for
   members; writes go through security-definer RPCs scoped to
   `current_household()`. The service role's existing broad grants already exist
   on every table — this function uses them the same way `policy-rate-notify`
   does.

## Acceptance criteria

- **Migration** applies cleanly on `supabase db reset` and is idempotent
  (re-runnable). `calendar_feeds` has the RLS `hh_select` policy; the two RPCs
  are `security definer` with `search_path` pinned and `execute` granted only to
  `authenticated`.
- **`ics.ts` unit tests** (`ics.test.ts`, Deno) with **hand-verified golden ICS
  strings** assert:
  - a contract → one `VEVENT` with `DTSTART;VALUE=DATE`, `DTEND` = date+1,
    stable `UID`, and a `VALARM` at `-P{remind_days}D`.
  - an interval log → a `≈`-prefixed `SUMMARY`, `VALARM` at `-P90D`.
  - a plain history log (no interval) → **no** event.
  - escaping: a title/notes with `,` `;` `\` and a newline round-trips escaped.
  - folding: a `DESCRIPTION` with `å/ä/ö` longer than 75 octets folds on octet
    boundaries (continuation lines start with a single space; no multi-byte char
    is split mid-sequence).
  - CRLF line endings; deterministic output across two calls (no `now()`).
- **`calendar-feed.test.ts`** asserts `feedUrls` builds the correct `https` and
  `webcal` URLs from a sample `VITE_SUPABASE_URL` and interpolates the token.
- **Function smoke test** (runbook, owner-run): `curl` with a valid `?t=` returns
  `200 text/calendar`; a bad/absent token returns `404`; the payload validates in
  an ICS validator and imports into Apple Calendar.
- **Device check** (owner): subscribing to the `webcal://` link on iPhone adds a
  "Huskalendern" calendar; a contract expiry shows as an all-day event with a
  reminder; editing that contract's date in the app and waiting for a refresh (or
  forcing "Hämta nya data") moves the event — it does **not** duplicate (stable
  `UID` verified).
- **Rotate** invalidates the old link: after `rotate_calendar_feed()`, the old
  `?t=` returns `404` and the new one serves the feed.
- Verify gates from `web/`: `npm run lint`, `npm run test`, `npm run build` all
  green. Deno tests noted as owner/CI-run (no Deno in the agent env — same caveat
  the existing `logic.test.ts` header records).
- SubscribeDialog verified at 390×844 and desktop, light + dark: link is
  tappable, copy works, the "vem som helst med länken"-warning is visible, rotate
  confirms before acting.

## Out of scope

- **Past history logs in the feed** — deferred; the calendar is a "what's
  coming" view. Could later add a bounded trailing window behind a toggle.
- **CalDAV two-way sync** — rejected: Apple is never the editing surface, and
  two-way needs a conflict/retry model AGENTS.md forbids promising without one.
- **Google/Outlook** — the same `.ics`/`webcal` feed works in both, but only
  Apple is being verified here; no provider-specific work.
- **Per-tool feeds beyond Huskalendern** (e.g. Bolånekoll payment dates) — a
  natural later extension on the same token+function skeleton; not asked for.
- **Cron/scheduled regeneration** — none needed; the function renders live on
  each poll. No `notification_state`-style idempotency table required.
- **Subscribe UI on the Home hub** — the affordance lives on the Huskalendern
  page only for now.
