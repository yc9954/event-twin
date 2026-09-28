import { randomBytes, scryptSync, createHmac, timingSafeEqual } from 'node:crypto';
export const COOKIE = '__Host-event_twin';
const equal = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length < 1024 && b.length < 1024
  && Buffer.byteLength(a) === Buffer.byteLength(b) && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function passwordHash(password, salt=randomBytes(16).toString('hex')) {
  return `${salt}:${scryptSync(password,salt,32).toString('hex')}`;
}
export function checkPassword(password, encoded) {
  if(typeof password!=='string'||password.length>256||!/^([a-f0-9]{32}):([a-f0-9]{64})$/.test(encoded||''))return false;
  return equal(passwordHash(password,encoded.split(':')[0]),encoded);
}
const sign=(body,secret)=>createHmac('sha256',secret).update(body).digest('base64url');
export function issueSession(secret, now=Date.now()) {
  if(typeof secret!=='string'||secret.length<32)throw new Error('Session key missing');
  const body=Buffer.from(JSON.stringify({exp:now+8*60*60*1000,nonce:randomBytes(16).toString('hex')})).toString('base64url');
  return `${body}.${sign(body,secret)}`;
}
export function validSession(token,secret,now=Date.now()) {
  if(typeof secret!=='string'||secret.length<32||typeof token!=='string'||token.length>600)return false;
  const [body,signature,extra]=token.split('.');
  if(extra!==undefined||!body||!equal(sign(body,secret),signature))return false;
  try {const p=JSON.parse(Buffer.from(body,'base64url'));return Number.isFinite(p.exp)&&p.exp>now&&p.exp<=now+8*60*60*1000&&/^[a-f0-9]{32}$/.test(p.nonce);}catch{return false;}
}
export function sessionOwner(token,secret){return validSession(token,secret)?JSON.parse(Buffer.from(token.split('.')[0],'base64url')).nonce:null;}
export function cookieToken(header='') {
  const entries=String(header).split(';').map(v=>v.trim()).filter(v=>v.startsWith(`${COOKIE}=`));
  return entries.length===1?entries[0].slice(COOKIE.length+1):null;
}
export const cookieHeader=token=>`${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${token?28800:0}`;
