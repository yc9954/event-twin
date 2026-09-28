import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createAppServer} from '../server/http.mjs';

test('documented build and default static server deliver HTML, script and CSS',async()=>{
  const root=fileURLToPath(new URL('../',import.meta.url));
  await promisify(execFile)(process.execPath,['build.mjs'],{cwd:root});
  const dataDir=await mkdtemp(join(tmpdir(),'event-twin-static-build-'));
  const app=await createAppServer({dataDir,port:0,scheduler:false});
  try {
    const {port}=await app.listen();
    for(const [path,mime] of [['/','text/html'],['/app.js','text/javascript'],['/app.css','text/css']]) {
      const response=await fetch(`http://127.0.0.1:${port}${path}`);
      assert.equal(response.status,200,path);
      assert.ok(response.headers.get('content-type').startsWith(mime),path);
      assert.ok((await response.text()).length>100,path);
    }
  } finally {await app.close();await rm(dataDir,{recursive:true,force:true});}
});
