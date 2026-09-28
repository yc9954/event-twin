import {build} from 'esbuild';
import {mkdir,writeFile} from 'node:fs/promises';
await mkdir(new URL('./dist/',import.meta.url),{recursive:true});
await build({entryPoints:[new URL('./client/index.jsx',import.meta.url).pathname],bundle:true,outfile:new URL('./dist/app.js',import.meta.url).pathname,format:'esm',jsx:'automatic',target:'es2022',minify:true,sourcemap:true,define:{'process.env.NODE_ENV':'"production"'},loader:{'.json':'json'}});
await writeFile(new URL('./dist/index.html',import.meta.url),'<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event Twin — 오프라인 행사의 의사결정 공간</title><link rel="stylesheet" href="/app.css"></head><body><div id="root">Event Twin을 불러오는 중…</div><script type="module" src="/app.js"></script></body></html>');
console.log('Event Twin application built. Start with npm start.');
