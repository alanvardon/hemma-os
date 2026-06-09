// pages.test.js — file-structure tests for the HTML page layout
// These tests verify the rename of index.html → kalkyl.html (task 1 of the homepage plan).
// Run with: node --test pages.test.js

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

// ── Helpers ─────────────────────────────────────────────────────────

function fileExists(filename) {
  return fs.existsSync(path.join(ROOT, filename));
}

function readFile(filename) {
  return fs.readFileSync(path.join(ROOT, filename), 'utf8');
}

// ── Helpers (CSS) ────────────────────────────────────────────────────

/**
 * Returns the combined CSS text that applies to kalkyl.html:
 * - contents of styles.css (if present)
 * - any inline <style> blocks inside kalkyl.html (if present)
 */
function kalkylCss() {
  let css = '';
  if (fileExists('styles.css')) css += readFile('styles.css');
  if (fileExists('kalkyl.html')) {
    const html = readFile('kalkyl.html');
    const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(html)) !== null) css += m[1];
  }
  return css;
}

// ── Tests ────────────────────────────────────────────────────────────

test('kalkyl.html exists', () => {
  assert.ok(
    fileExists('kalkyl.html'),
    'kalkyl.html must exist — the calculator has been renamed from index.html'
  );
});

test('kalkyl.html contains the calculator application', () => {
  // The calculator is identified by its core input elements and script references.
  // All of these must be present in kalkyl.html after the rename.
  assert.ok(
    fileExists('kalkyl.html'),
    'kalkyl.html must exist before its content can be checked'
  );
  const html = readFile('kalkyl.html');
  assert.ok(html.includes('id="salePrice"'),    'kalkyl.html must contain the salePrice input');
  assert.ok(html.includes('id="saveBtn"'),       'kalkyl.html must contain the saveBtn button');
  assert.ok(html.includes('app.js'),             'kalkyl.html must reference app.js');
});

test('index.html does not contain the calculator application', () => {
  // After the rename, index.html should NOT be the calculator page.
  // Either it does not exist yet (pre-homepage-task) or it is a new homepage file.
  // In both cases it must not contain the salePrice input that belongs to the calculator.
  if (!fileExists('index.html')) {
    // File absent — the rename happened and the new homepage hasn't been created yet.
    // This is the expected state after task 1 completes.
    assert.ok(true);
    return;
  }
  const html = readFile('index.html');
  assert.ok(
    !html.includes('id="salePrice"'),
    'index.html must NOT contain the calculator salePrice input — it is no longer the calculator page'
  );
});

// ── Task: back-to-home nav link in kalkyl.html ───────────────────────

test('kalkyl.html contains an <a> element with class nav-home-link', () => {
  assert.ok(fileExists('kalkyl.html'), 'kalkyl.html must exist');
  const html = readFile('kalkyl.html');
  // The element must be an anchor tag with the nav-home-link class
  const anchorRe = /<a\b[^>]*\bnav-home-link\b[^>]*>/i;
  assert.ok(
    anchorRe.test(html),
    'kalkyl.html must contain an <a> with class nav-home-link'
  );
});

