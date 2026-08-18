# Google Sheets Sync — Setup

AVSEC REPORTS can mirror every submitted report into a Google Sheet, one tab per report
type (SEC016, SEC014, SEC029, SEC018, SEC033, SEC013, OFFLOAD). This is a **one-way,
read-only mirror** — the Sheet is never a source of truth, and nothing in the app ever
reads it back. It exists purely so a shift lead or manager can browse/filter submissions
in a spreadsheet without opening the app.

## How it works

```
report submitted
      │
      ▼
sheet_sync_queue (Postgres table, one row per report)
      │
      ▼  (pg_cron, every 2 minutes)
sheets-sync Edge Function
      │  claims up to 50 pending rows, fetches the real report data
      ▼
Google Apps Script Web App  ──▶  appends rows into the matching sheet tab
      │
      ▼
sheet_sync_queue row marked "sent" (or "failed", to retry)
```

A single shared secret authenticates both hops: pg_cron → Edge Function, and Edge Function
→ Apps Script. There's no OAuth or service account involved — the Apps Script Web App
itself is the only thing that needs deploying on the Google side.

## One-time setup

1. **Create or open the target Google Sheet.** You don't need to create any tabs — the
   script creates one automatically (with a header row) the first time a report of that
   type arrives.

2. **Extensions → Apps Script.** Delete any starter `Code.gs` content and paste in the
   entire contents of [`google-apps-script/sheets-sync.gs`](../google-apps-script/sheets-sync.gs)
   from this repo.

3. **Set the shared secret.** In the pasted script, change:
   ```js
   const SYNC_SECRET = "REPLACE_WITH_A_LONG_RANDOM_SECRET";
   ```
   to a long random string (e.g. generate one with `openssl rand -hex 32` or any password
   generator). Keep it — you'll paste the exact same string into the app in step 5.

4. **Deploy → New deployment.**
   - Type: **Web app**
   - Execute as: **Me**
   - Who has access: **Anyone** (the shared secret is what actually gates access — Apps
     Script Web Apps can't read custom HTTP headers, so the secret travels in the request
     body instead, which is why the "Anyone" setting is safe here)
   - Click **Deploy**, authorize the script when prompted, and copy the resulting **Web
     app URL** (ends in `/exec`).

5. **In AVSEC REPORTS**, sign in as an Admin and go to **Profile → Google Sheets Sync**
   (`/admin/sheet-sync`):
   - Paste the Web app URL from step 4 into **Apps Script Web App URL**.
   - Paste the exact same secret from step 3 into **Shared Secret**.
   - Tick **Sync enabled** and **Save configuration**.

6. Click **Sync Now** once to confirm it works, then check the target Sheet for new tabs
   and rows. From then on, sync runs automatically every 2 minutes whenever there's
   something pending.

## Operating it

- **Pending / Sent / Failed counts** on `/admin/sheet-sync` show queue health at a glance.
- **Retry Failed** re-queues every failed row (e.g. after fixing a broken Apps Script
  deployment or a wrong URL) without re-submitting or duplicating the underlying reports —
  the retry only touches the sync queue.
- **Sync Now** triggers an immediate run instead of waiting for the next 2-minute tick —
  useful right after initial setup or after a Retry Failed.
- A failed row keeps its `last_error` and attempt count, both visible in the "Recent
  failures" list on the same page.
- Turning off **Sync enabled** doesn't clear the queue — it just pauses delivery. New
  reports keep queuing up (harmlessly) until it's turned back on.

## Rotating the secret

Change `SYNC_SECRET` in the Apps Script, re-deploy (**Deploy → Manage deployments → Edit
→ New version**), then update the **Shared Secret** field on `/admin/sheet-sync` to match
and save. Do both sides together — a mismatch just means sync attempts fail (logged as
`Unauthorized` in "Recent failures") until they're back in sync, nothing is lost.

## Why idempotent, not exactly-once

The Edge Function marks a batch "sent" only after the Apps Script call returns success, but
if the network drops after Apps Script has already written the rows and before that
response arrives, the batch would be retried. The Apps Script checks each row's **Report
No** against column A of the target sheet before appending, so a retried delivery is a
no-op rather than a duplicate row — the same report number is never written twice.
