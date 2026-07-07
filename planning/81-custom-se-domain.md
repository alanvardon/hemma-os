# Plan 81 — Move Hemma·OS to a custom `.se` domain (keep GitHub Pages hosting)

**Status:** plan · **Owner model:** Human-led with one tiny repo edit — the
domain purchase, DNS records, GitHub Pages setting, and Supabase Auth settings
are all **manual dashboard/registrar steps the user performs**, not code. The
only repo change is a one-line addition to `.github/workflows/deploy.yml`
(**Haiku/Sonnet** — a mechanical `echo` step, fully specified below). No
reasoning-heavy code; the value of this plan is the *sequence* and the two
non-obvious gotchas, not diff complexity. · **Source:** planning session
2026-07-07 (user request: move to own domain, pedagogical) · **Sequencing:**
standalone; not blocked by and does not block the 77–80 pipeline batch. Do the
Supabase Auth step (Step 6) **in the same sitting** as the GitHub step (Step 4)
— a gap between them is exactly when login silently breaks. · **Touches:**
`.github/workflows/deploy.yml` (1 line) · GitHub repo Settings → Pages
(external) · the domain registrar's DNS panel (external) · Supabase dashboard →
Authentication → URL Configuration (external).

---

## The mental model (read this once; everything below follows from it)

**A domain name is a signpost, not a place.** Your files live on GitHub's
servers today and will *still* live there after this move. All you are buying
and configuring is a friendlier address that points at the same servers.

