// The Deere sign-in for the hub's Deere collector (collectors/deere.py). One-time, and again only if
// Deere ever revokes it:
//   open  https://<site>/.netlify/functions/deere-auth?key=<HEARTBEAT_KEY>
// It sends you to John Deere to sign in, comes back here, saves the refresh token in cc.deere_token
// (service key only, no login can read it) and lists your Ops Center orgs, with a link for any org
// that has not approved the app yet. The token never shows on screen.
// Deere developer portal: add https://<site>/.netlify/functions/deere-auth as a redirect URI on the app.
// Netlify environment: DEERE_CLIENT_ID, DEERE_CLIENT_SECRET, HEARTBEAT_KEY (and the hub's service key).
import { createHmac, timingSafeEqual } from 'node:crypto'
import { cc, service } from '../lib/hub'

const AUTH = 'https://signin.johndeere.com/oauth2/aus78tnlaysMraFhC1t7/v1'
const API = 'https://partnerapi.deere.com/platform'
const SCOPES = 'openid profile offline_access ag1 ag2 ag3 eq1 org1'

const page = (body: string, status = 200) =>
  new Response(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Deere sign-in</title>
<body style="font:16px system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem">${body}</body>`, { status, headers: { 'Content-Type': 'text/html' } })
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!)
const sign = (ts: string, secret: string) => createHmac('sha256', secret).update(ts).digest('hex')
const same = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))

export default async function deereAuth(req: Request) {
  const { DEERE_CLIENT_ID: id, DEERE_CLIENT_SECRET: secret, HEARTBEAT_KEY: key } = process.env
  if (!id || !secret || !key) return page('<h2>Not set up</h2><p>Netlify needs DEERE_CLIENT_ID, DEERE_CLIENT_SECRET and HEARTBEAT_KEY.</p>', 500)
  const url = new URL(req.url)
  const redirect = `${url.origin}${url.pathname}`
  const q = url.searchParams

  if (!q.has('code') && !q.has('error')) {
    if (!same(q.get('key') ?? '', key)) return page('<h2>Not allowed</h2><p>Open this link with <code>?key=</code> and the heartbeat key.</p>', 403)
    const ts = String(Date.now())
    const to = new URL(`${AUTH}/authorize`)
    to.search = new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, scope: SCOPES, state: `${ts}.${sign(ts, secret)}` }).toString()
    return Response.redirect(to.toString(), 302)
  }

  const [ts = '', mac = ''] = (q.get('state') ?? '').split('.')
  if (!same(mac, sign(ts, secret)) || Date.now() - Number(ts) > 15 * 60000) return page('<h2>Sign-in expired</h2><p>Start again from the link.</p>', 400)
  if (q.has('error')) return page(`<h2>Deere said no</h2><p>${esc(q.get('error_description') ?? q.get('error') ?? '')}</p>`, 400)

  const r = await fetch(`${AUTH}/token`, {
    method: 'POST',
    headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code: q.get('code')!, redirect_uri: redirect, scope: SCOPES }),
  })
  if (!r.ok) return page(`<h2>Deere sign-in failed</h2><p>Token exchange returned ${r.status}. Start again from the link.</p>`, 502)
  const tok = (await r.json()) as { access_token: string; refresh_token?: string }
  if (!tok.refresh_token) return page('<h2>No refresh token</h2><p>Deere did not grant offline access. Check the app\'s scopes in the Deere developer portal.</p>', 502)
  const { error } = await cc(service()).from('deere_token').upsert({ id: 1, refresh_token: tok.refresh_token, updated_at: new Date().toISOString() })
  if (error) return page(`<h2>Could not save the sign-in</h2><p>${esc(error.message)}</p>`, 500)

  // Each org has to approve the app once; Deere gives a 'connections' link for those that have not.
  const orgs = await fetch(`${API}/organizations`, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/vnd.deere.axiom.v3+json' } })
    .then((o) => (o.ok ? o.json() : { values: [] }))
    .then((o: { values?: { id: string; name: string; links?: { rel: string; uri: string }[] }[] }) => o.values ?? [])
  const list = orgs.map((o) => {
    const conn = o.links?.find((l) => l.rel === 'connections')?.uri
    return `<li>${esc(o.name)} (${esc(String(o.id))}): ${conn ? `<b>not approved yet</b>, <a href="${esc(conn)}">approve it</a> (an org admin has to)` : 'connected'}</li>`
  }).join('')
  return page(`<h2>Signed in to John Deere</h2><p>The hub's Deere feed will use this sign-in from its next run (every 2 hours).</p><ul>${list}</ul>`)
}
