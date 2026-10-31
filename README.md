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

## What gets posted

One note per activity, filed on the day it happened (Chicago time) and ordered
by its start time:

```
Ran 5.2 mi in 41:10 (7:55/mi). #strava #run
Rode 22.4 mi in 1:20:05 (16.8 mph), 850 ft up: River loop. #strava #ride
Walked 1.0 mi in 22:23 (21:53/mi). #strava #walk
Weight training for 45:00. #strava #weighttraining
```

- **Distance and moving time.** Pace per mile for runs, walks and hikes, mph
  for rides, yards and pace per 100 yd for swims. Just the time for anything
  without a distance.
- **Climbing** when it's 100 ft or more (not for swims).
- **The activity's name** only if you renamed it. Strava's defaults like
  "Morning Run" are left out.
- **Tags:** always `#strava`, plus the sport (`#run`, `#ride`, `#walk`, `#hike`,
  `#swim`, or the Strava type lowercased, like `#yoga`).

Never sent: the route or GPS points, location, heart rate, power, calories,
device, photos, the Strava description or a link. Private Strava activities are
included; the journal is private too.

## Setup

Setup takes about 15 minutes. The fiddly part is the Strava refresh token
(step 3), because Strava hands out two kinds of token and only one of them
works here.

You need **Node 24** and the **GitHub CLI** (`gh`), signed in with
`gh auth login`. Run every command below from inside this repo's folder: `gh`
works out which repo the secrets belong to from the folder you're in.

### Five secrets, at a glance

| Secret                 | What it is                                                      | Step |
| ---------------------- | --------------------------------------------------------------- | ---- |
| `STRAVA_CLIENT_ID`     | Your Strava API app's id                                        | 1    |
| `STRAVA_CLIENT_SECRET` | Your Strava API app's secret                                    | 1    |
| `STRAVA_REFRESH_TOKEN` | Lets the job read your activities. Made by `strava-auth.mjs`.   | 3    |
| `RELEASE_NOTES_TOKEN`  | Lets the job add notes, and nothing else                        | 4    |
| `STRAVA_SECRET_WRITER` | Lets the job save a new Strava token when Strava swaps it       | 5    |

### 1. Strava API app

1. Open <https://www.strava.com/settings/api>. If you have no app yet, create
   one; any name and website will do. Strava allows one app per account, so if
   you already have one for another project, use that.
2. Set **Authorization Callback Domain** to `localhost`. Without it, step 3
   fails with a redirect error.
3. Save the id and secret as repo secrets. Each command prompts for the value,
   so it never lands in your shell history:

   ```bash
   gh secret set STRAVA_CLIENT_ID
   ```

   ```bash
   gh secret set STRAVA_CLIENT_SECRET
   ```

> **Don't use the "Refresh Token" shown on that Strava page.** It can read your
> profile but not your activities, so every run fails with
> `401: activity:read_permission missing`. Step 3 gets the right one.

### 2. Local `.env`

