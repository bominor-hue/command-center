import { useCallback, useEffect, useRef, useState } from 'react'
import { hubConfigured, loadHub, supabase, watchHub } from './client'
import { sampleState } from './sample'
import type { HubState } from './types'

// The wall's data: live from the hub when it is configured and signed in, else the sample.
// Reloads on every hub change (debounced) and every 2 minutes as a fallback. If the hub stops
// answering, the last good data stays up with a "stale since" banner (PRD, Offline).

export function useHub() {
  const [state, setState] = useState<HubState>(() => sampleState())
  const [signedIn, setSignedIn] = useState(false)
  const [staleSince, setStaleSince] = useState<string | null>(null)
  const timer = useRef<number | undefined>(undefined)

  const reload = useCallback(async () => {
    if (!hubConfigured) { setState(sampleState()); return }
    try {
      const s = await loadHub()
      setState(s); setStaleSince(null)
    } catch (e) {
      setStaleSince((x) => x ?? new Date().toISOString())
      setState((prev) => ({ ...prev, error: (e as Error).message }))
    }
  }, [])

  useEffect(() => {
    if (!supabase) return
    supabase.auth.getSession().then(({ data }) => setSignedIn(!!data.session))
    const { data } = supabase.auth.onAuthStateChange((_e, s) => setSignedIn(!!s))
    return () => data.subscription.unsubscribe()
  }, [])

  useEffect(() => {
    if (hubConfigured && !signedIn) return
    reload()
    const soon = () => { window.clearTimeout(timer.current); timer.current = window.setTimeout(reload, 600) }
    const stop = watchHub(soon)
    const every = window.setInterval(reload, 120_000)
    return () => { stop(); window.clearInterval(every); window.clearTimeout(timer.current) }
  }, [reload, signedIn])

  return { state, reload, signedIn, staleSince, needsSignIn: hubConfigured && !signedIn }
}

/** A clock that ticks every second, for the header and "x min ago" labels. */
export function useNow(ms = 1000) {
  const [now, setNow] = useState(() => new Date())
  useEffect(() => { const t = window.setInterval(() => setNow(new Date()), ms); return () => window.clearInterval(t) }, [ms])
  return now
}

/** A setting kept on this screen (season pick, visitor mode, launch tiles). Survives a reload. */
export function useLocal<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => {
    try { const s = localStorage.getItem('cc.' + key); return s ? (JSON.parse(s) as T) : initial } catch { return initial }
  })
  const set = useCallback((x: T) => { setV(x); try { localStorage.setItem('cc.' + key, JSON.stringify(x)) } catch { /* private window */ } }, [key])
  return [v, set]
}
