// Stop only this application's launchers; OpenClaw and other sandbox work are untouched.
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const pids = readdirSync('/proc').filter(value => /^[1-9][0-9]*$/.test(value)).map(Number).filter(pid => {
  try {
    const args = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0');
    return pid !== process.pid && ['scripts/nemoclaw-launch.mjs', `${root}/scripts/nemoclaw-launch.mjs`].includes(args[1]);
  } catch { return false; }
});
for (const pid of pids) { try { process.kill(pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; } }
const alive = pid => { try { return readFileSync(`/proc/${pid}/cmdline`).length > 0; } catch { return false; } };
for (let attempt = 0; attempt < 100 && pids.some(alive); attempt++) await setTimeout(100);
if (pids.some(alive)) throw new Error('Event Twin shutdown did not finish within 10 seconds.');
console.log(`Stopped ${pids.length} Event Twin launcher(s).`);