- Today: someone types `alanvardon.github.io/hemma-os/` → GitHub serves your files.
- After: someone types `hemma.se` → **DNS** (the internet's phone book) says
  "that name lives at GitHub's servers" → GitHub serves the *same* files. The
  old `.github.io` URL keeps working too.

Two halves have to agree, and that's the whole job:

1. **The registrar side (DNS):** "When someone asks for `hemma.se`, send them to
   GitHub." — done with DNS *records*.
2. **The GitHub side (Pages custom domain):** "If a request arrives asking for
   `hemma.se`, I'm the site that answers for it." — done with the Pages setting
   + a `CNAME` file in the deployed output.

```
  registrar DNS          GitHub Pages
  ┌─────────────┐        ┌──────────────┐
  │ hemma.se →  │ ─────► │ "yes, that's │ ─────► your React build (unchanged)
  │ GitHub IPs  │        │  me, serve   │
  │ www → gh.io │        │  hemma-os"   │
  └─────────────┘        └──────────────┘
        Step 5                Step 4
```

## Why this move is cheap for *this* app specifically

Two existing design choices remove the usual custom-domain pain:

- **`base: './'` in `web/vite.config.ts:12`** — every asset URL is *relative* to
  `index.html`. The build already works "whether the site is published at the
  domain root or under a subpath" (the config comment says so). Moving from the
  `/hemma-os/` subpath to a bare root needs **zero asset-path changes**.
- **Hash routing (`createHashRouter`, `web/src/App.tsx:40`)** — all real routes
  live after a `#` (`hemma.se/#/bolanekoll`). The server only ever serves the
  one `index.html`; the browser handles everything after the `#`. This sidesteps
  the classic SPA-on-a-new-host bug where refreshing a deep link 404s. **No
  404-fallback / redirect trick needed.**
- **The login redirect is already dynamic** — `AuthGate.tsx:130` uses
  `emailRedirectTo: window.location.origin + window.location.pathname`, so it
  auto-computes `https://hemma.se/` on the new domain. **No code change** — but
  see the Supabase gotcha in Step 6.

So the code footprint of this entire migration is **one line in a CI workflow.**
Everything else is settings.

---

## Step 1 — Choose and buy the `.se` domain

`.se` is the Swedish top-level domain, run by Internetstiftelsen (IIS). You buy
it *through a registrar*, who registers it with IIS on your behalf. `.se` is
open — no company/personnummer requirement for individuals — but you must give
accurate contact details (IIS can suspend a domain with fake WHOIS data).

**Recommended registrars for `.se`** (any works; DNS steps below are identical):

- **Porkbun** — cheap (~US$10–12/yr), clean modern DNS UI, free WHOIS privacy,
  sells `.se`. Good default if you want the simplest DNS panel.
- **Loopia** or **Binero** — Swedish, `.se`-native, support in Swedish, ~150
  SEK/yr. Good if you'd rather deal with a Swedish company.

Pick a name that reads well without the `#` (users will see `hemma.se`, never the
hash). Buy it. **Do not buy any paid "web hosting", "email", or "website
builder" add-ons** — GitHub is your host; you only need the domain registration
itself (a DNS panel comes free with it).

> **Teaching note — registrar vs host vs DNS:** three separate jobs that a
> beginner often assumes are one. The *registrar* rents you the name. The *host*
> stores the files (GitHub, free). The *DNS provider* maps name→server (comes
> free with the registrar). This plan uses the registrar only for its free DNS;
> hosting stays on GitHub.

## Step 2 — Decide the address shape (recommended: apex + www)

Two flavours of signpost, treated differently by DNS rules:

- **Apex / root** — `hemma.se`, nothing in front. DNS rules require a bare name
  to use **A/AAAA records** (point at numeric IP addresses). You'll point it at
  GitHub's four fixed IPs.
- **Subdomain** — `www.hemma.se`. Can use a **CNAME record** (points at another
  *name*, `alanvardon.github.io`, which is sturdier if GitHub ever changes IPs).

**Decision: serve at the apex `hemma.se`, and make `www.hemma.se` redirect to
it.** This is the polished setup and costs one extra record. GitHub Pages does
the www→apex redirect automatically once both are configured.

## Step 3 — (do first, it's free) confirm the repo is ready

Nothing to change here yet — just confirm the current deploy is green so you're
moving a *working* site, not debugging two things at once:

- `gh run list --workflow="Deploy Hemma·OS to GitHub Pages" --limit 1` shows the
  latest run succeeded, and `alanvardon.github.io/hemma-os/` loads + you can log
  in. This is your rollback baseline.

## Step 4 — Tell GitHub the custom domain

Repo → **Settings → Pages → "Custom domain"** → type `hemma.se` → **Save**.

GitHub will show "DNS check in progress" (it can't verify until Step 5's records
exist — that's expected; do Step 5 next). Leave **"Enforce HTTPS" unchecked for
now** — you can only tick it after GitHub has issued the certificate, which
needs DNS to resolve first (Step 7).

> **Gotcha #1 — the CNAME file gets wiped every deploy.** With the *legacy*
> branch-based Pages, typing the domain here writes a `CNAME` file into your
> repo. **You use GitHub *Actions* to deploy** (`deploy.yml`), which rebuilds the
> `_site` folder from scratch on every push. So even after you set the domain in
> the UI, the *next* deploy uploads a `_site` with **no `CNAME` file**, and
> GitHub drops your custom domain. Step 5b fixes this permanently.

## Step 5 — Create the DNS records at the registrar

In the registrar's DNS panel for `hemma.se`, create these records. `@` means the
apex (the bare `hemma.se`); some panels want the field left blank instead of `@`.

**Apex A records (IPv4) — all four, GitHub's published Pages IPs:**

| Type | Name | Value           |
|------|------|-----------------|
| A    | `@`  | `185.199.108.153` |
| A    | `@`  | `185.199.109.153` |
| A    | `@`  | `185.199.110.153` |
| A    | `@`  | `185.199.111.153` |

**Apex AAAA records (IPv6) — optional but recommended, same four hosts:**

| Type | Name | Value                    |
|------|------|--------------------------|
| AAAA | `@`  | `2606:50c0:8000::153`    |
| AAAA | `@`  | `2606:50c0:8001::153`    |
| AAAA | `@`  | `2606:50c0:8002::153`    |
| AAAA | `@`  | `2606:50c0:8003::153`    |

**www subdomain — one CNAME:**

| Type  | Name  | Value                    |
|-------|-------|--------------------------|
| CNAME | `www` | `alanvardon.github.io.`  |

> Note the trailing dot on `alanvardon.github.io.` — some panels require it (it
> means "this is a complete, absolute name"), most add it for you. Point `www`
> at **`alanvardon.github.io`, the account host — NOT** `alanvardon.github.io/hemma-os`;
> a CNAME points at a *host*, never a path.

> **Before you rely on these IPs:** GitHub occasionally revises its Pages IP
> list. Confirm against the current GitHub Pages docs ("Managing a custom domain
> → Configuring an apex domain") when you do this. The `www` CNAME is immune to
> IP changes, which is one reason we keep it.

### Step 5b — Make the `CNAME` file survive deploys (the one repo edit)

Add an `echo` to the assembly step in
`.github/workflows/deploy.yml` so every build writes the domain into `_site`.
Insert this line right after the `cp icon.svg manifest.webmanifest _site/` line
(currently `deploy.yml:66`), inside the `Assemble the Hemma·OS site` step:

```yaml
      - name: Assemble the Hemma·OS site
        run: |
          mkdir -p _site
          cp web/dist/index.html _site/index.html
          cp -r web/dist/bk-assets _site/bk-assets
          cp icon.svg manifest.webmanifest _site/
          # Custom domain: GitHub Pages needs a CNAME file in the published
          # artifact, or the Actions deploy drops the domain each run (plan 81).
          echo 'hemma.se' > _site/CNAME
```

Commit on a branch (`chore/custom-domain-cname`), PR to `main`, let CI pass,
merge. The deploy that follows publishes with the `CNAME` and the domain sticks.

## Step 6 — Update Supabase Auth (the silent-login-breaker)

> **Gotcha #2 — this is the step that breaks login if skipped, and it fails
> *silently*.** The site will load perfectly on `hemma.se`, but magic-link login
> won't complete. `AuthGate.tsx:130` asks Supabase to email a link back to
> `https://hemma.se/`. Supabase **only redirects to URLs on its allow-list** — a
> security feature so an attacker can't redirect your auth tokens elsewhere.
> `hemma.se` isn't on the list yet, so Supabase refuses and the user is bounced.

Supabase dashboard → **Authentication → URL Configuration**:

- **Site URL:** set to `https://hemma.se`
- **Redirect URLs** (allow-list): **add** `https://hemma.se/**` and
  `https://www.hemma.se/**`. **Keep** the existing
  `https://alanvardon.github.io/hemma-os/**` entry during the transition so the
  old URL still logs in until you've fully cut over. (`/**` is a wildcard so any
  in-app path is allowed.)

No code and no redeploy needed — this is pure Supabase config, and the app
already computes the right redirect at runtime.

## Step 7 — Wait for DNS, then enforce HTTPS

- **Propagation:** DNS changes take anywhere from minutes to ~24h to spread.
  Check with `dig hemma.se +short` (should return the four `185.199.x.153` IPs)
  and `dig www.hemma.se +short` (should chain to `alanvardon.github.io`). Or use
  the "DNS check" status on the Pages settings screen.
- **Certificate:** once DNS resolves, GitHub automatically requests a free
  Let's Encrypt TLS certificate (can take up to ~24h after the DNS check
  passes). When the Pages screen stops warning and offers it, **tick "Enforce
  HTTPS."** This makes `http://` auto-upgrade to `https://` — required for a
  finance app and for the Supabase session cookies to behave.

## Step 8 — Verify end-to-end, then cut over

Once `https://hemma.se` serves the app with a valid padlock:

- Log out, log in via magic link from a real inbox → the emailed link returns
  you to `https://hemma.se/` and you land authenticated (proves Step 6).
- Open a deep link directly, e.g. `https://hemma.se/#/bolanekoll`, and hard-
  refresh → loads without a 404 (proves hash routing survives the move).
- After a few days of both URLs working, optionally remove the
  `alanvardon.github.io/hemma-os/**` redirect entry from Supabase to finish the
  cutover. (The old GitHub URL will then redirect to `hemma.se` anyway once the
  custom domain is set.)

---

## Acceptance criteria

- `dig hemma.se +short` returns the four `185.199.x.153` addresses; `dig
  www.hemma.se +short` resolves through `alanvardon.github.io`.
- Repo Settings → Pages shows custom domain `hemma.se` with a green check and
  **"Enforce HTTPS" enabled**.
- `.github/workflows/deploy.yml` writes `_site/CNAME` containing `hemma.se`, and
  a fresh deploy after merging Step 5b **keeps** the custom domain (it does not
  revert to `alanvardon.github.io` on the next push — this is the specific
  regression Gotcha #1 causes).
- `https://hemma.se` loads the hub; `https://hemma.se/#/bolanekoll` hard-refresh
  loads without 404; the browser shows a valid TLS padlock.
- Magic-link login initiated on `hemma.se` completes and returns the user to
  `https://hemma.se/` authenticated — confirming Supabase Site URL + Redirect
  allow-list include the new domain.
- `https://alanvardon.github.io/hemma-os/` still resolves (redirects to the
  custom domain) — no hard break of the old address.

## Out of scope

- **Custom email domain / sending magic links from `@hemma.se`** — separate
  concern (needs MX records + an email provider + Supabase SMTP config). Tracked
  conceptually by plan 72; not part of the hosting move.
- **Moving off GitHub Pages to another host** (Netlify/Vercel/Cloudflare Pages)
  — not needed; the `.netlifyignore` file in the repo root is vestigial and can
  be deleted separately. This plan deliberately keeps hosting on GitHub.
- **Switching away from hash routing to real path routing** (`hemma.se/bolanekoll`
  without the `#`) — a nice future polish, but it *requires* an SPA 404-fallback
  and re-testing every route; explicitly not bundled into the domain move so the
  two risks don't compound. Natural follow-up plan if wanted.
- **`www`-as-primary instead of apex-as-primary** — decided apex-primary in
  Step 2; not revisiting.