test('nav-home-link anchor has href="index.html"', () => {
  assert.ok(fileExists('kalkyl.html'), 'kalkyl.html must exist');
  const html = readFile('kalkyl.html');
  // Extract the opening tag of the nav-home-link anchor
  const anchorMatch = html.match(/<a\b[^>]*\bnav-home-link\b[^>]*>/i);
  assert.ok(anchorMatch, 'nav-home-link anchor must be present');
  const tag = anchorMatch[0];
  assert.ok(
    /href=["']index\.html["']/.test(tag),
    'nav-home-link anchor must have href="index.html"'
  );
});

test('nav-home-link anchor text is "← Hem"', () => {
  assert.ok(fileExists('kalkyl.html'), 'kalkyl.html must exist');
  const html = readFile('kalkyl.html');
  // ← can be represented as the literal char U+2190 or as the HTML entity &#8592; / &larr;
  const hasText =
    html.includes('← Hem') ||
    html.includes('&#8592; Hem') ||
    html.includes('&larr; Hem');
  assert.ok(hasText, 'nav-home-link must display the text "← Hem"');
});

test('nav-home-link is inside the page header in kalkyl.html', () => {
  assert.ok(fileExists('kalkyl.html'), 'kalkyl.html must exist');
  const html = readFile('kalkyl.html');

  const headerStart = html.indexOf('page-header');
  assert.ok(headerStart !== -1, '.page-header must exist in kalkyl.html');

  const linkPos = html.indexOf('nav-home-link');
  assert.ok(linkPos !== -1, 'nav-home-link must exist in kalkyl.html');

  // The link must appear after the opening of .page-header …
  assert.ok(
    linkPos > headerStart,
    'nav-home-link must appear after the .page-header opening'
  );
  // … and before the main content area (class="layout") so it stays in the header.
  const layoutPos = html.indexOf('class="layout"');
  if (layoutPos !== -1) {
    assert.ok(
      linkPos < layoutPos,
      'nav-home-link must appear before the main layout area, i.e. inside the header'
    );
  }
});

test('.nav-home-link CSS rule suppresses the default underline', () => {
  const css = kalkylCss();
  assert.ok(
    css.includes('.nav-home-link'),
    'a CSS rule for .nav-home-link must exist in styles.css or kalkyl.html <style>'
  );
  // Find the rule block for .nav-home-link (not :hover variant)
  // Accept both `text-decoration: none` and `text-decoration-line: none`
  const ruleMatch = css.match(/\.nav-home-link\s*\{([^}]*)\}/);
  assert.ok(
    ruleMatch,
    '.nav-home-link must have a CSS rule block'
  );
  assert.ok(
    /text-decoration[^:]*:\s*none/.test(ruleMatch[1]),
    '.nav-home-link CSS rule must set text-decoration to none'
  );
});

test('.nav-home-link:hover CSS rule adds an underline', () => {
  const css = kalkylCss();
  // Find the :hover rule block
  const hoverMatch = css.match(/\.nav-home-link\s*:\s*hover\s*\{([^}]*)\}/);
  assert.ok(
    hoverMatch,
    '.nav-home-link:hover CSS rule must exist in styles.css or kalkyl.html <style>'
  );
  assert.ok(
    /text-decoration[^:]*:\s*underline/.test(hoverMatch[1]),
    '.nav-home-link:hover CSS rule must set text-decoration to underline'
  );
});

// ── Helper: extract all CSS from index.html <style> blocks ───────────

function indexCss() {
  let css = '';
  if (fileExists('index.html')) {
    const html = readFile('index.html');
    const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
    let m;
    while ((m = re.exec(html)) !== null) css += m[1];
  }
  return css;
}

// ── Task: Create new index.html homepage ─────────────────────────────

test('index.html exists as the new homepage', () => {
  assert.ok(
    fileExists('index.html'),
    'index.html must exist — it is the new homepage (not the calculator)'
  );
});

test('index.html has HTML5 boilerplate with lang="sv"', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  assert.ok(
    /^<!DOCTYPE html>/i.test(html.trimStart()),
    'index.html must start with <!DOCTYPE html>'
  );
  assert.ok(
    /<html\b[^>]*\blang=["']sv["'][^>]*>/i.test(html),
    'index.html <html> element must have lang="sv"'
  );
  assert.ok(
    /<meta\b[^>]*\bcharset\b/i.test(html),
    'index.html must have a <meta charset> tag'
  );
  assert.ok(
    /<meta\b[^>]*\bviewport\b/i.test(html),
    'index.html must have a <meta name="viewport"> tag'
  );
});

test('index.html body element has id="home-root"', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  assert.ok(
    /<body\b[^>]*\bid=["']home-root["'][^>]*>/i.test(html),
    'the <body> element must have id="home-root"'
  );
});

test('index.html contains a .home-hero section', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  assert.ok(
    /class=["'][^"']*\bhome-hero\b[^"']*["']/.test(html),
    'index.html must contain an element with class "home-hero"'
  );
});

test('index.html .home-hero contains a non-empty <h1> headline', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  const heroIdx = html.indexOf('home-hero');
  assert.ok(heroIdx !== -1, '.home-hero element must exist');
  const fromHero = html.slice(heroIdx);
  const h1Match = fromHero.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  assert.ok(h1Match, 'an <h1> with closing tag must appear inside .home-hero');
  assert.ok(
    h1Match[1].trim().length > 0,
    '<h1> inside .home-hero must have non-empty text'
  );
});

