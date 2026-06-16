# STRIDE Frontend (React + TypeScript + Vite)

## Environment variables

Frontend env vars live in `frontend/.env.local` (git-ignored). Copy
`frontend/.env.example` as a starting point and fill in values:

| Variable | Required | Notes |
|---|---|---|
| `VITE_AUTH_BASE_URL` | yes | Auth-service FQDN (used by `authStore.ts`) |
| `VITE_AUTH_CLIENT_ID` | yes | Client id in the auth service |
| `VITE_DEV_AUTH_PROXY` | local dev | Optional override for the Vite `/api/auth/*` proxy. When omitted, local dev uses `VITE_AUTH_BASE_URL` as the proxy target to avoid browser CORS on login. |
| `VITE_DEV_API_PROXY` | local dev | Optional API proxy target for `/api/*` during frontend-only local testing. |
| `VITE_APPLICATIONINSIGHTS_CONNECTION_STRING` | no | Application Insights connection string. Telemetry stays disabled when this is empty. The SDK is loaded via dynamic `import()` so the bundle stays small in that case. |

In CI, all three values are repository-level GitHub Actions Variables (not
Secrets — they are public-by-design and need to be inlined into the browser
bundle at build time).

## Local browser smoke

For frontend changes, run a real local login and data-page smoke before
calling the work done:

```bash
npm run dev:frontend:local
```

In another terminal:

```bash
npm run smoke:local
```

`smoke:local` reads the real test credentials from repository-root
`.credentials.local` and does not print the email, password, or tokens. It
verifies login, `/activities`, and one `/activity/:id` detail page. If Vite is
not on `http://127.0.0.1:5173`, set `STRIDE_LOCAL_URL` to the actual local URL.

## Telemetry caveats

Adblockers (uBlock Origin, Brave Shields, etc.) may block requests to the
Application Insights ingestion endpoint. If you don't see `pageViews` rows
appear in Kusto when self-testing in production, allow the
`*.applicationinsights.azure.com` domain on the stride-app host or test
without the adblock extension.

KQL starter pack: `docs/telemetry-kql.md`.

---

## Vite template notes

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Oxc](https://oxc.rs)
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/)

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default defineConfig([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
