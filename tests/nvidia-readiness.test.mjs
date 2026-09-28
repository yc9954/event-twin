import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { assessNvidiaReadiness, collectNvidiaReadiness, NIM_IMAGE } from '../integrations/nvidia/readiness.mjs';

const linux = () => ({ platform: 'linux', arch: 'x64', env: { NIM_TERMS_ACCEPTED: 'yes' },
  docker: { reachable: true, remote: false, version: '29.5.2', os: 'linux', nvidiaRuntime: true },
  gpu: { available: true, driver: '580.126.20', count: 1, memoryMiB: 81920 }, installed: { nat: true } });

test('Mac with Docker is not marked NVIDIA GPU ready', () => {
  const r = assessNvidiaReadiness({ ...linux(), platform: 'darwin', gpu: { available: false } });
  assert.equal(r.nim.prerequisitesPassed, false);
  assert.ok(r.nim.blockers.includes('LINUX_GPU_HOST_REQUIRED'));
  assert.ok(r.nim.blockers.includes('NVIDIA_GPU_NOT_VERIFIED'));
  assert.equal(r.nat.inferenceVerified, false);
});
test('prerequisites never assert actual model inference or OpenShell enforcement', () => {
  const r = assessNvidiaReadiness(linux());
  assert.equal(r.nim.prerequisitesPassed, true);
  assert.equal(r.nim.inferenceVerified, false);
  assert.equal(r.nemoClaw.sandboxConnected, false);
});
test('secret values and endpoint credentials are never included in readiness', () => {
  const data = linux();
  data.env = { ...data.env, NVIDIA_API_KEY: 'nv-secret', NGC_API_KEY: 'ngc-secret', NIM_BASE_URL: 'https://user:password@gpu.example/v1' };
  const r = assessNvidiaReadiness(data), encoded = JSON.stringify(r);
  assert.equal(r.credentials.nvidiaKeyPresent, true);
  for (const secret of ['nv-secret', 'ngc-secret', 'password', 'gpu.example']) assert.equal(encoded.includes(secret), false);
});
test('remote Docker, missing runtime, old driver and unacknowledged terms block start', () => {
  const data = linux();
  data.docker.remote = true; data.docker.nvidiaRuntime = false; data.gpu.driver = '570.1'; data.env = {};
  const r = assessNvidiaReadiness(data);
  assert.deepEqual(r.nim.blockers, ['RUN_PREFLIGHT_ON_GPU_HOST', 'NVIDIA_CONTAINER_RUNTIME_REQUIRED', 'DRIVER_580_REQUIRED', 'NIM_TERMS_NOT_ACKNOWLEDGED']);
});
test('feature-branch NIM does not invent a mandatory NGC key requirement', () => {
  const r = assessNvidiaReadiness(linux());
  assert.equal(r.credentials.ngcKeyPresent, false);
  assert.equal(r.nim.prerequisitesPassed, true);
});
test('unknown version strings fail closed', () => {
  const data = linux(); data.docker.version = ''; data.gpu.driver = 'unknown';
  const r = assessNvidiaReadiness(data);
  assert.ok(r.nim.blockers.includes('DOCKER_24_REQUIRED'));
  assert.ok(r.nim.blockers.includes('DRIVER_580_REQUIRED'));
});
test('collector only invokes readonly commands, never containers or inference', () => {
  const commands = [];
  const run = (file, args) => {
    commands.push([file, ...args]);
    if (file === 'docker' && args[0] === 'info') return JSON.stringify({ ServerVersion: '29.5.2', OSType: 'linux', Runtimes: { nvidia: {} } });
    if (file === 'docker') return 'unix:///var/run/docker.sock';
    if (file === 'nvidia-smi') return '580.126.20, 81920\n580.126.20, 81920';
    return null;
  };
  const r = collectNvidiaReadiness({ platform: 'linux', arch: 'x64', env: { NIM_TERMS_ACCEPTED: 'yes' }, run });
  assert.equal(r.nim.gpuCount, 2);
  assert.equal(r.nim.gpuMemoryMiB, 163840);
  assert.equal(commands.some(c => ['pull', 'run', 'up', 'login'].some(action => c.includes(action))), false);
});
test('compose pins official release, binds loopback, and cannot implicitly pull', () => {
  const text = readFileSync(new URL('../integrations/nvidia/nim.compose.yml', import.meta.url), 'utf8');
  assert.ok(text.includes(`image: ${NIM_IMAGE}`));
  assert.match(text, /pull_policy: never/);
  assert.match(text, /127\.0\.0\.1:8000:8000/);
  assert.match(text, /--enable-auto-tool-choice --tool-call-parser qwen3_coder/);
});
