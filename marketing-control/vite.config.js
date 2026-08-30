import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    // Tailscale Serve proxies as https://cmb-workbench.tailf72e3f.ts.net:5188
    allowedHosts: ['.tailf72e3f.ts.net'],
  },
});