test('index.html contains a .tool-card anchor element', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  assert.ok(
    /<a\b[^>]*\btool-card\b[^>]*>/i.test(html),
    'index.html must contain an <a> element with class "tool-card"'
  );
});

test('index.html .tool-card anchor has href="kalkyl.html"', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  const match = html.match(/<a\b[^>]*\btool-card\b[^>]*>/i);
  assert.ok(match, '.tool-card anchor must be present in index.html');
  assert.ok(
    /href=["']kalkyl\.html["']/.test(match[0]),
    '.tool-card anchor href must be "kalkyl.html"'
  );
});

test('index.html .tool-card__cta is nested inside .tool-card', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const html = readFile('index.html');
  const toolCardStart = html.search(/<a\b[^>]*\btool-card\b[^>]*>/i);
  assert.ok(toolCardStart !== -1, '.tool-card anchor must exist');
  const closingIdx = html.indexOf('</a>', toolCardStart);
  assert.ok(closingIdx !== -1, '.tool-card anchor must have a closing </a>');
  const cardContent = html.slice(toolCardStart, closingIdx);
  assert.ok(
    cardContent.includes('tool-card__cta'),
    '.tool-card__cta must appear inside the .tool-card anchor element'
  );
});

test('index.html CSS sets a colour on .tool-card__cta', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  assert.ok(css.length > 0, 'index.html must contain a <style> block');
  assert.ok(
    /\.tool-card__cta\b/.test(css),
    'a CSS rule for .tool-card__cta must exist in index.html <style>'
  );
  const ctaMatch = css.match(/\.tool-card__cta\s*\{([^}]*)\}/);
  assert.ok(ctaMatch, '.tool-card__cta must have its own CSS rule block');
  assert.ok(
    /\bcolor\s*:/.test(ctaMatch[1]),
    '.tool-card__cta rule must set a color property (accent colour)'
  );
});

test('index.html CSS sets a dark background colour', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  assert.ok(css.length > 0, 'index.html must contain a <style> block');
  // Dark hex values: first red-channel digit 0–3 covers #000–#3f… range (e.g. #0f1117, #1c1c1a, #242420)
  const hasDarkHex =
    /#[0-3][0-9a-fA-F]{5}\b/.test(css) ||   // 6-digit dark hex
    /#[0-3][0-9a-fA-F]{2}\b/.test(css);      // 3-digit dark hex (#111, #222, #333)
  assert.ok(
    hasDarkHex,
    'index.html CSS must include at least one dark hex colour value (e.g. #0f1117, #1c1c1a, #111)'
  );
  // body or page-root must have a background rule
  const hasBodyBg =
    /body\s*\{[^}]*background/.test(css) ||
    /#home-root\s*\{[^}]*background/.test(css) ||
    /html\s*\{[^}]*background/.test(css);
  assert.ok(
    hasBodyBg,
    'index.html CSS must set background on body, html, or #home-root'
  );
});

test('index.html CSS .tool-card:hover sets box-shadow for the lift effect', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  const hoverMatch = css.match(/\.tool-card\s*:\s*hover\s*\{([^}]*)\}/);
  assert.ok(
    hoverMatch,
    '.tool-card:hover CSS rule must exist in index.html <style>'
  );
  assert.ok(
    /box-shadow/.test(hoverMatch[1]),
    '.tool-card:hover rule must include box-shadow for the visual lift'
  );
});

test('index.html CSS .tool-card:hover applies translateY for upward movement', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  const hoverMatch = css.match(/\.tool-card\s*:\s*hover\s*\{([^}]*)\}/);
  assert.ok(
    hoverMatch,
    '.tool-card:hover CSS rule must exist in index.html <style>'
  );
  assert.ok(
    /translateY/.test(hoverMatch[1]),
    '.tool-card:hover rule must use translateY (e.g. transform: translateY(-4px))'
  );
});

test('index.html CSS .tool-card has a max-width property', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  const cardMatch = css.match(/\.tool-card\s*\{([^}]*)\}/);
  assert.ok(
    cardMatch,
    '.tool-card CSS rule block must exist in index.html <style>'
  );
  assert.ok(
    /max-width/.test(cardMatch[1]),
    '.tool-card rule must set max-width (expected ~420px)'
  );
});

