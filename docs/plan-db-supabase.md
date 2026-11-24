# Plan: move the database from Neon Free to Supabase Free

Status: **approved by the owner on 2026-11-24.** Steps 1 and 2 are done. Step 3 waits for Neon's reset on Dec 1.

## Why

On Nov 19, 2026 the app went down. Neon suspended the database because the month's 100 CU-hours were spent. Every request then failed, and the sign-in card showed only "internal error". PR #73 now names the outage instead.

The real cause is a mismatch between the app and the plan. Solstice samples devices around the clock: the Nest cron runs every 5 minutes, the PVS relay posts all day, and Nest events arrive at any time. Neon's free compute sleeps only after 5 idle minutes, so it never sleeps. I modeled the request logs for Nov 10 and Nov 15. The database was awake 24 hours on both days, about 6 CU-hours a day, or 180 a month. The free allowance is 100. This outage would repeat every month around the 17th.

Supabase's free database runs all the time on shared compute and has no monthly compute-hour limit. That suits an always-on app.

## What Supabase Free gives, and what it costs us

| Limit | Supabase Free | Solstice today |
|---|---|---|
| Compute | Shared, always on, no hour limit | Needs about 180 CU-hours a month on Neon |
| Database size | 500 MB | 316 MB on Neon (measured Nov 24) |
| Transfer out | 5 GB a month | 482 MB from Nov 1 to Nov 24 |
| Inactivity pause | After 7 days of low activity | Never quiet that long |

The size limit is the risk. Past 500 MB, Supabase puts the database into read-only mode. Most tables already have a limit on how long rows are kept: PVS readings 90 days, Nest and pool readings 400 days, alerts 365 days. The energy, state-of-charge and daily tables grow without a limit, at roughly 300 rows a day each. I must measure the real growth before the move.

## Steps

### 1. Prepare the code (before Dec 1, safe to merge while Neon is down)

- Replace Neon's driver in `server/src/db.ts` with a pure-JavaScript Postgres driver. No native modules, per the project rules. `q`, `one` and `kv` keep their signatures, so no other file changes.
- Connect through Supabase's transaction pooler, which suits serverless functions. Turn off prepared statements, which that pooler does not support.
- Keep the PGlite path for tests and the demo server.
- Keep `dbOutage()` from PR #73 working for the new driver's error shapes, and add tests for them.
- Add a maintenance switch, `DB_MAINTENANCE=1`. While it is set, every cron route returns early and writes nothing to any device. The move needs this switch, because a cron run against an empty database must never drive the pool or the thermostat.

### 2. Create the Supabase database

- Add Supabase through the Vercel Marketplace on its free plan, in the same region as the functions (US East).
- Connect it to the `solstice-energy` project. Vercel then sets the connection variables as sensitive env vars.

Done on 2026-11-24: the resource is `solstice-supa` (Supabase Free Plan, `us-east-1`), connected to production and preview with the prefix `SUPA`. The prefix keeps Neon's `DATABASE_URL` and `POSTGRES_URL` in charge until the move. The variables are `SUPA_POSTGRES_URL` (transaction pooler, port 6543) and `SUPA_POSTGRES_URL_NON_POOLING` (port 5432), plus Supabase API keys the app does not use. Neon's `DATABASE_URL` is a sensitive variable, so `vercel env pull` leaves it empty: copy the source URL for step 3 from the Neon console.

TLS: Supabase signs its certificates with its own root CA ("Supabase Root 2021 CA", valid to April 2031, SHA-256 fingerprint `AD:62:1A:B5:…:D4:B5`). `DATABASE_CA` holds that root on Vercel (production and preview, secret), downloaded from the project's database settings on 2026-11-24. `pgConfig` trusts it besides the system roots (PR #76), so Neon's public certificate still verifies until the move. Verified connections to both Supabase ports succeeded; never turn certificate checks off.

### 3. Move the data (Dec 1, after Neon resets)

The Tesla refresh token is single-use, so only one database may own it at any moment. This order keeps one owner:

1. Set `DB_MAINTENANCE=1` on Vercel and redeploy. The crons stop.
2. Measure the size of every Neon table with `scripts/copy-db.ts --sizes`. **Stop here** if the total is above 400 MB, or if growth would pass 500 MB within two years. In that case I come back with the other free option: keep Neon and batch the writes so it can sleep.
3. Copy every table from Neon to Supabase with `scripts/copy-db.ts`. It copies in batches, parents before children, then compares row counts table by table. Step 2 above uses its `--sizes` mode. A local test copied synthetic data between two Postgres servers with identical values, jsonb arrays and sequences included.
4. Point `DATABASE_URL` at the value of `SUPA_POSTGRES_URL` and redeploy. For the copy, use `TARGET_URL` = `SUPA_POSTGRES_URL_NON_POOLING` and `TARGET_CA` = the root certificate.
5. Check the live app as owner and as guest at 393 px. Check that the Tesla, Nest and PVS data refresh.
6. Unset `DB_MAINTENANCE` and redeploy. Watch the first Nest cron, the 8:15 PM pool cron and the nightly sync.

### 4. Guard against the next limit

- Add a nightly check of the database size. At 80% of 500 MB, send a push notification to the owner. *(Built with step 1: `server/src/dbSize.ts`.)*
- Update `CLAUDE.md`: the stack section, the deploy notes and the gotchas.

## Rollback

Neon keeps its copy untouched. To roll back, point `DATABASE_URL` at Neon again and redeploy. That works until about Dec 17, when Neon's free compute would run out again.

## What stays the same

- No screen changes. PR #73 already covers the outage message.
- Both Autopilots stay on Auto. The maintenance switch only pauses the crons during the move.
- No tables are dropped or rewritten. The copy is additive, and Neon stays as it is.

## Decisions for the owner

1. Approve this plan, or change it.
2. Approve adding Supabase through the Vercel Marketplace on its free plan. This creates a new account link, so it needs your yes.
3. Optional: ask Neon for a one-time credit, which their pricing page offers when a Free project hits a limit. If they grant it, the app returns before Dec 1. I can draft the message for you to send.
