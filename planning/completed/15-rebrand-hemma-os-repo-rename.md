# Plan 15 — Rebrand to "Hemma·OS" + repo rename (Hemma `web/`)

**Status:** brand decision + migration checklist · **Owner model:** Sonnet-
suitable (mechanical string edits) + a few **human GitHub-settings steps** the
agent can't do. · **Relationship:** standalone; touches brand strings + repo
config, not tool logic.

## Decisions locked (source of truth)

1. **Product name = "Hemma·OS"** — direction (b): the "suite that runs your
   household" framing, Nordic anchor kept, **no surname in the wordmark**.
   "Vardon" stays as footer attribution (already there:
   `Home.tsx:349` "Hemma · built by the Vardon family").
2. **Wordmark = "Hemma·OS"** — repurpose today's accent **dot** as the separator
   (evolves the existing "Hemma." mark rather than discarding it). Page-title
   pattern: `Konsultkalkyl — Hemma·OS`.
3. **Repo slug = `hemma-os`** (kebab of the product).
4. **Leave the `bostadskalkyl_*` localStorage data keys and `bk-assets` build
   dir as-is** (option a). localStorage is keyed by **origin**, so live data
   survives the rename regardless; the keys are invisible internals — renaming
   them is pure risk to real data (scenarios, salary log, month-end). Rename only
   **brand-facing + cosmetic** strings. Add a one-line comment by the key
   constants noting the legacy prefix is intentional.

### Brainstorm (parked alternatives, for the record)
| Candidate | Read | Verdict |
|-----------|------|---------|
| **Hemma·OS** ✅ | suite/operating-system for the home, Nordic | **chosen** |
| Hemma | clean single word, but loses the "suite" idea | status-quo fallback |
| Vardon Hemma OS | most personal, longest, surname in mark | → surname kept as attribution instead |
| Hemma Studio / Hemma Suite | softer than "OS" | "OS" felt more on-point |
| Bovy / Hushåll / Bona | fresh coinages | discard — abandons established "Hemma" equity |

## Why the rename is cheap (verified)
- **`vite base: './'`** is relative (`web/vite.config.ts`) → the Pages subpath
  change (`/bostadskalkyl/` → `/hemma-os/`) needs **no code change**.
- **GitHub auto-redirects** the old repo URL after rename; old links keep working
  for a while (Pages old-path is best-effort — see risks).
- **No data loss** — same origin (`alanvardon.github.io`), so all
  `bostadskalkyl_*` localStorage persists.

## Work — brand strings (agent, mechanical)
Rename "Hemma" → "Hemma·OS" only where it's the **product mark / title**, not the
plain back-link "‹ Hemma" (that's a nav label — keep, or update to taste):
- `Home.tsx:133` wordmark `Hemma<span className="dot">.</span>` → render
  `Hemma<span className="dot">·</span>OS` (or keep the dot element, append `OS`).
- `Home.tsx:102` document.title `'Hemma — family hub'` → `'Hemma·OS — family hub'`.
- Per-tool `document.title` suffixes `'… — Hemma'` / `'… · Hemma'` → `Hemma·OS`
  (7 routes: Bostadskalkyl, ScenariosDashboard, Konsult, Löneväxling, Bolånekoll,
  Månadsavslut, Hushållsbudget).
- Footer `Home.tsx:349` `'Hemma · built by the Vardon family'` → `'Hemma·OS ·
  built by the Vardon family'` (keeps the Vardon attribution).
- CSS comment headers referencing "Hemma suite" → "Hemma·OS suite" (cosmetic).
- `index.html` `<title>` / meta, `manifest.webmanifest` name/short_name.
- Back-links "‹ Hemma": **decision** — leave as "Hemma" (nav shorthand reads
  better short) unless you want "‹ Hemma·OS".

## Work — repo/config (cosmetic, agent)
- `.github/workflows/deploy.yml`: workflow name "Deploy Hemma to GitHub Pages" →
  "Deploy Hemma·OS …"; the "(bostadskalkyl)" step labels/comments → hemma-os.
  **No functional change** (Pages artifact, no hardcoded repo URL).
- `web/README.md` / root `README.md`: update name + the live URL to
  `https://alanvardon.github.io/hemma-os/`.
- Leave `assetsDir: 'bk-assets'` and the `bostadskalkyl_*` keys (Decision 4).
  Optional: a comment noting the legacy names are kept deliberately.

## Work — GitHub settings (human, can't be scripted reliably)
1. **Rename the repo**: GitHub → Settings → rename `bostadskalkyl` → `hemma-os`
   (or `gh repo rename hemma-os`). GH adds a redirect from the old name.
2. **Verify Pages** republishes at `https://alanvardon.github.io/hemma-os/` after
   the next `main` push (the deploy action runs on push). Confirm assets load
   (relative base handles the new subpath).
3. **Update local clone** (optional): `git remote set-url origin <new-url>` and
   optionally rename the working dir `bostadskalkyl/` → `hemma-os/` (note: the
   agent's memory/paths reference `bostadskalkyl` — updating the folder is
   cosmetic and can lag).

## Risks
- **Old Pages URL / bookmarks**: the repo redirect is reliable; the old *Pages*
  path may 404. Low impact (personal use). Re-bookmark the new URL.
- **Open PRs / branch protection** unaffected by rename.

## Definition of done
- Wordmark, titles, footer, manifest read "Hemma·OS"; build/lint/test green;
  live site serves at `/hemma-os/` with assets intact; localStorage data
  preserved (open the live site, scenarios/salary/month-end still present).
- `bostadskalkyl_*` keys + `bk-assets` intentionally unchanged, commented as such.
