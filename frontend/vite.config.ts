import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devAuthProxy = env.VITE_DEV_AUTH_PROXY || ''

  return {
    plugins: [react(), tailwindcss()],
    server: {
      proxy: {
        ...(devAuthProxy
          ? {
              '/api/auth': {
                target: devAuthProxy,
                changeOrigin: true,
                secure: true,
              },
            }
          : {}),
        '/api': 'http://localhost:8080',
      },
    },
  }
})
