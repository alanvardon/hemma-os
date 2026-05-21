# Plan: listing-URL-link-misplaced-in-summary-column

## Title
`listing-URL-link-misplaced-in-summary-column`

## Type
`fix`

## Root Cause

In `index.html`, there is a `<div id="listingLinkWrap">` containing an `<a id="listingLinkBtn">` that sits inside the summary column (`.summary-col`), positioned after the last `sum-card` ("Equity after 10 years"). The `calc()` function populates this anchor with the raw URL and makes it visible whenever `listingUrl` has a value. The user sees this URL string rendered at the bottom of their summary panel.

The listing URL input itself (`id="listingUrl"`) is already correctly placed in Section 2 of the inputs column, and an "Open ›" button right beside it already opens the link. There is no user value in also displaying a redundant clickable URL inside the summary column. The fix is to remove the `listingLinkWrap` div from the summary column entirely and remove its companion JS logic.

---

## Affected Areas

**HTML**
- Remove the `<div id="listingLinkWrap">` block from inside `.summary-col`.

**JavaScript**
- In `calc()`: remove the "Listing link" block that reads `listingUrl`, queries `listingLinkWrap`/`listingLinkBtn`, and toggles visibility.
- Remove the `openListingLink()` function — it is unused by any other element once the summary link is gone. (The "Open ›" button in Section 2 uses an inline `onclick` handler that calls `window.location.href` directly, not `openListingLink()`.)

**CSS**
- Remove the `.listing-link-btn` rule and its `:hover` variant — no element will carry that class after the div is deleted.

---

## Functions Impacted

| Function | Change |
|---|---|
| `calc()` | Remove the "Listing link" block (approximately 12 lines) |
| `openListingLink()` | Delete entirely — becomes dead code |

No changes needed to `set()`, `val()`, `readInputs()`, `saveSession()`, or `restoreSession()`. `listingUrl` remains in `TEXT_IDS` and continues to be saved/restored as before.

---

## localStorage

No changes. `bostadskalkyl_session` already saves and restores `listingUrl` via `TEXT_IDS`; that behaviour is untouched.

---

## New DOM Elements

None. This is a removal-only fix.

---

## Implementation Order

1. Open `index.html`.
2. Delete the `<div id="listingLinkWrap">…</div>` in the summary column.
3. In `calc()`, delete the "Listing link" comment and the lines that follow it (the block querying `listingUrl`, `listingLinkWrap`, `linkBtn`, and the `if/else` toggling their `display`).
4. Delete the `openListingLink()` function (the entire function body).
5. In the CSS `<style>` block, delete the `.listing-link-btn` rules (declaration block and `:hover` variant).
6. Verify in a browser that the summary column no longer shows the URL, and that the "Open ›" button in Section 2 still navigates correctly when a URL is entered.

---

## Risks

- The "Open ›" button in Section 2 uses its own inline `onclick` with `window.location.href` — it does **not** call `openListingLink()` — so deleting that function will not break the button. Confirm this inline handler still works after the edit.
- No other element references `listingLinkWrap`, `listingLinkBtn`, or `openListingLink` anywhere else in the file. Confirm with a quick search after deletion.
- Saving and restoring a scenario that previously stored a `listingUrl` value should continue to work because the input (`id="listingUrl"`) in Section 2 remains untouched.

---

```
PLAN COMPLETE: title=listing-URL-link-misplaced-in-summary-column, type=fix
```