test('index.html CSS uses flexbox to centre the card', () => {
  assert.ok(fileExists('index.html'), 'index.html must exist');
  const css = indexCss();
  assert.ok(
    /display\s*:\s*flex/.test(css),
    'index.html CSS must include display:flex for card centring'
  );
  assert.ok(
    /align-items\s*:\s*center|justify-content\s*:\s*center/.test(css),
    'index.html CSS must use align-items:center or justify-content:center to centre the card'
  );
});

// ── Task: Update README.md and CLAUDE.md entry-point references ───────
//
// index.html is now the homepage; kalkyl.html is the calculator.
// Both README.md and CLAUDE.md must reflect this new file structure.

test('README.md references kalkyl.html as the calculator entry point', () => {
  assert.ok(fileExists('README.md'), 'README.md must exist');
  const text = readFile('README.md');
  const lines = text.split('\n');
  // kalkyl.html must appear on a line that also carries entry-point semantic context.
  // A bare rename note (e.g. "renamed index.html to kalkyl.html") is NOT sufficient.
  const entryPointKeywords = [
    'calculator', 'kalkylator', 'entry point', 'entry-point',
    'open', 'öppna', 'launch', 'start', 'browser', 'beräkna',
  ];
  const hasEntryPointRef = lines.some(line => {
    if (!line.includes('kalkyl.html')) return false;
    const lower = line.toLowerCase();
    return entryPointKeywords.some(kw => lower.includes(kw));
  });
  assert.ok(
    hasEntryPointRef,
    'README.md must reference kalkyl.html in an entry-point context (e.g., "Open kalkyl.html to use the calculator")'
  );
});

test('README.md does not describe index.html as the calculator', () => {
  assert.ok(fileExists('README.md'), 'README.md must exist');
  const text = readFile('README.md');
  // index.html is the homepage now; no line should pair it with calculator context.
  const lines = text.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!line.includes('index.html')) continue;
    const calcContext =
      lower.includes('calculator') ||
      lower.includes('kalkylator') ||
      lower.includes('entry point') ||
      lower.includes('entry-point') ||
      lower.includes('öppna') ||
      lower.includes('open') ||
      lower.includes('launch') ||
      lower.includes('start');
    assert.ok(
      !calcContext,
      `README.md must not describe index.html as the calculator entry point. Offending line: "${line}"`
    );
  }
});

test('CLAUDE.md references kalkyl.html as the calculator entry point', () => {
  assert.ok(fileExists('CLAUDE.md'), 'CLAUDE.md must exist');
  const text = readFile('CLAUDE.md');
  const lines = text.split('\n');
  // kalkyl.html must appear on a line that also carries entry-point semantic context.
  // A bare rename note (e.g. "renamed index.html to kalkyl.html") is NOT sufficient.
  const entryPointKeywords = [
    'calculator', 'kalkylator', 'entry point', 'entry-point',
    'open', 'öppna', 'launch', 'start', 'browser', 'beräkna',
  ];
  const hasEntryPointRef = lines.some(line => {
    if (!line.includes('kalkyl.html')) return false;
    const lower = line.toLowerCase();
    return entryPointKeywords.some(kw => lower.includes(kw));
  });
  assert.ok(
    hasEntryPointRef,
    'CLAUDE.md must reference kalkyl.html in an entry-point context (e.g., "Open kalkyl.html to use the calculator")'
  );
});

test('CLAUDE.md does not describe index.html as the calculator', () => {
  assert.ok(fileExists('CLAUDE.md'), 'CLAUDE.md must exist');
  const text = readFile('CLAUDE.md');
  // index.html is the homepage; no line should pair it with calculator context.
  const lines = text.split('\n');
  for (const line of lines) {
    const lower = line.toLowerCase();
    if (!line.includes('index.html')) continue;
    const calcContext =
      lower.includes('calculator') ||
      lower.includes('kalkylator') ||
      lower.includes('entry point') ||
      lower.includes('entry-point') ||
      lower.includes('öppna') ||
      lower.includes('open') ||
      lower.includes('launch') ||
      lower.includes('start');
    assert.ok(
      !calcContext,
      `CLAUDE.md must not describe index.html as the calculator entry point. Offending line: "${line}"`
    );
  }
});
