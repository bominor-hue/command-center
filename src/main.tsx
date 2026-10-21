import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

// Palette: pine by default; ?theme=graphite|pine|porch|cream picks another and the wall remembers it.
try {
  const asked = new URLSearchParams(location.search).get('theme')
  if (asked) localStorage.setItem('cc-theme', asked)
  const theme = asked ?? localStorage.getItem('cc-theme') ?? import.meta.env.VITE_THEME ?? 'pine'
  if (theme && theme !== 'graphite') document.documentElement.dataset.theme = theme
} catch { /* storage blocked: default palette */ }

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>)
