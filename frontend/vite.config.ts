import {defineConfig} from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vitejs.dev/config/
export default defineConfig({
    // Relative asset paths — required for file://-loaded desktop shells
    // (Electron AppImage/portable). Absolute /assets breaks there.
    base: './',
  plugins: [react(), tailwindcss()],
  // Tauri dev server protocol/port must match src-tauri/tauri.conf.json
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
  },
})
