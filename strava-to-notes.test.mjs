import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  dayWindow,
  duration,
  Fatal,
  fileNote,
  idempotencyKey,
  localDate,
  noteBody,
  noteText,
  scheduledRun,
  startOfDay,
  zonedIso,
} from './strava-to-notes.mjs'

const run = {
  id: 12345678901,
  name: 'Morning Run',
  sport_type: 'Run',
  start_date: '2026-10-28T12:30:00Z',
  distance: 5.2 * 1609.344,
  moving_time: 41 * 60 + 10,
  total_elevation_gain: 10,
}

test('a run becomes distance, time and pace, with lowercase tags', () => {
  assert.equal(noteText(run), 'Ran 5.2 mi in 41:10 (7:55/mi). #strava #run')
})

test('a ride shows speed and climbing, and keeps a name Strava did not make up', () => {
  const ride = {
    ...run,
    name: 'Lake loop',
    sport_type: 'GravelRide',
    distance: 22.4 * 1609.344,
    moving_time: 3600 + 20 * 60 + 5,
    total_elevation_gain: 259,
  }
  assert.equal(noteText(ride), 'Rode 22.4 mi in 1:20:05 (16.8 mph), 850 ft up: Lake loop. #strava #ride')
})

test('an activity with no distance is just its time', () => {
  const lift = { ...run, name: 'Evening Weight Training', sport_type: 'WeightTraining', distance: 0, moving_time: 2700 }
  assert.equal(noteText(lift), 'Weight training for 45:00. #strava #weighttraining')
})

test('duration formats hours only when needed', () => {
  assert.equal(duration(59), '0:59')
  assert.equal(duration(3661), '1:01:01')
})

test('the idempotency key is the same for the same activity and differs between activities', () => {
  assert.equal(idempotencyKey(run.id), idempotencyKey(String(run.id)))
  assert.equal(idempotencyKey(run.id), 'strava-activity-12345678901')
  assert.notEqual(idempotencyKey(1), idempotencyKey(2))
  assert.match(idempotencyKey(run.id), /^[\x21-\x7e]{1,128}$/)
})

test('a day is midnight to midnight Chicago time, 23 or 25 hours across daylight saving', () => {
  // CDT: midnight is 05:00 UTC.
  assert.equal(startOfDay('2026-07-04').toISOString(), '2026-07-04T05:00:00.000Z')
  // CST: midnight is 06:00 UTC.
  assert.equal(startOfDay('2026-12-25').toISOString(), '2026-12-25T06:00:00.000Z')

  const spring = dayWindow('2026-03-08') // clocks go forward at 2 am
  assert.equal(spring.start.toISOString(), '2026-03-08T06:00:00.000Z')
  assert.equal(spring.end - spring.start, 23 * 3600e3)

  const fall = dayWindow('2026-11-01') // clocks go back at 2 am
  assert.equal(fall.start.toISOString(), '2026-11-01T05:00:00.000Z')
  assert.equal(fall.end - fall.start, 25 * 3600e3)

  const twoDays = dayWindow('2026-11-01', 2)
  assert.equal(twoDays.start.toISOString(), '2026-10-31T05:00:00.000Z')
  assert.equal(twoDays.end.toISOString(), '2026-11-02T06:00:00.000Z')
})

test('an evening activity lands on its Chicago date, not its UTC date', () => {
  const late = { ...run, start_date: '2026-10-29T03:30:00Z' } // 10:30 pm CDT on the 28th
  const body = noteBody(late)
  assert.equal(body.date, '2026-10-28')
  assert.equal(body.written_at, '2026-10-28T22:30:00-05:00')
  assert.equal(localDate(new Date('2026-12-01T05:59:59Z')), '2026-11-30')
  assert.equal(zonedIso(new Date('2026-12-01T05:59:59Z')), '2026-11-30T23:59:59-06:00')
})

test('exactly one of the two crons runs, in summer and in winter, even when it starts late', () => {
  // Summer (CDT): 04:00 UTC is 11 pm, 05:00 UTC is midnight.
  assert.deepEqual(scheduledRun('0 4 * * *', new Date('2026-07-05T04:03:00Z')), { run: true, date: '2026-07-04' })
  assert.equal(scheduledRun('0 5 * * *', new Date('2026-07-05T05:03:00Z')).run, false)
  // Winter (CST): 04:00 UTC is 10 pm, 05:00 UTC is 11 pm.
  assert.equal(scheduledRun('0 4 * * *', new Date('2026-12-26T04:03:00Z')).run, false)
  assert.deepEqual(scheduledRun('0 5 * * *', new Date('2026-12-26T05:03:00Z')), { run: true, date: '2026-12-25' })
  // A summer run that GitHub starts 70 minutes late still counts for its day.
  assert.deepEqual(scheduledRun('0 4 * * *', new Date('2026-07-05T05:10:00Z')), { run: true, date: '2026-07-04' })
})

function stubFetch(...responses) {
  const calls = []
  globalThis.fetch = async (url, init) => {
    calls.push(init)
    const r = responses.shift()
    if (r instanceof Error) throw r
    return new Response(r.body ? JSON.stringify(r.body) : null, { status: r.status, headers: r.headers })
  }
  return calls
}
const noWait = { wait: async () => {} }
const err = (code) => ({ error: { code, message: 'Say what to do.' } })

test('fileNote reports filed, already there, and filed earlier with other words', async () => {
  stubFetch({ status: 201, body: {} })
  assert.equal(await fileNote('http://x/v1', 't', {}, 'k', noWait), 'filed')
  stubFetch({ status: 201, body: {}, headers: { 'Idempotent-Replayed': 'true' } })
  assert.equal(await fileNote('http://x/v1', 't', {}, 'k', noWait), 'already')
  stubFetch({ status: 422, body: err('idempotency_mismatch') })
  assert.equal(await fileNote('http://x/v1', 't', {}, 'k', noWait), 'changed')
})

test('fileNote retries 429, 5xx and network errors with the same key, then gives up', async () => {
  const waits = []
  const calls = stubFetch(
    { status: 429, body: err('rate_limited'), headers: { 'Retry-After': '7' } },
    { status: 503, body: err('unavailable') },
    new TypeError('fetch failed'),
    { status: 201, body: {} },
  )
  assert.equal(await fileNote('http://x/v1', 't', {}, 'key-1', { wait: async (ms) => waits.push(ms) }), 'filed')
  assert.equal(waits[0], 7000)
  assert.deepEqual(new Set(calls.map((c) => c.headers['Idempotency-Key'])), new Set(['key-1']))

  stubFetch(...Array(3).fill({ status: 503, body: err('unavailable') }))
  await assert.rejects(fileNote('http://x/v1', 't', {}, 'k', { attempts: 3, ...noWait }), /503 unavailable/)
})

test('fileNote stops at once on a 401 without retrying', async () => {
  const calls = stubFetch({ status: 401, body: err('token_revoked') }, { status: 201, body: {} })
  await assert.rejects(fileNote('http://x/v1', 't', {}, 'k', noWait), (e) => e instanceof Fatal && /token_revoked/.test(e.message))
  assert.equal(calls.length, 1)
})
