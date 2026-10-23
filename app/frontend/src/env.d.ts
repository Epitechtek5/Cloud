/// <reference types="vite/client" />

interface AppConfig {
  /** Public Discord application id (not a secret). */
  discordClientId: string;
}

declare const __APP_CONFIG__: AppConfig;
declare const __BACKEND__: 'mock' | 'gcp';
