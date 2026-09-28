import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { checkPassword, issueSession, validSession, cookieToken, cookieHeader, sessionOwner } from '../deploy/vercel/auth.mjs';
import { fetchUpstream } from '../deploy/vercel/upstream.mjs';
export const config={api:{bodyParser:false},maxDuration:240};
const MAX_BODY=4*1024*1024;
const loginAttempts=new Map();
const json=(res,status,value)=>{res.statusCode=status;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify(value));};
const redirect=(res,path)=>{res.statusCode=303;res.setHeader('Location',path);res.end();};
async function body(req,limit=MAX_BODY) {
  const parsed=req.body;
  if(parsed!==undefined&&parsed!==null){
    const bytes=Buffer.isBuffer(parsed)?parsed:Buffer.from(typeof parsed==='string'?parsed:
      /^application\/x-www-form-urlencoded/i.test(req.headers['content-type']||'')?new URLSearchParams(parsed).toString():JSON.stringify(parsed));
    if(bytes.length>limit)throw Object.assign(new Error('body limit'),{status:413});return bytes;
  }
  let size=0;const chunks=[];
  for await(const chunk of req){const b=Buffer.from(chunk);size+=b.length;if(size>limit)throw Object.assign(new Error('body limit'),{status:413});chunks.push(b);}
  return Buffer.concat(chunks);
}
function sameOrigin(req) {
  const origin=req.headers.origin,host=req.headers.host;
  return typeof host==='string'&&(!origin||origin===`https://${host}`)&&req.headers['sec-fetch-site']!=='cross-site';
}
function loginPage(error) {
  return `<!doctype html><html lang="ko"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Event Twin · 로그인</title><style>body{margin:0;background:#f4f5f6;color:#26313d;font:16px system-ui}header{background:#76b900;height:10px}main{max-width:390px;margin:12vh auto;padding:36px;background:white;border:1px solid #dce1e6;border-radius:8px}small{color:#647182}h1{font-size:28px}label{display:block;margin:28px 0 10px}input,button{box-sizing:border-box;width:100%;padding:14px;font:inherit;border:1px solid #cbd2da;border-radius:4px}button{background:#76b900;color:#17210b;font-weight:700;border:0;margin-top:18px;cursor:pointer}p{line-height:1.6}.error{color:#aa3131}@media(max-width:480px){main{margin:10vh 16px;padding:24px}}</style><header></header><main><small>EVENT TWIN · PRIVATE WORKSPACE</small><h1>비즈니스의 다음 결정을<br>함께 설계하세요.</h1><p>NemoClaw 에이전트와 연결된<br>오너 전용 워크스페이스입니다.</p>${error?'<p class="error" role="alert">비밀번호가 올바르지 않거나 잠시 후 재시도가 필요합니다.</p>':''}<form method="post" action="/api/auth/login"><label for="password">워크스페이스 비밀번호</label><input id="password" name="password" type="password" required maxlength="256" autocomplete="current-password" autofocus><button>워크스페이스 열기</button></form></main></html>`;
}
export function createProxyHandler({env=process.env,fetchImpl=(url,options)=>fetchUpstream(url,options,env)}={}) {return async function handler(req,res) {
  const publicDemo=env.EVENT_TWIN_PUBLIC_DEMO==='true';
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  res.setHeader('Referrer-Policy','no-referrer');res.setHeader('X-Frame-Options','DENY');
  res.setHeader('Content-Security-Policy',"default-src 'self'; style-src 'self' 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'");
  const url=new URL(req.url,'https://event-twin.invalid');
  const route=req.query?.__route??url.searchParams.get('__route')??url.pathname.replace(/^\/api\/?/,'');
  if(typeof route!=='string'||route.length>220||!/^[-a-zA-Z0-9_/]+$/.test(route))return json(res,400,{error:'잘못된 요청 경로입니다.',code:'INVALID_PATH'});
  if(!env.EVENT_TWIN_SESSION_SECRET||(!publicDemo&&!env.EVENT_TWIN_PASSWORD_HASH)||!env.EVENT_TWIN_GATEWAY_KEY||!env.EVENT_TWIN_BACKEND_URL)
    return json(res,503,{error:'배포 연결 설정이 완료되지 않았습니다.',code:'DEPLOYMENT_NOT_CONFIGURED'});
  if(!sameOrigin(req))return json(res,403,{error:'허용되지 않은 요청 출처입니다.',code:'ORIGIN_REJECTED'});
  if(publicDemo&&route.startsWith('auth'))return redirect(res,'/');
  if(route==='auth'&&req.method==='GET') {res.setHeader('Content-Type','text/html; charset=utf-8');return res.end(loginPage(url.searchParams.has('error')));}
  try {
    if(route==='auth/login'&&req.method==='POST') {
      if(!/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type']||''))return json(res,415,{error:'폼 요청이 필요합니다.'});
      const key=String(req.headers['x-vercel-forwarded-for']||req.headers['x-forwarded-for']||req.socket?.remoteAddress||'unknown').slice(0,120);
      const now=Date.now();for(const [ip,x]of loginAttempts)if(x.until<now)loginAttempts.delete(ip);
      if(loginAttempts.size>10000)return json(res,429,{error:'잠시 후 다시 로그인해주세요.'});
      const bucket=loginAttempts.get(key)||{n:0,until:now+60_000};bucket.n++;loginAttempts.set(key,bucket);
      if(bucket.n>8)return redirect(res,'/api/auth?error=1');
      const form=new URLSearchParams((await body(req,2048)).toString());
      if(!checkPassword(form.get('password'),env.EVENT_TWIN_PASSWORD_HASH))return redirect(res,'/api/auth?error=1');
      res.setHeader('Set-Cookie',cookieHeader(issueSession(env.EVENT_TWIN_SESSION_SECRET)));return redirect(res,'/');
    }
    if(route==='auth/logout'&&req.method==='POST') {res.setHeader('Set-Cookie',cookieHeader(''));return redirect(res,'/api/auth');}
    let token=cookieToken(req.headers.cookie);
    if(publicDemo&&!validSession(token,env.EVENT_TWIN_SESSION_SECRET)){
      if(route!=='demo-session'||req.method!=='GET')return json(res,409,{error:'데모 세션을 시작해주세요.',code:'DEMO_SESSION_REQUIRED'});
      token=issueSession(env.EVENT_TWIN_SESSION_SECRET);res.setHeader('Set-Cookie',cookieHeader(token));
    }
    if(!validSession(token,env.EVENT_TWIN_SESSION_SECRET))return json(res,401,{error:'워크스페이스 로그인이 필요합니다.',code:'AUTH_REQUIRED'});
    if(publicDemo&&route==='demo-session'&&req.method==='GET')return json(res,200,{ok:true,mode:'public-demo'});
    if(!['GET','HEAD','POST'].includes(req.method)||!(/^(health|integrations\/(check|nat-check)|projects(?:\/[-A-Za-z0-9_]+)*(?:\/[0-9]+)?|map\/tile\/\d+\/\d+\/\d+)$/.test(route)))
      return json(res,404,{error:'지원하지 않는 API입니다.',code:'NOT_FOUND'});
    const base=new URL(env.EVENT_TWIN_BACKEND_URL);
    if(base.protocol!=='https:'||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/event-twin-api/'))throw new Error('Invalid upstream');
    url.searchParams.delete('__route');
    const target=new URL(route,base);target.search=url.searchParams.toString();
    const headers={'x-event-twin-key':env.EVENT_TWIN_GATEWAY_KEY,'accept':req.headers.accept||'application/json','user-agent':'EventTwin/0.1 (+https://event-twin-nemoclaw.vercel.app)'};
    if(publicDemo){headers['x-event-twin-demo']='1';headers['x-event-twin-owner']=sessionOwner(token,env.EVENT_TWIN_SESSION_SECRET);}
    if(req.headers['content-type'])headers['content-type']=req.headers['content-type'];
    const payload=req.method==='POST'?await body(req):undefined;
    const upstream=await fetchImpl(target,{method:req.method,headers,body:payload,redirect:'error',signal:AbortSignal.timeout(210000)});
    // Infrastructure login/error pages must never masquerade as application data.
    if(/text\/html/i.test(upstream.headers.get('content-type')||'')){
      const page=await upstream.text();
      throw Object.assign(new Error('Upstream authentication or infrastructure page'),{code:'UPSTREAM_HTML',upstreamStatus:upstream.status,upstreamHost:base.hostname,edge: /pomerium/i.test(page)?'pomerium':/cloudflare/i.test(page)?'cloudflare':'other',edgeTitle:page.match(/<title[^>]*>([^<]{0,100})<\/title>/i)?.[1]});
    }
    res.statusCode=upstream.status;
    res.setHeader('Content-Type',upstream.headers.get('content-type')||'application/octet-stream');
    if(upstream.headers.has('content-disposition'))res.setHeader('Content-Disposition',upstream.headers.get('content-disposition'));
    if(route==='health'&&upstream.ok){const value=await upstream.json();value.access={authenticated:!publicDemo,mode:publicDemo?'public-demo':'private-vercel',uploadImageMaxBytes:2621440};return json(res,200,value);}
    if(req.method==='HEAD'||!upstream.body)return res.end();
    await pipeline(Readable.fromWeb(upstream.body),res);
  }catch(error){console.error('Event Twin proxy failure',{name:error.name,code:error.code||error.cause?.code,upstreamStatus:error.upstreamStatus,upstreamHost:error.upstreamHost,edge:error.edge,edgeTitle:error.edgeTitle});if(res.headersSent)return res.destroy();return json(res,error.status===413?413:502,{error:error.status===413?'사진은 2.5MB 이하로 업로드해주세요.':'NemoClaw 서버 연결이 일시적으로 끊겼습니다. 상태를 새로고침해주세요.',code:error.status===413?'UPLOAD_TOO_LARGE':'BACKEND_UNAVAILABLE'});}
};}
export default createProxyHandler();
