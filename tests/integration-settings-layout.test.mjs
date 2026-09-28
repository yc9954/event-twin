import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { build } from 'esbuild';

test('settings body owns modal gutters and preserves readable, shrink-safe card spacing', async () => {
  const css = await readFile(new URL('../client/integration-settings.css', import.meta.url), 'utf8');
  assert.match(css, /\.modal > \.integration-settings \{ padding: 23px; \}/);
  const narrow = css.slice(css.indexOf('@media (max-width: 760px)'));
  assert.match(narrow, /\.modal > \.integration-settings \{ padding: 18px; \}/);
  assert.match(narrow, /\.integration-test \{ padding: 14px; gap: 12px; \}/);
  assert.match(css, /overflow-wrap: anywhere;/);
  assert.match(css, /flex: 0 0 16px;/);
  assert.match(css, /min-height: 40px;/);
  assert.match(css, /:focus-visible/);
  assert.doesNotMatch(css, /--sidebar-width:|\.sidebar\s*\{|\.modal\s*\{/);
});

test('settings spacing markup retains consent, disabled probe and honest receipt status', async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../client/IntegrationSettings.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: {'.css':'empty'},
  });
  const result = {exports:{}};
  new Function('require','module','exports',compiled.outputFiles[0].text)(createRequire(import.meta.url),result,result.exports);
  const html = renderToStaticMarkup(React.createElement(result.exports.default, {
    health: { provider: {provider:'nvidia',model:'test/model',connectionId:'test-connection',configured:false,missing:['NVIDIA_API_KEY']}, natCheck:{verified:true,version:'1.9.0',checkedAt:'2026-09-28T00:00:00Z'} },
    onHealth:()=>assert.fail('Rendering must not trigger a connection check'),
  }));
  assert.match(html, /class="integration-settings"/);
  assert.match(html, /class="integration-notes" aria-label="연결 설정 안내"/);
  assert.equal((html.match(/class="integration-test"/g)||[]).length,2);
  assert.match(html, /<input type="checkbox"\/>/);
  assert.match(html, /<button type="button" disabled="">연결 검사 실행/);
  assert.match(html, /NAT 1.9.0 · 도구 왕복 확인/);
  assert.match(html, /모델 추론 없음 · 읽기 전용/);
} );

test('a probe receipt from another connection is not shown as current verification', async () => {
  const compiled = await build({
    entryPoints: [fileURLToPath(new URL('../client/IntegrationSettings.jsx', import.meta.url))],
    bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external', loader: { '.css': 'empty' },
  });
  const result = { exports: {} };
  new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(createRequire(import.meta.url), result, result.exports);
  const html = renderToStaticMarkup(React.createElement(result.exports.default, {
    health: {
      provider: { provider: 'nvidia', model: 'current-model', connectionId: 'new-connection', configured: true },
      integrationCheck: { provider: 'nvidia', model: 'current-model', connectionId: 'old-connection', status: 'verified', inferenceVerified: true, toolCallingVerified: true, checkedAt: '2026-09-28T00:00:00Z', durationMs: 100 },
    },
    onHealth: () => assert.fail('SSR must not trigger a probe'),
  }));
  assert.match(html, /이전 연결 검사 기록 · 현재 설정 재검사 필요/);
  assert.doesNotMatch(html, /class="integration-receipt verified"/);
  assert.match(html, /검사 당시 추론 확인/);
  const unboundHtml = renderToStaticMarkup(React.createElement(result.exports.default, {
    health: {
      provider: { provider: 'nvidia', model: 'current-model', connectionId: 'new-connection', configured: true },
      integrationCheck: { provider: 'nvidia', model: 'current-model', status: 'verified', inferenceVerified: true, toolCallingVerified: true, checkedAt: '2026-09-28T00:00:00Z', durationMs: 100 },
    },
    onHealth: () => assert.fail('SSR must not trigger a probe'),
  }));
  assert.match(unboundHtml, /현재 연결과 동일성 미확인/);
  assert.doesNotMatch(unboundHtml, /class="integration-receipt verified"/);
});
