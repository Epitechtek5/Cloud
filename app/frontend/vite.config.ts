import { defineConfig } from 'vite';

// Public, non-secret build-time configuration. In CI these come from GitHub
// environment variables (vars.*); the Discord client secret never reaches the front.
const DISCORD_CLIENT_ID = process.env.DISCORD_CLIENT_ID ?? '1562814087900037260';

export default defineConfig(({ mode }) => {
  // `vite` (development) defaults to the in-browser mock; `--mode dev|prd` targets GCP.
  const backend = mode === 'dev' || mode === 'prd' ? 'gcp' : (process.env.BACKEND ?? 'mock');
  const appConfig = {
    env: mode,
    backend,
    discordClientId: DISCORD_CLIENT_ID,
    apiBase: process.env.API_BASE ?? '/api',
    firebase: {
      apiKey: process.env.FIREBASE_API_KEY ?? '',
      projectId: process.env.FIREBASE_PROJECT_ID ?? '',
      authDomain: process.env.FIREBASE_AUTH_DOMAIN ?? '',
    },
  };
  return {
    define: {
      __APP_CONFIG__: JSON.stringify(appConfig),
      // Separate literal so `if (__BACKEND__ === 'mock')` is folded and the mock is tree-shaken from dev/prd bundles.
      __BACKEND__: JSON.stringify(backend),
    },
    build: { target: 'es2022', sourcemap: true },
    test: { environment: 'node' },
  };
});
