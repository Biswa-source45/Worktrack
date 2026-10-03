import { spawn } from 'node:child_process';
import { loadEnv } from './env.mjs';

loadEnv('NGROK_DOMAIN');
spawn('ngrok', ['http', `--url=${process.env.NGROK_DOMAIN}`, '8000'], {
  stdio: 'inherit',
  shell: true,
}).on('exit', (code) => process.exit(code ?? 0));
