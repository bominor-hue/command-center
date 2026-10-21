import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// `npm run build` makes the wall app in dist/ (Netlify serves it; the office TV opens it in kiosk mode).
export default defineConfig({
  base: './',
  plugins: [react()],
  test: { environment: 'node' },
})
