# Email setup — Resend on `mail.vardon-family.se` (plan 131)

This is the **single home** for setting up transactional email for Hemma OS's
Edge Functions. Every function that sends email (`policy-rate-notify` today,
plan 132's salary emails later) imports `sendEmail`/`buildResendRequest` from
`resend.ts` in this directory and reads its own secrets at the call site —
see `resend.ts` for the helper and `../policy-rate-notify/README.md` for a
function-specific runbook that links back here.

## Local development: dry-run, no secrets needed

Set `EMAIL_DRY_RUN=1` when running a function locally
(`supabase functions serve <function> --env-file <path>`). With it set, `sendEmail`
never calls the network and never requires `RESEND_API_KEY`/`RESEND_FROM` to be
set — it only logs `[email dry-run] would send "<subject>" to <N> recipient(s)`.
It never logs an address or the email body (plan 131, decision D7). Local runs
of `supabase functions serve` must never send real mail — always set this
locally.

## Decisions (plan 131)

| # | Decision |
|---|---|
| D1 | Send from the subdomain `mail.vardon-family.se`, not the apex. Resend's recommendation; isolates sending reputation. Return path defaults to `send.mail.vardon-family.se`. |
| D2 | Region `eu-west-1` (Ireland) — all recipients are in Sweden, keeps message data in the EU. |
| D3 | Open and click tracking stay **off**. Click tracking rewrites links through Resend's redirect, which would expose plan 132's login-free tokens to a third-party hop and can corrupt verification links; open tracking hurts deliverability for transactional mail. |
| D4 | API key scoped to **sending access only**, restricted to the `mail.vardon-family.se` domain. If it leaks, the attacker can only send as that subdomain. Store it only as a Supabase function secret, never in the repo or GitHub. |
| D5 | Sender: `RESEND_FROM="Hemma OS <notiser@mail.vardon-family.se>"`. No reply inbox exists, so no `reply_to` is set. Emails say so in their footer. |
| D6 | DMARC starts at `p=none` with no reporting address — monitoring-only. Tighten to `p=quarantine` after a month of clean sending (out of scope here). |
| D7 | The dry-run switch (`EMAIL_DRY_RUN=1`) is mandatory in the helper. |

## Owner runbook (production; the agent does none of this)

### O1. Resend domain

1. Create a Resend account. Use your own email; it becomes the account owner.
2. Domains → Add Domain → `mail.vardon-family.se`, region **eu-west-1**, leave
   the custom return path empty (default `send`).
3. In **Cloudflare DNS** for `vardon-family.se`, add exactly the records
   Resend's Records tab shows. Copy and paste them; don't retype. Expect:

   | Type | Name | Value |
   |---|---|---|
   | TXT | `resend._domainkey.mail` | `p=MIGf…` (DKIM, long) |
   | MX | `send.mail` | `feedback-smtp.eu-west-1.amazonses.com`, priority 10 |
   | TXT | `send.mail` | `v=spf1 include:amazonses.com ~all` |

   These are TXT/MX records, so Cloudflare's proxy (orange cloud) doesn't
   apply. If Resend ever shows a CNAME, set it to **DNS only**.
4. Wait for **Verified** (usually under 15 minutes, up to 72 hours).
5. Add DMARC in Cloudflare: `TXT _dmarc.mail` → `v=DMARC1; p=none;`
6. In the domain's Configuration tab, **confirm open and click tracking are
   off** (D3).

### O2. API key

API Keys → Create → permission **Sending access**, domain
`mail.vardon-family.se`, name `supabase-edge-functions`. Copy it once; Resend
never shows it again.

### O3. Supabase function secrets (linked production project)

```sh
supabase secrets set \
  RESEND_API_KEY=re_... \
  RESEND_FROM="Hemma OS <notiser@mail.vardon-family.se>" \
  APP_ORIGIN=https://www.vardon-family.se
```

Then finish plan 72: deploy `policy-rate-notify` and run its README's steps
3–4 (the pg_cron + Vault schedule, then verification). Do this **after** this
plan's code PR is merged, so the deployed function uses the shared helper.

### O4. (Optional, recommended) Magic-link emails via Resend

In the Supabase dashboard → Authentication → Emails → SMTP Settings, enable
custom SMTP:

| Field | Value |
|---|---|
| Host | `smtp.resend.com` |
| Port | `465` |
| Username | `resend` |
| Password | a **second** Resend key (sending access, same domain), named `supabase-auth-smtp`, kept separate so either can be revoked alone |
| Sender | `inloggning@mail.vardon-family.se`, name `Hemma OS` |

This makes login links arrive from your own domain and lifts the built-in
mailer's limits. **Send yourself a magic link immediately after saving.** If
it doesn't arrive, turn custom SMTP off again; that's the rollback.

### O5. Smoke test

From your own terminal, not CI and not the agent:

```sh
curl -X POST https://api.resend.com/emails \
  -H "Authorization: Bearer re_..." -H "Content-Type: application/json" \
  -d '{"from":"Hemma OS <notiser@mail.vardon-family.se>","to":["<your email>"],"subject":"Hemma OS test","text":"It works."}'
```

In the received mail, check that "show original" says **SPF: PASS, DKIM:
PASS, DMARC: PASS**, and that it isn't in spam.

## Reversal

Revoke the API key(s) in the Resend dashboard, unset the Supabase secrets
(`supabase secrets unset RESEND_API_KEY RESEND_FROM`), and remove the DNS
records from Cloudflare. If O4 was enabled, turn custom SMTP back off in
Supabase Auth settings first.
