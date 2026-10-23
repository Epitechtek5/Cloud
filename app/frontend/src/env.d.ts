/// <reference types="vite/client" />

interface AppConfig {
  env: string;
  backend: 'mock' | 'gcp';
  discordClientId: string;
  apiBase: string;
  firebase: { apiKey: string; projectId: string; authDomain: string };
}

declare const __APP_CONFIG__: AppConfig;
declare const __BACKEND__: 'mock' | 'gcp';
