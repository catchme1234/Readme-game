// Запуск на своём компьютере: открывает временный HTTPS-туннель (Cloudflare,
// бесплатно, без регистрации) и стартует сервер с этим адресом.
import { spawn } from 'node:child_process';

const PORT = process.env.PORT || 3000;
console.log('Открываю туннель…');
const tunnel = spawn('npx', ['--yes', 'cloudflared', 'tunnel', '--url', `http://localhost:${PORT}`], { shell: process.platform === 'win32' });

let started = false;
const onData = (buf) => {
  const m = String(buf).match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
  if (m && !started) {
    started = true;
    console.log(`Адрес мини-приложения: ${m[0]}`);
    const server = spawn(process.execPath, ['src/server.js'], {
      stdio: 'inherit',
      env: { ...process.env, WEBAPP_URL: m[0], PORT },
    });
    server.on('exit', (c) => { tunnel.kill(); process.exit(c ?? 0); });
  }
};
tunnel.stdout.on('data', onData);
tunnel.stderr.on('data', onData);
tunnel.on('exit', (c) => { if (!started) console.error('Туннель не запустился, код', c); process.exit(1); });
process.on('SIGINT', () => { tunnel.kill(); process.exit(0); });
