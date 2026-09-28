// Generate deployment artifacts without printing secrets; never overwrite an existing set.
import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { passwordHash } from '../deploy/vercel/auth.mjs';
const directory=fileURLToPath(new URL('../.deployment/',import.meta.url));
await mkdir(directory,{recursive:true,mode:0o700});
let values;
try{values=JSON.parse(await readFile(directory+'vercel-env.json','utf8'));}
catch(error){
  if(error.code!=='ENOENT')throw error;
  const password=randomBytes(24).toString('base64url');
  if(!process.env.EVENT_TWIN_BACKEND_URL)throw new Error('Set EVENT_TWIN_BACKEND_URL to your dedicated HTTPS /event-twin-api/ endpoint first.');
  values={EVENT_TWIN_BACKEND_URL:process.env.EVENT_TWIN_BACKEND_URL,
    EVENT_TWIN_GATEWAY_KEY:randomBytes(32).toString('hex'),EVENT_TWIN_SESSION_SECRET:randomBytes(32).toString('hex'),
    EVENT_TWIN_PASSWORD_HASH:passwordHash(password)};
  await writeFile(directory+'vercel-env.json',JSON.stringify(values),{mode:0o600,flag:'wx'});
  await writeFile(directory+'gateway-key',values.EVENT_TWIN_GATEWAY_KEY,{mode:0o600,flag:'wx'});
  await writeFile(directory+'workspace-login.txt',`Event Twin 전용 로그인 비밀번호\n${password}\n\n이 파일을 공개하거나 저장소에 추가하지 마세요.\n`,{mode:0o600,flag:'wx'});
}
if(process.argv.includes('--sync-vercel'))for(const [name,value]of Object.entries(values)){
  const child=spawn('vercel',['env','add',name,'production','--sensitive','--yes',...(process.env.VERCEL_SCOPE?['--scope',process.env.VERCEL_SCOPE]:[])],{stdio:['pipe','pipe','pipe']});
  let output='';child.stdout.on('data',c=>output+=c);child.stderr.on('data',c=>output+=c);child.stdin.end(value);
  const code=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('exit',resolve);});
  if(code!==0)throw new Error(`Could not configure ${name}; inspect Vercel environment status. Exit ${code}`);
  console.log(`Configured ${name} (value hidden).`);
}
console.log('Deployment credential files are ready; values not printed.');
