/// <reference types="vitest/config" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // The build is served as bostadskalkyl.html at the root of the multi-tool
  // Hemma site (alongside the hub + the other 5 calculators), so namespace the
  // hashed assets into /bk-assets/ rather than the generic /assets/ to keep the
  // shared root tidy and collision-free as more tools migrate. Default base '/'
  // keeps asset URLs absolute, so they resolve regardless of the html filename.
  build: { assetsDir: 'bk-assets' },
  server: { port: 5174 },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})
