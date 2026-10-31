#!/usr/bin/env node
// node strava-auth.mjs [--env]
// One-time OAuth flow that gets a Strava refresh token with the activity:read_all
// scope and stores it as this repo's STRAVA_REFRESH_TOKEN secret (via `gh`),
// without ever printing it. With --env it's also written to .env for local runs.
//
// Needs STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env, and the Strava app's
// Authorization Callback Domain set to "localhost".

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'

const PORT = 8787
const REDIRECT_URI = `http://localhost:${PORT}/callback`
const SCOPE = 'read,activity:read_all'
const TOKEN_URL = 'https://www.strava.com/oauth/token'

if (existsSync('.env')) process.loadEnvFile('.env')
const { STRAVA_CLIENT_ID: clientId, STRAVA_CLIENT_SECRET: clientSecret } = process.env
if (!clientId || !clientSecret) {
  console.error('Put STRAVA_CLIENT_ID and STRAVA_CLIENT_SECRET in .env (gitignored) first.')
  process.exit(1)
}
const writeEnv = process.argv.includes('--env')

const state = randomBytes(16).toString('hex')
const authorizeUrl =
  'https://www.strava.com/oauth/authorize?' +
  new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    approval_prompt: 'force',
    scope: SCOPE,
    state,
  })

const code = await new Promise((resolve, reject) => {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', REDIRECT_URI)
    if (url.pathname !== '/callback') {
      res.writeHead(404).end()
      return
    }
    const fail = (msg) => {
      res.writeHead(400, { 'Content-Type': 'text/plain' }).end(msg)
      server.close()
      reject(new Error(msg))
    }
    if (url.searchParams.get('state') !== state) return fail('State mismatch; start over.')
    if (url.searchParams.get('error')) return fail(`Strava returned: ${url.searchParams.get('error')}`)
    const granted = (url.searchParams.get('scope') ?? '').split(',')
    if (!granted.includes('activity:read_all')) {
      return fail('activity:read_all was not granted. Run again and leave "View data about your private activities" checked.')
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' }).end('Authorized. You can close this tab.')
    server.close()
    resolve(url.searchParams.get('code'))
  })
  server.listen(PORT, '127.0.0.1', () => {
    console.log(`Opening Strava to authorize. If nothing opens, visit:\n\n  ${authorizeUrl}\n`)
    openBrowser(authorizeUrl)
  })
  server.on('error', reject)
})

const res = await fetch(TOKEN_URL, {
  method: 'POST',
  body: new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code, grant_type: 'authorization_code' }),
})
if (!res.ok) {
  console.error(`Token exchange failed (${res.status}).`)
  process.exit(1)
}
const { refresh_token: refreshToken, athlete } = await res.json()
console.log(`Authorized${athlete?.firstname ? ` as ${athlete.firstname}` : ''}.`)

const gh = spawnSync('gh', ['secret', 'set', 'STRAVA_REFRESH_TOKEN'], {
  input: refreshToken,
  stdio: ['pipe', 'inherit', 'inherit'],
})
if (gh.status !== 0) {
  console.error('Could not set the GitHub secret with `gh` (is it installed, logged in, and run inside this repo?).')
}

if (writeEnv || gh.status !== 0) {
  const lines = existsSync('.env') ? readFileSync('.env', 'utf8').split(/\r?\n/) : []
  const kept = lines.filter((l) => l.trim() && !l.startsWith('STRAVA_REFRESH_TOKEN='))
  writeFileSync('.env', [...kept, `STRAVA_REFRESH_TOKEN=${refreshToken}`, ''].join('\n'))
  console.log('Saved STRAVA_REFRESH_TOKEN to .env.')
}
if (gh.status !== 0) process.exit(1)

function openBrowser(url) {
  const [cmd, args] =
    process.platform === 'win32'
      ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
      : process.platform === 'darwin'
        ? ['open', [url]]
        : ['xdg-open', [url]]
  spawn(cmd, args, { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}
