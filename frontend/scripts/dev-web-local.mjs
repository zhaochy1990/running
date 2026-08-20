import { spawn } from 'node:child_process'

const vitePort = process.env.VITE_DEV_PORT
if (!vitePort) throw new Error('VITE_DEV_PORT is required')

const child = spawn(
  process.execPath,
  [
    'node_modules/concurrently/dist/bin/concurrently.js',
    '-k',
    '-n',
    'vite,bff',
    `vite --host --port ${vitePort} --strictPort`,
    'cd server && npm run dev',
  ],
  { stdio: 'inherit', env: process.env },
)

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  process.exit(code ?? 1)
})
