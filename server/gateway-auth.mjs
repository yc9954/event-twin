import { timingSafeEqual } from 'node:crypto';
import { AppError } from './store.mjs';
export function assertGatewayAccess(headers, key) {
  if (!headers['x-event-twin-proxy']) return;
  const supplied = headers['x-event-twin-key'];
  if (headers['x-event-twin-proxy'] !== 'vercel' || typeof key !== 'string' || key.length < 32 ||
      typeof supplied !== 'string' || supplied.length > 256 || Buffer.byteLength(supplied) !== Buffer.byteLength(key) ||
      !timingSafeEqual(Buffer.from(supplied), Buffer.from(key)))
    throw new AppError('인증된 배포 게이트웨이가 필요합니다.', 401, 'GATEWAY_UNAUTHORIZED');
}
