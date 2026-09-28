import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:https';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fetchUpstream } from '../deploy/vercel/upstream.mjs';
test('dedicated HTTPS verifies its explicit CA and hostname; foreign certificates and redirects fail closed',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'event-twin-tls-'));
  const generate=name=>execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-days','1','-subj',`/CN=${name}`,'-addext',`subjectAltName=DNS:${name}`,'-keyout',join(dir,name+'.key'),'-out',join(dir,name+'.crt')],{stdio:'ignore'});
  generate('event-twin.internal');generate('wrong.internal');
  const ca=await readFile(join(dir,'event-twin.internal.crt'),'utf8');
  const server=createServer({key:await readFile(join(dir,'event-twin.internal.key')),cert:ca},(req,res)=>{
    if(req.url==='/redirect'){res.writeHead(302,{location:'https://example.invalid'});return res.end();}
    res.setHeader('Content-Type','application/x-ndjson');res.end('{"ok":true}\n');
  });server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{await new Promise(r=>server.close(r));await rm(dir,{recursive:true,force:true});});
  const base=`https://127.0.0.1:${server.address().port}`;
  const options={method:'GET',signal:AbortSignal.timeout(5000)};
  const r=await fetchUpstream(new URL(base),options,{EVENT_TWIN_BACKEND_CA:ca});assert.equal(r.status,200);assert.match(await r.text(),/true/);
  await assert.rejects(()=>fetchUpstream(new URL(base),options,{EVENT_TWIN_BACKEND_CA:'not a trusted certificate'}));
  await assert.rejects(()=>fetchUpstream(new URL(base+'/redirect'),options,{EVENT_TWIN_BACKEND_CA:ca}),/redirect/);
  const wrongServer=createServer({key:await readFile(join(dir,'wrong.internal.key')),cert:await readFile(join(dir,'wrong.internal.crt'))},()=>{});
  wrongServer.listen(0,'127.0.0.1');await once(wrongServer,'listening');t.after(()=>new Promise(r=>wrongServer.close(r)));
  await assert.rejects(()=>fetchUpstream(new URL(`https://127.0.0.1:${wrongServer.address().port}`),options,{EVENT_TWIN_BACKEND_CA:ca}));
  const foreignCa=await readFile(join(dir,'wrong.internal.crt'),'utf8');
  await assert.rejects(()=>fetchUpstream(new URL(`https://127.0.0.1:${wrongServer.address().port}`),options,{EVENT_TWIN_BACKEND_CA:foreignCa}),{code:'ERR_TLS_CERT_ALTNAME_INVALID'});
});
