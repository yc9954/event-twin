import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectNvidiaReadiness, NIM_IMAGE } from '../integrations/nvidia/readiness.mjs';
const status = collectNvidiaReadiness();
if (!status.nim.prerequisitesPassed) {
  console.error(JSON.stringify({ started: false, blockers: status.nim.blockers }));
  process.exitCode = 2;
} else if (!process.argv.includes('--allow-model-download')) {
  console.error('Not started: first boot may download tens of GB of model weights. After approval, pass --allow-model-download on the configured GPU host.');
  process.exitCode = 2;
} else {
  let present = false;
  try { execFileSync('docker', ['image', 'inspect', NIM_IMAGE], { stdio: 'ignore', timeout: 6000 }); present = true; } catch { /* No implicit pull. */ }
  if (!present) {
    console.error(`Not started: manually review the model terms and pull the pinned image first: ${NIM_IMAGE}`);
    process.exitCode = 2;
  } else {
    const child = spawn('docker', ['compose', '--project-name', 'event-twin-nim', '-f', fileURLToPath(new URL('../integrations/nvidia/nim.compose.yml', import.meta.url)), 'up', '-d', '--pull', 'never'], { stdio: 'inherit' });
    child.on('error', () => { console.error('Docker Compose could not start.'); process.exitCode = 1; });
    child.on('exit', code => { process.exitCode = code ?? 1; });
  }
}
