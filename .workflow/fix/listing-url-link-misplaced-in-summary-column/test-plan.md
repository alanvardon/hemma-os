# Test plan: listing-URL-link-misplaced-in-summary-column

- [ ] Open bostadskalkyl.html in a browser and verify the summary column contains no clickable URL link at the bottom
- [ ] Enter a valid URL (e.g. https://www.hemnet.se/bostad/test) in the "Annonslänk" field in Section 2 and verify the summary column still shows no URL
- [ ] With a URL entered, click the "Open ›" button next to the Annonslänk field and verify it navigates to the URL (inline onclick handler works independently of the removed openListingLink function)
- [ ] Verify there are no JS console errors on page load or on entering a URL
- [ ] Save a scenario with a listingUrl value, reload, restore the scenario, and confirm the URL is correctly repopulated in the Section 2 input field (TEXT_IDS save/restore unchanged)
- [ ] Verify calc() still runs on every input change without errors (no references to removed DOM elements)
- [ ] Verify the summary panel updates correctly for all other fields (equity, monthly costs, etc.) — calc() removal was limited to the listing link block only
