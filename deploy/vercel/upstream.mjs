import { request } from 'node:https';
import { Readable } from 'node:stream';

// A private, explicitly trusted deployment certificate authenticates the
// dedicated HTTPS ingress over Brev's raw TCP forwarding. Never disable TLS.
export function fetchUpstream(url, options, env=process.env){
  if(!env.EVENT_TWIN_BACKEND_CA)return fetch(url,options);
  if(url.protocol!=='https:')throw new Error('HTTPS required');
  return new Promise((resolve,reject)=>{
    const req=request(url,{method:options.method,headers:options.headers,signal:options.signal,
      ca:env.EVENT_TWIN_BACKEND_CA,servername:'event-twin.internal',rejectUnauthorized:true},res=>{
      const headers=new Headers();for(const[k,v]of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
      if(res.statusCode>=300&&res.statusCode<400){res.resume();reject(new Error('Upstream redirects are disabled'));return;}
      const noBody=options.method==='HEAD'||[204,205,304].includes(res.statusCode);
      if(noBody)res.resume();
      resolve(new Response(noBody?null:Readable.toWeb(res),{status:res.statusCode,headers}));
    });
    req.once('error',reject);req.end(options.body);
  });
}
