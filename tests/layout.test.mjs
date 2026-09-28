import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Source contracts supplement (not replace) browser geometry checks at each breakpoint.
const css = await readFile(new URL('../client/app.css', import.meta.url), 'utf8');
const app = await readFile(new URL('../client/App.jsx', import.meta.url), 'utf8');
const rule = selector => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = css.match(new RegExp(`(?:^|\\n)${escaped} \\{([^}]+)\\}`));
  assert.ok(match, `Missing rule: ${selector}`);
  return match[1];
};

test('v14 shell uses one shared sidebar width and compact padding', () => {
  assert.match(rule(':root'), /--sidebar-width:\s*214px/);
  assert.match(rule('.sidebar'), /width:\s*var\(--sidebar-width\)/);
  assert.match(rule('.main-shell'), /margin-left:\s*var\(--sidebar-width\)/);
  assert.match(rule('.sidebar'), /padding:\s*9px 7px/);
  assert.match(rule('.sidebar'), /overflow-y:\s*auto/);
  assert.match(rule('.green-header'), /height:\s*44px/);
  assert.match(rule('.green-header > div:first-child'), /left:\s*50%/);
  assert.match(rule('.breadcrumb'), /min-height:\s*42px/);
  assert.match(rule('.workspace-content'), /padding:\s*25px 28px/);
  assert.match(css, /@media \(max-width: 1100px\)\s*\{\s*:root\s*\{\s*--sidebar-width:\s*185px/);
  assert.doesNotMatch(css, /(?:width|margin-left):\s*(?:238|217|198)px/);
});

test('mobile drawer excludes closed controls from tab order and restores menu focus', () => {
  assert.match(app, /window\.matchMedia\('\(max-width: 760px\)'\)/);
  assert.match(app, /inert=\{mobileNav && !sidebar\}/);
  assert.match(app, /aria-hidden=\{mobileNav && !sidebar \? true : undefined\}/);
  assert.match(app, /sidebarRef\.current\?\.querySelector\([^;]+\)\?\.focus\(\)/);
  assert.match(app, /menuButtonRef\.current\?\.focus\(\)/);
  assert.match(app, /aria-controls="workspace-sidebar" aria-expanded=\{mobileNav && sidebar\}/);
});

test('v14 four-column cards preserve their square-ish ratio and readable metrics', () => {
  assert.match(rule('.candidate-grid'), /repeat\(4, minmax\(0, 1fr\)\)/);
  assert.match(rule('.candidate-grid'), /gap:\s*10px/);
  assert.match(rule('.candidate'), /aspect-ratio:\s*1 \/ 1\.08/);
  assert.match(rule('.candidate'), /grid-template-rows:\s*28px minmax\(78px, 1fr\) 34px 22px 24px/);
  assert.match(rule('.candidate-visual > div'), /min-height:\s*0 !important/);
  assert.match(rule('.candidate h3'), /font-size:\s*11px/);
  assert.match(rule('.candidate-secondary'), /font-size:\s*9px/);
  assert.match(css, /@media \(max-width: 750px\)\s*\{\s*\.candidate-grid\s*\{\s*grid-template-columns:\s*minmax\(0, 1fr\)/);
});
