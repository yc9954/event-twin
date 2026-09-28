import { collectNvidiaReadiness } from '../integrations/nvidia/readiness.mjs';
const result = collectNvidiaReadiness();
console.log(JSON.stringify(result, null, 2));
if (process.argv.includes('--require-nim') && !result.nim.prerequisitesPassed) process.exitCode = 2;
