import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const NIM_IMAGE = 'nvcr.io/nim/nvidia/nemotron-3.5-lightning-30b-a3b:2.0.9-variant';
export const NIM_MODEL = 'nvidia/nemotron-3.5-lightning-30b-a3b';

export function assessNvidiaReadiness({ platform, arch, docker = {}, gpu = {}, installed = {}, env = {} }) {
  const blockers = [];
  if (platform !== 'linux') blockers.push('LINUX_GPU_HOST_REQUIRED');
  if (!docker.reachable) blockers.push('DOCKER_UNAVAILABLE');
  if (docker.remote) blockers.push('RUN_PREFLIGHT_ON_GPU_HOST');
  if (docker.os !== 'linux') blockers.push('LINUX_CONTAINER_ENGINE_REQUIRED');
  if (!(Number.parseInt(docker.version, 10) >= 24)) blockers.push('DOCKER_24_REQUIRED');
  if (!docker.nvidiaRuntime) blockers.push('NVIDIA_CONTAINER_RUNTIME_REQUIRED');
  if (!gpu.available) blockers.push('NVIDIA_GPU_NOT_VERIFIED');
  if (gpu.available && !(Number.parseInt(gpu.driver, 10) >= 580)) blockers.push('DRIVER_580_REQUIRED');
  if (env.NIM_TERMS_ACCEPTED !== 'yes') blockers.push('NIM_TERMS_NOT_ACKNOWLEDGED');
  return {
    host: { platform, arch },
    nat: { installed: Boolean(installed.nat), package: 'nvidia-nat', expectedVersion: '1.9.0',
      inferenceVerified: false, scope: 'read-only-http-workflow' },
    nemoClaw: { installed: Boolean(installed.nemoclaw), openShellInstalled: Boolean(installed.openshell),
      sandboxConnected: false, note: 'Binary presence alone does not prove a sandbox. Apple Silicon is supported with limitations upstream.' },
    credentials: { nvidiaKeyPresent: Boolean(env.NVIDIA_API_KEY), ngcKeyPresent: Boolean(env.NGC_API_KEY) },
    nim: { image: NIM_IMAGE, model: NIM_MODEL, prerequisitesPassed: blockers.length === 0,
      inferenceVerified: false, blockers, endpointConfigured: Boolean(env.NIM_BASE_URL),
      gpuCount: Number(gpu.count) || 0, gpuMemoryMiB: Number(gpu.memoryMiB) || 0,
      note: 'Prerequisites are not a model-fit guarantee. Verify the selected GPU profile, readiness and a real inference separately. NGC key may be optional for this feature-branch model.' },
  };
}

const command = (file, args) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 6000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return null; }
};

export function collectNvidiaReadiness({ env = process.env, platform = process.platform, arch = process.arch, run = command } = {}) {
  const infoText = run('docker', ['info', '--format', '{{json .}}']);
  let info = {};
  try { info = JSON.parse(infoText || '{}'); } catch { /* Never echo daemon details. */ }
  const endpoint = env.DOCKER_HOST || run('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}']) || '';
  const gpuText = run('nvidia-smi', ['--query-gpu=driver_version,memory.total', '--format=csv,noheader,nounits']);
  const gpuRows = (gpuText || '').split('\n').map(row => row.split(',').map(s => s.trim())).filter(row => row.length === 2 && /^\d+\.\d/.test(row[0]) && Number.isFinite(Number(row[1])));
  return assessNvidiaReadiness({ platform, arch, env,
    docker: { reachable: Boolean(info.ServerVersion), os: info.OSType, version: info.ServerVersion,
      nvidiaRuntime: Object.hasOwn(info.Runtimes || {}, 'nvidia'), remote: !endpoint.startsWith('unix://') },
    gpu: { available: gpuRows.length > 0, count: gpuRows.length, driver: String(Math.min(...gpuRows.map(row => Number.parseInt(row[0], 10)))), memoryMiB: gpuRows.reduce((sum, row) => sum + Number(row[1]), 0) },
    installed: { nat: existsSync(fileURLToPath(new URL('./.venv/bin/nat', import.meta.url))),
      nemoclaw: Boolean(run('which', ['nemoclaw'])), openshell: Boolean(run('which', ['openshell'])) },
  });
}
