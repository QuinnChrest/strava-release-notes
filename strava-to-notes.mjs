#!/usr/bin/env node
// Files the day's Strava activities as notes in Release Notes.
//
//   node strava-to-notes.mjs [--dry-run] [--days N] [--date YYYY-MM-DD]
//                            [--activities-file fake.json]
//
// Looks back --days days (default 2, today included) in America/Chicago, fetches
// those activities from Strava, and POSTs each to /v1/notes on its own local date
// with an Idempotency-Key made from the activity id, so re-runs never file twice.
//
// Env: STRAVA_CLIENT_ID, STRAVA_CLIENT_SECRET, STRAVA_REFRESH_TOKEN,
// RELEASE_NOTES_TOKEN, and optionally RELEASE_NOTES_URL (default production /v1).
// In Actions, SCHEDULE is the cron that fired and GH_TOKEN can write repo secrets
// (Strava rotates refresh tokens and invalidates the old one at once).
//
// Logs counts, ids and tags only: never a token, never a note's text.

import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

export const ZONE = 'America/Chicago'
const RUN_HOUR = 23
const MAX_DAYS = 6 // Release Notes keeps idempotency receipts for 7 days.
const STRAVA_API = 'https://www.strava.com/api/v3'
const STRAVA_TOKEN_URL = 'https://www.strava.com/oauth/token'
const DEFAULT_NOTES_URL = 'https://notes.yourversionnumber.com/v1'
const USER_AGENT = 'strava-release-notes/1.0'

// ---------------------------------------------------------------- time zone

const partsFormat = new Intl.DateTimeFormat('en-US', {
  timeZone: ZONE,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
})

function localParts(instant) {
  const p = Object.fromEntries(partsFormat.formatToParts(instant).map((x) => [x.type, x.value]))
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour), time: `${p.hour}:${p.minute}:${p.second}` }
}

/** Minutes east of UTC in Chicago at that instant: -300 in summer, -360 in winter. */
function offsetMinutes(instant) {
  const { date, time } = localParts(instant)
  const asUtc = Date.parse(`${date}T${time}Z`)
  return Math.round((asUtc - Math.floor(instant.getTime() / 1000) * 1000) / 60000)
}

/** The Chicago calendar date of an instant, as YYYY-MM-DD. */
export function localDate(instant) {
  return localParts(instant).date
}

export function localHour(instant) {
  return localParts(instant).hour
}

/** The instant a Chicago day starts. */
export function startOfDay(date) {
  const naive = Date.parse(`${date}T00:00:00Z`)
  let t = naive
  for (let i = 0; i < 2; i++) t = naive - offsetMinutes(new Date(t)) * 60000
  return new Date(t)
}