Copy `.env.example` to `.env` (it's gitignored) and fill in `STRAVA_CLIENT_ID`
and `STRAVA_CLIENT_SECRET`. Leave the rest empty for now. `strava-auth.mjs`
reads the id and secret from here.

### 3. Strava refresh token

```bash
node strava-auth.mjs --env
```

What happens:

1. Your browser opens a Strava page asking to let your app see your
   activities. **Leave "View data about your private activities" ticked** and
   click **Authorize**.
2. The tab says "Authorized. You can close this tab." and the terminal says
   `Authorized as <your name>.`
3. The script saves the new refresh token as the `STRAVA_REFRESH_TOKEN` repo
   secret and, because of `--env`, in your `.env` too.

**You never see the token, and there's nothing to copy.** The script puts it
where it needs to go and never prints it. If the browser doesn't open, the
terminal shows the link to open yourself. If it says it couldn't set the
GitHub secret, check that `gh` is signed in and you're in this repo's folder.

Running it again later is always safe: it replaces the token in both places.
Do it whenever a run fails with a Strava token error.

> If the same Strava app also powers another project, keep that project's
> refresh token separate: don't copy it here, or this one there. Strava stops an
> old refresh token working the moment it issues a new one, so two jobs sharing
> one token break each other.

### 4. Release Notes token

In Release Notes, open **Settings → API tokens** and make a token just for this
job:

- **Name:** `Strava`. Notes show "via Strava".
- **Permissions:** only **Add notes**. Nothing else.

Copy it (it's shown once) and save it:

```bash
gh secret set RELEASE_NOTES_TOKEN
```

### 5. GitHub token for saving a new Strava token

Strava sometimes swaps the refresh token for a new one and stops the old one
working at once. This token lets the job save the new one back to
`STRAVA_REFRESH_TOKEN`. Without it, the first swap fails the run and you redo
step 3.

1. Open <https://github.com/settings/personal-access-tokens/new> (GitHub →
   Settings → Developer settings → Personal access tokens → **Fine-grained
   tokens** → Generate new token).
2. **Name:** `strava-release-notes secret writer`. **Expiration:** as long as
   you're comfortable with; put a reminder on your calendar.
3. **Repository access:** **Only select repositories**, then this repo.
4. **Permissions → Repository permissions → Secrets:** **Read and write**.
   Leave everything else at No access. GitHub adds Metadata: Read-only on its
   own.
5. Generate it, copy it, and save it:

   ```bash
   gh secret set STRAVA_SECRET_WRITER
   ```

It can create or overwrite this repo's secrets and nothing else. It can't read
a secret's value, push code or see your other repos.

### 6. Check it

Locally, against your real Strava account. This lists what it would file and
files nothing:

```bash
node strava-to-notes.mjs --dry-run --days 6
```

Then the same on GitHub, which checks the secrets:

```bash
gh workflow run nightly.yml -f dry_run=true -f days=6
```

Open the run under **Actions**. The "File the day's activities" step should end
with something like:

```
Window: 2026-10-25 to 2026-10-30 (America/Chicago), dry run.
  would file 20758735604 on 2026-10-27: #strava #walk
  would file 20796942735 on 2026-10-30: #strava #walk
2 activities, dry run: nothing filed.
```

Check those match your Strava feed. From then on the job runs every night at
11 pm Chicago time on its own.

### Troubleshooting

| What you see | Why, and the fix |
| --- | --- |
| `401: activity:read_permission missing` | The refresh token is the read-only one from Strava's settings page. Do step 3. |
| Works on GitHub but fails locally, or the other way round | Local runs use `.env` and GitHub uses the repo secrets, so they can hold different tokens. `node strava-auth.mjs --env` updates both. |
| `Strava token refresh failed` | The refresh token was revoked or replaced, or the client id and secret belong to another app. Check step 1, then do step 3. |
| `Strava rotated the refresh token and ... was not saved` | `STRAVA_SECRET_WRITER` is missing or expired. The notes were still filed. Do step 5, then step 3. |
| `Release Notes refused the token (401 ...)` | `RELEASE_NOTES_TOKEN` is wrong or revoked. Make a new one (step 4). |
| A redirect or callback error on Strava in step 3 | Authorization Callback Domain isn't `localhost` (step 1). |
| `Could not set the GitHub secret with gh` | Run `gh auth login`, and run the command from inside this repo's folder. The token went to `.env` instead; do step 3 again. |
| A scheduled run says `is not 11 pm in America/Chicago` | Normal. Two schedules cover daylight saving, and only one does the work each night. |

## Running it

By hand on GitHub: **Actions → Strava to Release Notes → Run workflow**. Tick
**dry run** to list what it would file (ids, dates and tags only) without filing
anything. **Days** and **date** pick the window.

```bash
gh workflow run nightly.yml -f dry_run=true
```

Locally, with the values in `.env`. Without `--dry-run` it files to
`RELEASE_NOTES_URL`, or to your real Release Notes when that's empty:

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
