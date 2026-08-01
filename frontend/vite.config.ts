import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const devAuthProxy = env.VITE_DEV_AUTH_PROXY || env.VITE_AUTH_BASE_URL || ''
  const devApiProxy = env.VITE_DEV_API_PROXY || ''
  // When the BFF fronts Vite (high-fidelity dev, ADR 0017), the page is served
  // from the BFF's origin but HMR must connect straight to Vite. Setting
  // VITE_HMR_CLIENT_PORT points the browser's HMR websocket at Vite directly so
  // the BFF never has to proxy the websocket upgrade.
  const hmrClientPort = env.VITE_HMR_CLIENT_PORT ? Number(env.VITE_HMR_CLIENT_PORT) : undefined

  return {
    plugins: [react(), tailwindcss()],
    server: {
      ...(hmrClientPort ? { hmr: { clientPort: hmrClientPort } } : {}),
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
        '/api': devApiProxy
          ? { target: devApiProxy, changeOrigin: true, secure: true }
          : 'http://localhost:8080',
      },
    },
  }
})
