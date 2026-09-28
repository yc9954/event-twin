// Invoked by the Brev host's dedicated service through `openshell sandbox exec`.
// The OpenShell gateway holds the real provider key. This SDK key is inert.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runtimeLocation } from '../server/runtime-location.mjs';
import { existsSync, readFileSync } from 'node:fs';

if (!runtimeLocation.connected) throw new Error('An observed OpenShell sandbox process is required.');
const cwd = fileURLToPath(new URL('../', import.meta.url));
const gatewayKeyPath = fileURLToPath(new URL('../.deployment/gateway-key', import.meta.url));
const env = {
  ...process.env,
  PORT: '4188',
  EVENT_TWIN_APP_URL: 'http://127.0.0.1:4188',
  MODEL_PROVIDER: 'nvidia',
  NVIDIA_BASE_URL: 'https://inference.local/v1',
  NVIDIA_MODEL: process.env.EVENT_TWIN_MANAGED_MODEL || 'nvidia/nemotron-3-super-120b-a12b',
  NVIDIA_API_KEY: 'openshell-managed',
  ...(existsSync(gatewayKeyPath) ? { EVENT_TWIN_GATEWAY_KEY: readFileSync(gatewayKeyPath, 'utf8').trim() } : {}),
  // Keep OpenShell's injected CA; the generic OS bundle does not trust its proxy.
  NODE_EXTRA_CA_CERTS: process.env.NODE_EXTRA_CA_CERTS || '/etc/openshell-tls/openshell-ca.pem',
};
delete env.OPENAI_API_KEY;
delete env.NGC_API_KEY;
delete env.NIM_API_KEY;
let stopping = false;
const children = [
  spawn(process.execPath, ['server/http.mjs'], { cwd, env, stdio: 'inherit' }),
  spawn(process.execPath, ['scripts/nvidia-nat.mjs', 'serve'], { cwd, env, stdio: 'inherit' }),
];
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
  setTimeout(() => { for (const child of children) child.kill('SIGKILL'); }, 8000).unref();
}
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => stop(0));
for (const child of children) {
  child.on('error', () => stop(1));
  child.on('exit', code => { if (!stopping) stop(code || 1); });
}
