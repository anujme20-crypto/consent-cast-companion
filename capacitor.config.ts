import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.anirudhya.app',
  appName: 'Google TV',
  webDir: 'dist',
  server: {
    url: 'https://consent-cast-companion.pages.dev/',
    cleartext: false
  }
};

export default config;
