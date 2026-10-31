# strava-release-notes

Every night at 11 pm Chicago time, a GitHub Actions job fetches the last two
days of my Strava activities and files each one as a note in
[Release Notes](https://notes.yourversionnumber.com), on the day it happened:

```
Ran 5.2 mi in 41:10 (7:55/mi). #strava #run
Rode 22.4 mi in 1:20:05 (16.8 mph), 850 ft up: River loop. #strava #ride
```

There's no server, no database and no dependencies: one Node 24 script
(`strava-to-notes.mjs`), its tests, and a workflow.

## How it works

1. Works out the window in **America/Chicago**: midnight two days ago (local)
   to midnight tonight, so an activity uploaded after last night's run is
   still picked up.
2. Refreshes the Strava access token and lists those activities.
3. Turns each into a line of text (`noteText` in the script; tune the wording
   there). Every note gets `#strava` plus a sport tag (`#run`, `#ride`,
   `#walk`, `#hike`, `#swim`, or the Strava type lowercased).
4. `POST /v1/notes` with the text, `date` (the activity's Chicago date) and
   `written_at` (its start time), and `Idempotency-Key: strava-activity-<id>`.
   A re-run gets the first answer back instead of a second note.
5. Prints a summary, e.g. `3 activities, 1 filed, 2 already there.`, and exits
   non-zero on a real failure so Actions emails me.

Logs show counts, activity ids, dates and tags. Never a token, never a note's
words.

Notes on the edges:

- **Release Notes keeps idempotency receipts for 7 days**, so `--days` is capped
  at 6. Don't re-file anything older by hand.
- **Changing the wording, or renaming an activity in Strava, after it's filed**
  makes Release Notes answer `idempotency_mismatch` for that activity. The job
  counts it as "already there with other words" and leaves the note alone.
- **Two crons.** GitHub cron is UTC only, so the workflow runs at 04:00 and 05:00
  UTC. The script checks which of those was 11 pm in Chicago (judged by the
  scheduled time, so a late start still counts) and the other exits quietly.
- **Strava rotates refresh tokens** and invalidates the old one immediately.
  When that happens the job saves the new one to the `STRAVA_REFRESH_TOKEN`
  secret using `STRAVA_SECRET_WRITER`. If it can't, it still files the notes but
  fails the run, so I get an email to re-run `strava-auth.mjs`.
- **GitHub pauses scheduled workflows** in a repo with no commits for 60 days.
  The last step re-enables the workflow on each scheduled run to prevent that.

## Secrets

Set these under **Settings → Secrets and variables → Actions**, or with `gh`
from inside the repo:

| Secret                  | What it is                                                                                                                                                       |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RELEASE_NOTES_TOKEN`   | A Release Notes token made only for this job, with only **Add notes** (`notes:write`).                                                                           |
| `STRAVA_CLIENT_ID`      | From <https://www.strava.com/settings/api>.                                                                                                                      |
| `STRAVA_CLIENT_SECRET`  | Same page.                                                                                                                                                       |
| `STRAVA_REFRESH_TOKEN`  | Set by `node strava-auth.mjs` (below). Not the one shown on Strava's settings page, which can't list activities.                                                 |
| `STRAVA_SECRET_WRITER`  | A fine-grained GitHub token for **this repo only**, with **Secrets: Read and write** and nothing else. Lets the job save a rotated Strava refresh token. |

```bash
gh secret set RELEASE_NOTES_TOKEN
gh secret set STRAVA_CLIENT_ID
gh secret set STRAVA_CLIENT_SECRET
gh secret set STRAVA_SECRET_WRITER
```

Each prompts for the value, so it never lands in shell history.

### Strava refresh token

1. On the Strava API settings page, set **Authorization Callback Domain** to
   `localhost`.
2. Put `STRAVA_CLIENT_ID` and `STRAVA_CLIENT_SECRET` in `.env` (gitignored; see
   `.env.example`).
3. Run `node strava-auth.mjs`. It opens Strava, asks for `activity:read_all`,
   and stores the refresh token as the `STRAVA_REFRESH_TOKEN` secret without
   printing it. Add `--env` to also save it to `.env` for local runs.

Re-run it if the job ever fails with a Strava token error.

## Running it

By hand on GitHub: **Actions → Strava to Release Notes → Run workflow**. Tick
**dry run** to list what it would file (ids, dates and tags only) without filing
anything. **Days** and **date** pick the window.

```bash
gh workflow run nightly.yml -f dry_run=true
```

Locally, with the values in `.env`:

```bash
node --test                                   # offline tests
node strava-to-notes.mjs --dry-run            # real Strava, files nothing
node strava-to-notes.mjs --dry-run --days 6 --date 2026-10-28
```

### Against the dev server, never production

Release Notes' dev server (`tools/dev-server.ts` in yvn-release-notes) serves
`/v1` for a made-up account and prints a token at start:

```bash
node --import tsx tools/dev-server.ts --fake-places   # in yvn-release-notes, port 8790
```

Then, here, with `RELEASE_NOTES_URL=http://localhost:8790/v1` and that token as
`RELEASE_NOTES_TOKEN` in `.env`:

```bash
node strava-to-notes.mjs --activities-file fake-activities.json --days 2 --date 2026-10-28
```

Run it twice: the first run files 4, the second says `4 already there`.

## Revoking the tokens

- **Release Notes:** revoke the job's token on the Release Notes web, under
  tokens. Any token can also revoke itself through `/v1/token`. Then make a new
  one with only Add notes and `gh secret set RELEASE_NOTES_TOKEN`.
- **Strava:** <https://www.strava.com/settings/apps> → revoke access. Note that
  this revokes every token for that app, including the activities site's weekly
  sync if it shares the app. Then `node strava-auth.mjs` again.
- **GitHub:** delete `STRAVA_SECRET_WRITER` under your GitHub settings →
  Developer settings → Fine-grained tokens.

A run with a revoked or wrong Release Notes token stops at the first note with
a 401 and fails the run.

## License

MIT. See [LICENSE](LICENSE).
