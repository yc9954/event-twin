import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = fileURLToPath(new URL('../integrations/nvidia/', import.meta.url));
const binary = fileURLToPath(new URL('../integrations/nvidia/.venv/bin/nat', import.meta.url));
const action = process.argv[2] || 'check';
const env = { ...process.env, NAT_TELEMETRY_ENABLED: 'false', DO_NOT_TRACK: '1' };
// This workflow has no model; do not give its process model/provider credentials.
for (const key of ['OPENAI_API_KEY', 'NVIDIA_API_KEY', 'NGC_API_KEY', 'NIM_API_KEY', 'ANTHROPIC_API_KEY', 'EVENT_TWIN_GATEWAY_KEY']) delete env[key];
let file = binary, args;
if (action === 'setup') { file = 'uv'; args = ['sync', '--frozen', '--no-dev']; }
else {
  if (!existsSync(binary)) throw new Error('Run node scripts/nvidia-nat.mjs setup first.');
  if (action === 'check') args = ['--version'];
  else if (action === 'run') args = ['run', '--config_file', 'workflow.yml', '--input', process.argv[3] || 'health'];
  else if (action === 'serve') args = ['serve', '--config_file', 'workflow.yml', '--host', '127.0.0.1', '--port', '8008'];
  else throw new Error('Usage: nvidia-nat.mjs setup | check | run [health|JSON] | serve');
}
const child = spawn(file, args, { cwd: directory, env, stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal));
child.on('error', () => { console.error('NAT command could not start. Verify the project virtual environment.'); process.exitCode = 1; });
child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
