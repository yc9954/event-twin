import { readFileSync, statSync } from 'node:fs';

// The deployment name alone is not evidence that the process is sandboxed.
// Observe the OpenShell mount and Linux process restrictions as well.
export function inspectRuntimeLocation({ env = process.env, platform = process.platform, read = readFileSync, stat = statSync } = {}) {
  const name = env.EVENT_TWIN_SANDBOX || '';
  const local = { mode: 'local-direct', connected: false, provider: 'OpenShell', status: 'not-connected', enforcement: 'none' };
  if (platform !== 'linux' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) return local;
  try {
    const status = read('/proc/self/status', 'utf8');
    if (!stat('/run/openshell').isDirectory() || !/^NoNewPrivs:\s+1$/m.test(status) || !/^Seccomp:\s+2$/m.test(status)) return local;
    return { mode: 'nemoclaw-openshell', connected: true, provider: 'OpenShell', status: 'process-confirmed', enforcement: 'linux-process-restrictions', name, verifiedAt: new Date().toISOString() };
  } catch { return local; }
}

export const runtimeLocation = inspectRuntimeLocation();
