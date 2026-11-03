import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.anirudhya.app',
  appName: 'VoiceLink',
  webDir: 'dist',
  server: {
    url: 'https://consent-cast-companion.lovable.app/',
    cleartext: false
  }
};

export default config;