export function addDays(date, n) {
  const d = new Date(`${date}T12:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

/** Midnight to midnight Chicago time, for `days` days ending on `lastDate`. */
export function dayWindow(lastDate, days = 1) {
  return { start: startOfDay(addDays(lastDate, 1 - days)), end: startOfDay(addDays(lastDate, 1)) }
}

/** An instant as ISO 8601 with Chicago's offset, e.g. 2026-10-28T23:58:40-05:00. */
export function zonedIso(instant) {
  const { date, time } = localParts(instant)
  const off = offsetMinutes(instant)
  const sign = off < 0 ? '-' : '+'
  const abs = Math.abs(off)
  return `${date}T${time}${sign}${String(Math.floor(abs / 60)).padStart(2, '0')}:${String(abs % 60).padStart(2, '0')}`
}

/**
 * Whether a scheduled run should do the work, and for which day. GitHub cron is
 * UTC, so two crons cover 11 pm Central across daylight saving; only the one whose
 * *scheduled* time is 11 pm in Chicago goes ahead. Judging by the scheduled time,
 * not the clock, means a run that starts late still counts.
 */
export function scheduledRun(cron, now) {
  const [minute, hour] = cron.trim().split(/\s+/).map(Number)
  let intended = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute)
  if (intended > now.getTime()) intended -= 86400000
  const at = new Date(intended)
  return { run: localHour(at) === RUN_HOUR, date: localDate(at) }
}

// ---------------------------------------------------------------- note text

const SPORTS = {
  Run: { verb: 'Ran', tag: 'run', rate: 'pace' },
  TrailRun: { verb: 'Ran', tag: 'run', rate: 'pace' },
  VirtualRun: { verb: 'Ran', tag: 'run', rate: 'pace' },
  Walk: { verb: 'Walked', tag: 'walk', rate: 'pace' },
  Hike: { verb: 'Hiked', tag: 'hike', rate: 'pace' },
  Ride: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  GravelRide: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  MountainBikeRide: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  EBikeRide: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  EMountainBikeRide: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  VirtualRide: { verb: 'Rode', tag: 'ride', rate: 'speed' },
  Swim: { verb: 'Swam', tag: 'swim', rate: 'swim' },
}

const METERS_PER_MILE = 1609.344
const METERS_PER_YARD = 0.9144
const FEET_PER_METER = 3.28084
// Strava's own names ("Morning Run", "Evening Weight Training") add nothing.
const DEFAULT_NAME = /^(Morning|Lunch|Afternoon|Evening|Night) [A-Za-z ]+$/

export function duration(seconds) {
  const s = Math.round(seconds)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/** "WeightTraining" → "Weight training" */
function humanize(sportType) {
  const words = sportType.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase()
  return words.charAt(0).toUpperCase() + words.slice(1)
}

export function tagsFor(activity) {
  const sport = SPORTS[activity.sport_type]
  return ['strava', sport ? sport.tag : activity.sport_type.toLowerCase().replace(/[^a-z0-9]/g, '')]
}

/** A Strava summary activity → the note's words. */
export function noteText(activity) {
  const sport = SPORTS[activity.sport_type]
  const time = duration(activity.moving_time)
  let line
  if (sport && activity.distance > 0) {
    const miles = activity.distance / METERS_PER_MILE
    if (sport.rate === 'swim') {
      const yards = activity.distance / METERS_PER_YARD
      line = `${sport.verb} ${Math.round(yards).toLocaleString('en-US')} yd in ${time} (${duration((activity.moving_time / yards) * 100)}/100yd)`
    } else if (sport.rate === 'pace') {
      line = `${sport.verb} ${miles.toFixed(1)} mi in ${time} (${duration(activity.moving_time / miles)}/mi)`
    } else {
      line = `${sport.verb} ${miles.toFixed(1)} mi in ${time} (${(miles / (activity.moving_time / 3600)).toFixed(1)} mph)`
    }
    const feet = Math.round((activity.total_elevation_gain ?? 0) * FEET_PER_METER)
    if (sport.rate !== 'swim' && feet >= 100) line += `, ${feet.toLocaleString('en-US')} ft up`
  } else {
    line = `${sport ? sport.verb : humanize(activity.sport_type)} for ${time}`
  }
  const name = (activity.name ?? '').trim()
  if (name && !DEFAULT_NAME.test(name)) line += `: ${name}`
  return `${line}. ${tagsFor(activity).map((t) => `#${t}`).join(' ')}`
}

/** Deterministic, so a re-run or retry answers the first result instead of filing again. */
export function idempotencyKey(activityId) {
  return `strava-activity-${activityId}`
}

export function noteBody(activity) {
  const start = new Date(activity.start_date)
  return { text: noteText(activity), date: localDate(start), written_at: zonedIso(start) }
}

// ---------------------------------------------------------------- Strava

export class Fatal extends Error {}

async function refreshStravaToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(STRAVA_TOKEN_URL, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
    }),
  })
  if (!res.ok) {
    throw new Fatal(
      `Strava token refresh failed (${res.status}). The refresh token is revoked, rotated away or ` +
        'missing activity:read_all; run `node strava-auth.mjs` to get a new one.',
    )
  }
  return res.json()
}

async function stravaActivities(accessToken, { start, end }) {
  const all = []
  const after = Math.floor(start.getTime() / 1000)
  const before = Math.floor(end.getTime() / 1000)
  for (let page = 1; ; page++) {
    const res = await fetch(
      `${STRAVA_API}/athlete/activities?after=${after}&before=${before}&per_page=100&page=${page}`,
      { headers: { Authorization: `Bearer ${accessToken}` } },
    )
    if (res.status === 401) {
      // Strava says which permission is missing, e.g. "activity:read_permission missing"; it holds no secrets.
      const why = await res
        .json()
        .then((j) => (j.errors ?? []).map((e) => `${e.field} ${e.code}`).join(', '))
        .catch(() => '')
      throw new Fatal(
        `Strava refused the access token (401${why ? `: ${why}` : ''}). The refresh token needs activity:read_all; ` +
          'run `node strava-auth.mjs` (not the token from Strava\'s API settings page).',
      )
    }
    if (res.status === 429) throw new Fatal('Strava rate limit hit (429); the next run will pick these up.')
    if (!res.ok) throw new Error(`Strava activities request failed (${res.status}).`)
    const batch = await res.json()
    all.push(...batch)
    if (batch.length < 100) return all
  }
}

/** Strava invalidates the old refresh token as soon as it issues a new one, so save it. */
function saveRotatedToken(token, fromDotEnv) {
  if (process.env.GITHUB_ACTIONS) {
    if (!process.env.GH_TOKEN) {
      return 'Strava rotated the refresh token and GH_TOKEN is not set, so it was not saved. Run `node strava-auth.mjs`.'
    }
    const gh = spawnSync('gh', ['secret', 'set', 'STRAVA_REFRESH_TOKEN', '--repo', process.env.GITHUB_REPOSITORY], {
      input: token,
      stdio: ['pipe', 'ignore', 'ignore'],
    })
    if (gh.status !== 0) return 'Strava rotated the refresh token and `gh secret set` failed. Run `node strava-auth.mjs`.'
    console.log('Strava rotated the refresh token; saved the new one to the STRAVA_REFRESH_TOKEN secret.')
    return null
  }
  if (fromDotEnv) {
    const kept = readFileSync('.env', 'utf8').split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('STRAVA_REFRESH_TOKEN='))
    writeFileSync('.env', [...kept, `STRAVA_REFRESH_TOKEN=${token}`, ''].join('\n'))
    console.log('Strava rotated the refresh token; saved the new one to .env.')
    return null
  }
  return 'Strava rotated the refresh token and it could not be saved. Run `node strava-auth.mjs`.'
}

// ---------------------------------------------------------------- Release Notes

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** POST one note. Returns 'filed', 'already' (replayed) or 'changed' (filed before with other words). */
export async function fileNote(baseUrl, token, body, key, { attempts = 5, wait = sleep } = {}) {
  for (let attempt = 1; ; attempt++) {
    const backoff = 2000 * 2 ** (attempt - 1)
    let res
    try {
      res = await fetch(`${baseUrl}/notes`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': key,
          'User-Agent': USER_AGENT,
        },
        body: JSON.stringify(body),
      })
    } catch (err) {
      if (attempt >= attempts) throw new Error(`Release Notes unreachable after ${attempts} tries (${err.cause?.code ?? err.name}).`)
      await wait(backoff)
      continue
    }
    if (res.status === 201) return res.headers.get('Idempotent-Replayed') === 'true' ? 'already' : 'filed'

    const error = await res
      .json()
      .then((j) => j.error ?? {})
      .catch(() => ({}))
    const what = `${res.status} ${error.code ?? 'error'}${error.message ? `: ${error.message}` : ''}`
    if (res.status === 401) throw new Fatal(`Release Notes refused the token (${what}). Make a new one and update RELEASE_NOTES_TOKEN.`)
    if (error.code === 'idempotency_mismatch') return 'changed'
    const retryable = res.status === 429 || res.status >= 500 || error.code === 'busy'
    if (!retryable || attempt >= attempts) throw new Error(`Release Notes answered ${what}`)
    const retryAfter = Number(res.headers.get('Retry-After'))
    await wait(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff)
  }
}

// ---------------------------------------------------------------- main

function parseArgs(argv) {
  const args = { dryRun: false, days: 2, date: null, activitiesFile: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--days') args.days = Number(argv[++i])
    else if (a === '--date') args.date = argv[++i]
    else if (a === '--activities-file') args.activitiesFile = argv[++i]
    else throw new Fatal(`Unknown argument ${a}`)
  }
  if (!Number.isInteger(args.days) || args.days < 1 || args.days > MAX_DAYS) {
    throw new Fatal(`--days must be 1 to ${MAX_DAYS}: Release Notes forgets idempotency keys after 7 days.`)
  }
  if (args.date && !/^\d{4}-\d{2}-\d{2}$/.test(args.date)) throw new Fatal('--date must be YYYY-MM-DD.')
  return args
}

function requireEnv(...names) {
  const missing = names.filter((n) => !process.env[n])
  if (missing.length) throw new Fatal(`Missing ${missing.join(', ')}.`)
}

async function main() {
  const fromDotEnv = existsSync('.env')
  if (fromDotEnv) process.loadEnvFile('.env')
  const args = parseArgs(process.argv.slice(2))
  const now = new Date()

  let lastDate = args.date ?? localDate(now)
  if (process.env.SCHEDULE) {
    const s = scheduledRun(process.env.SCHEDULE, now)
    if (!s.run) {
      console.log(`Cron "${process.env.SCHEDULE}" is not 11 pm in ${ZONE} today; the other one does the work.`)
      return 0
    }
    lastDate = s.date
  }
  const window = dayWindow(lastDate, args.days)
  console.log(`Window: ${addDays(lastDate, 1 - args.days)} to ${lastDate} (${ZONE})${args.dryRun ? ', dry run' : ''}.`)

  let warning = null
  let activities
  if (args.activitiesFile) {
    activities = JSON.parse(readFileSync(args.activitiesFile, 'utf8')).filter((a) => {
      const t = new Date(a.start_date)
      return t >= window.start && t < window.end
    })
  } else {
    requireEnv('STRAVA_CLIENT_ID', 'STRAVA_CLIENT_SECRET', 'STRAVA_REFRESH_TOKEN')
    const refreshToken = process.env.STRAVA_REFRESH_TOKEN
    const token = await refreshStravaToken({
      clientId: process.env.STRAVA_CLIENT_ID,
      clientSecret: process.env.STRAVA_CLIENT_SECRET,
      refreshToken,
    })
    if (token.refresh_token && token.refresh_token !== refreshToken) {
      warning = saveRotatedToken(token.refresh_token, fromDotEnv)
      // Say so now: if a later step fails, this is the line that explains the next run's failure.
      if (warning) console.log(process.env.GITHUB_ACTIONS ? `::error::${warning}` : warning)
    }
    activities = await stravaActivities(token.access_token, window)
  }
  activities.sort((a, b) => Date.parse(a.start_date) - Date.parse(b.start_date))

  const counts = { filed: 0, already: 0, changed: 0, failed: 0 }
  if (args.dryRun) {
    for (const a of activities) {
      console.log(`  would file ${a.id} on ${localDate(new Date(a.start_date))}: ${tagsFor(a).map((t) => `#${t}`).join(' ')}`)
    }
    console.log(`${activities.length} activities, dry run: nothing filed.`)
  } else {
    requireEnv('RELEASE_NOTES_TOKEN')
    const baseUrl = (process.env.RELEASE_NOTES_URL || DEFAULT_NOTES_URL).replace(/\/$/, '')
    for (const a of activities) {
      const day = localDate(new Date(a.start_date))
      try {
        const result = await fileNote(baseUrl, process.env.RELEASE_NOTES_TOKEN, noteBody(a), idempotencyKey(a.id))
        counts[result]++
        console.log(`  ${a.id} on ${day}: ${result}`)
      } catch (err) {
        // A bad token stops everything; anything else fails this one activity and the run, not the rest.
        if (err instanceof Fatal) throw err
        counts.failed++
        console.log(`  ${a.id} on ${day}: failed (${err.message})`)
      }
    }
    console.log(
      `${activities.length} activities, ${counts.filed} filed, ${counts.already} already there` +
        (counts.changed ? `, ${counts.changed} already there with other words (left as they were)` : '') +
        (counts.failed ? `, ${counts.failed} failed` : '') +
        '.',
    )
  }

  if (counts.failed) {
    const msg = `${counts.failed} activities could not be filed.`
    console.log(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg)
  }
  return warning || counts.failed ? 1 : 0
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().then(
    (code) => process.exit(code),
    (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      console.error(process.env.GITHUB_ACTIONS ? `::error::${msg}` : msg)
      process.exit(1)
    },
  )
}
