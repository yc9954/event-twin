import test from 'node:test';
import assert from 'node:assert/strict';
import { passwordHash, checkPassword, issueSession, validSession, cookieToken, cookieHeader } from '../deploy/vercel/auth.mjs';
import { assertGatewayAccess } from '../server/gateway-auth.mjs';
test('private deployment passwords and expiring signed cookies reject tampering',()=>{
  const hash=passwordHash('test-owner-password');assert.ok(checkPassword('test-owner-password',hash));assert.equal(checkPassword('wrong',hash),false);
  const key='a'.repeat(64),now=Date.now(),token=issueSession(key,now);
  assert.ok(validSession(token,key,now));assert.equal(validSession(token,key,now+28800001),false);
  assert.equal(validSession(token+'x',key,now),false);assert.equal(validSession(token,'b'.repeat(64),now),false);
  const cookie=cookieHeader(token);assert.match(cookie,/HttpOnly; Secure; SameSite=Strict/);
  assert.equal(cookieToken(cookie),token);assert.equal(cookieToken(cookie+'; '+cookie),null);
});
test('public ingress always needs a constant-time gateway credential, local traffic stays local',()=>{
  assert.doesNotThrow(()=>assertGatewayAccess({},undefined));
  for(const headers of [{'x-event-twin-proxy':'vercel'},{'x-event-twin-proxy':'vercel','x-event-twin-key':'wrong'},
    {'x-event-twin-proxy':'arbitrary','x-event-twin-key':'a'.repeat(64)}])assert.throws(()=>assertGatewayAccess(headers,'a'.repeat(64)),e=>e.code==='GATEWAY_UNAUTHORIZED');
  assert.doesNotThrow(()=>assertGatewayAccess({'x-event-twin-proxy':'vercel','x-event-twin-key':'a'.repeat(64)},'a'.repeat(64)));
});
