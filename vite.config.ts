import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Vite config for the Infinite explorer (React + assimpjs assets)
export default defineConfig({
  plugins: [react()],
  optimizeDeps: {
    include: ['assimpjs'],
    needsInterop: ['assimpjs']
  },
  assetsInclude: ['**/*.wasm', '**/*.3ds', '**/*.blend']
})

