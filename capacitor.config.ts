import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.anirudhya.app',
  appName: 'anirudhya',
  webDir: 'dist',
  server: {
    url: 'https://consent-cast-companion.pages.dev/',
    cleartext: false
  }
};

export default config;
