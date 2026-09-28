import { setTimeout } from 'node:timers/promises';

// Retry only a model HTTP request, never the surrounding tool transaction.
// Do not replay an exposed stream, an authorization failure, or a rate limit.
export async function withProviderRetry(operation, { signal, exposed = () => false,
  wait = (ms, signal) => setTimeout(ms, undefined, { signal }) } = {}) {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    try { return await operation(); }
    catch (error) {
      if (attempt >= 2 || exposed() || signal?.aborted || ![500, 502, 503, 504].includes(error?.status)) throw error;
      await wait([500, 1500][attempt], signal);
    }
  }
}
