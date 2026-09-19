# firestore-rolling-backup

Drop-in **Cloud Functions** that give any Firebase project automatic, **rolling** Firestore
backups to Cloud Storage — so you can always recover **"≈1 hour ago"** and **"≈1 day ago"**
without setting up a data pipeline, a paid add-on, or the (project-wide, all-or-nothing)
managed export.

- ⏱️ **hourlyBackup** — runs every hour, keeps the last **48** files → `gs://<bucket>/backups/hourly/`
- 📅 **dailyBackup** — runs once a day, keeps the last **30** files → `gs://<bucket>/backups/daily/`
- 🧾 Writes a tiny manifest doc per backup to the `backupsMeta` collection, so an admin page can
  **list what exists** (path, time, byte size, per-collection doc counts) without opening Storage.
- 🔘 **runBackupNow** — a secret-guarded HTTP trigger to take a snapshot on demand (great right
  after a deploy, or before a risky migration).
- ♻️ Old files are **pruned automatically** past the retention count.

Each run dumps **every** Firestore collection into one JSON file:

```json
{ "_at": "2026-01-01T03:00:00.000Z", "_version": 1,
  "collections": { "users": [ { "id": "…", "…": "…" } ], "orders": [ … ] } }
```

## Why not just use the managed export?

Firestore's managed export is project-wide, all-or-nothing, and lands in a format you can't
open by hand. This gives you **plain JSON**, **two independent rolling windows** (hour + day),
a **manifest you can list from your own admin UI**, and an **on-demand button** — in ~150 lines
you own.

> **Note on images / blobs:** files in Cloud Storage (uploads, images) already live durably there.
> This dump captures all Firestore **text + the Storage URLs** — the part that changes moment to
> moment. It does not re-embed binary bytes. **Restore = text from this JSON + assets from Storage.**

## Install

```bash
# in your functions/ directory
npm i firebase-functions firebase-admin
```

Copy `index.js` into your functions source (or `require()` and re-export from it):

```js
// functions/index.js
const backup = require('./firestore-rolling-backup');
exports.hourlyBackup = backup.hourlyBackup;
exports.dailyBackup  = backup.dailyBackup;
exports.runBackupNow = backup.runBackupNow;
```

## Configure (all optional, via env vars)

| Variable | Default | Meaning |
|---|---|---|
| `BACKUP_KEY` | *(unset → runBackupNow is disabled)* | shared secret for the manual HTTP trigger |
| `BACKUP_TZ` | `Etc/UTC` | IANA timezone for schedules + filename labels (e.g. `Asia/Kuala_Lumpur`) |
| `BACKUP_HOURLY_KEEP` | `48` | how many hourly files to keep |
| `BACKUP_DAILY_KEEP` | `30` | how many daily files to keep |
| `BACKUP_DAILY_SCHEDULE` | `0 3 * * *` | cron for the daily run |
| `BACKUP_SKIP_COLLECTIONS` | `backupsMeta` | comma-separated root collections to skip |

Set them in `functions/.env` (Firebase loads it automatically):

```
BACKUP_KEY=change-me-to-a-long-random-string
BACKUP_TZ=Asia/Kuala_Lumpur
```

## Deploy

```bash
firebase deploy --only functions:hourlyBackup,functions:dailyBackup,functions:runBackupNow
```

## Verify / take a snapshot now

```bash
curl "https://<region>-<project>.cloudfunctions.net/runBackupNow?key=<BACKUP_KEY>&kind=hourly"
# → { "ok": true, "kind": "hourly", "path": "backups/hourly/2026-01-01-03.json", "total": 1234, "bytes": 456789 }
```

## Restore

1. Download the JSON you want from `gs://<bucket>/backups/{hourly|daily}/…`.
2. For each key in `collections`, write the documents back (`doc.id` is included on every record).
3. Assets are already in Storage — the JSON holds their URLs.

## Requirements

- Node 18+ (tested on Node 22)
- `firebase-functions` v4+ (2nd-gen), `firebase-admin` v11+
- The Cloud Scheduler + default Storage bucket that Firebase provisions

## License

MIT — see [LICENSE](LICENSE).

Maintained by t
