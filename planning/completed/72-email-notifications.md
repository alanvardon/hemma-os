# Plan 72 — Email notifications (deferred)

**Status:** parked — build only if in-app flags prove not enough ·
**Owner model:** Sonnet-suitable once un-parked (cron + state-table +
email plumbing with no UI; the open questions in "Decisions to make" are
for the user, not the model) ·
**Depends on:** plan 70 (rate watcher) and/or plan 71 (Huskalendern) ·
**Source:** idea session 2026-07-07 ("add a separate plan for email, I
may decide to do that at a later date").

## Goal

Get told about a styrränta change or an expiring house contract
**without opening the app**: a daily scheduled check that emails the
household when something actually happened. This is the piece plans 70/71
deliberately excluded — they are load-time checks; this adds a clock.

## Shape

One scheduled Supabase Edge Function `daily-digest`, cron ~10:00
Europe/Stockholm (Riksbank publishes 09:30 on decision days), via
`pg_cron` + `pg_net` calling the function. It needs **state** (email
must fire exactly once per event — the localStorage-ack trick from plan
70 doesn't exist server-side):

- New table `notification_state` (household_id, key, value, notified_at).
  - `policy_rate`: last value we emailed about; SWEA API says 1.80 →
    email + update. Reuses plan 70's fetch code — extract the SWEA call
    into a shared module the proxy and the cron both import.
  - `house_item:<id>`: emailed when the item entered `soon` (and again at
    `overdue`); reuses `nextDue`/`status` from `lib/huskalendern.ts` —
    port note: those helpers must stay dependency-free so Deno can import
    them.
- One email per household per day max (digest, not per-event spam);
  nothing new → no email.

## Decisions to make when un-parking (don't decide now)

1. **Provider:** Resend is the default candidate (free tier ≈100/day,
   trivial Deno SDK); needs a verified sender domain or their shared
   onboarding domain. Alternatives: Postmark, plain SMTP via a relay.
2. **Recipients:** all household members' `auth.users` emails, or an
   explicit opt-in flag per user (probably a `households`/profile
   column — decide when the second household member has an opinion).
3. **Scope:** rate changes only, house items only, or both in one digest.
4. Whether decision-day awareness is worth it (run at 09:40 *only* on
   `RIKSBANK_DECISIONS_*` dates for a same-hour email, vs. always daily).

## Acceptance criteria (sketch — firm up when un-parked)

- A policy-rate change produces exactly ONE email per household, arriving
  the same day; no change → no email for weeks, verified by
  `notification_state` inspection.
- A contract entering its remind window emails once, not daily.
- Cron failures are visible (function logs / plan-44-style fail-loud),
  not silent.
- Secrets (Resend key) live in Supabase function secrets, never in the
  repo.

## Explicitly not now

Nothing in plans 70/71 may depend on this file existing — they must be
fully useful in-app-only.
