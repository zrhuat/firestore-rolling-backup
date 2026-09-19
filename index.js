// firestore-rolling-backup
// Automatic, rolling Firestore backups → Cloud Storage (gs://<bucket>/backups/…).
//
// Two rolling snapshots so you can always recover "≈1 hour ago" and "≈1 day ago":
//   • hourlyBackup — every hour, keeps the last N files   (backups/hourly/…)
//   • dailyBackup  — once a day,  keeps the last N files   (backups/daily/…)
//
// Each run dumps EVERY Firestore collection to one JSON file and writes a small manifest
// document to `backupsMeta` so you can list what exists without opening Storage.
//
// NOTE ON IMAGES / BLOBS: files you store in Cloud Storage (uploads, images) already live
// durably there. This dump captures all Firestore TEXT + the Storage URLs — the part that
// actually changes moment to moment. It does NOT re-embed binary bytes. Restore = text from
// this JSON + assets from Storage.
//
// Config (all optional, via environment variables):
//   BACKUP_KEY               shared secret for the manual HTTP trigger (required to use runBackupNow)
//   BACKUP_TZ                IANA timezone for schedules + file labels     (default: Etc/UTC)
//   BACKUP_HOURLY_KEEP       how many hourly files to keep                 (default: 48)
//   BACKUP_DAILY_KEEP        how many daily files to keep                  (default: 30)
//   BACKUP_DAILY_SCHEDULE    cron for the daily run                        (default: "0 3 * * *")
//   BACKUP_SKIP_COLLECTIONS  comma-separated root collections to skip      (default: "backupsMeta")
//
// License: MIT.

const { onSchedule } = require('firebase-functions/v2/scheduler');
const { onRequest } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');

if (!admin.apps.length) admin.initializeApp();
const db = admin.firestore();

const TZ = process.env.BACKUP_TZ || 'Etc/UTC';
const HOURLY_KEEP = Number(process.env.BACKUP_HOURLY_KEEP) || 48;
const DAILY_KEEP = Number(process.env.BACKUP_DAILY_KEEP) || 30;
const DAILY_SCHEDULE = process.env.BACKUP_DAILY_SCHEDULE || '0 3 * * *';
const SKIP = new Set(
  (process.env.BACKUP_SKIP_COLLECTIONS || 'backupsMeta')
    .split(',').map(s => s.trim()).filter(Boolean)
);

// Timezone-aware timestamp labels (day = YYYY-MM-DD, hour = YYYY-MM-DD-HH) so filenames
// sort chronologically and read in local time.
function stamp() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false,
  }).formatToParts(new Date()).reduce((o, p) => (o[p.type] = p.value, o), {});
  const day = `${parts.year}-${parts.month}-${parts.day}`;
  return { day, hour: `${day}-${parts.hour === '24' ? '00' : parts.hour}` };
}

// Dump every root collection: { _at, _version, collections: { name: [ {id, ...data}, … ] } }
async function dumpAll() {
  const cols = await db.listCollections();
  const out = { _at: new Date().toISOString(), _version: 1, collections: {} };
  for (const c of cols) {
    if (SKIP.has(c.id)) continue; // don't snapshot our own manifest (avoids unbounded growth)
    const snap = await c.get();
    out.collections[c.id] = snap.docs.map(d => Object.assign({ id: d.id }, d.data()));
  }
  return out;
}

// Write one backup file to Storage, record a manifest, prune old files beyond `keep`.
async function writeBackup(folder, name, keep) {
  const bucket = admin.storage().bucket();
  const data = await dumpAll();
  const json = JSON.stringify(data);
  const path = `backups/${folder}/${name}.json`;

  await bucket.file(path).save(json, {
    contentType: 'application/json',
    resumable: false,
    metadata: { cacheControl: 'no-store' },
  });

  const counts = {}; let total = 0;
  for (const k in data.collections) { counts[k] = data.collections[k].length; total += counts[k]; }
  try {
    await db.collection('backupsMeta').doc(folder + '__' + name).set({
      folder, name, path, at: data._at, bytes: json.length, counts, totalDocs: total,
    });
  } catch (e) { console.warn('manifest write failed', e); }

  // Prune: file names sort chronologically (YYYY-MM-DD…), so the oldest are first.
  try {
    const [files] = await bucket.getFiles({ prefix: `backups/${folder}/` });
    const names = files.map(f => f.name).sort();
    if (names.length > keep) {
      for (const n of names.slice(0, names.length - keep)) {
        try { await bucket.file(n).delete(); } catch (e) {}
        const id = folder + '__' + n.split('/').pop().replace(/\.json$/, '');
        try { await db.collection('backupsMeta').doc(id).delete(); } catch (e) {}
      }
    }
  } catch (e) { console.warn('prune failed', e); }

  console.log(`backup ${path}: ${total} docs, ${json.length} bytes`);
  return { path, bytes: json.length, total };
}

exports.hourlyBackup = onSchedule(
  { schedule: 'every 60 minutes', timeZone: TZ, memory: '512MiB', timeoutSeconds: 300, retryCount: 1 },
  async () => { const s = stamp(); await writeBackup('hourly', s.hour, HOURLY_KEEP); }
);

exports.dailyBackup = onSchedule(
  { schedule: DAILY_SCHEDULE, timeZone: TZ, memory: '512MiB', timeoutSeconds: 540, retryCount: 1 },
  async () => { const s = stamp(); await writeBackup('daily', s.day, DAILY_KEEP); }
);

// Manual trigger (handy to verify right after deploy). Guarded by a shared secret in BACKUP_KEY.
// GET /runBackupNow?key=<BACKUP_KEY>&kind=hourly|daily
exports.runBackupNow = onRequest({ memory: '512MiB', timeoutSeconds: 300 }, async (req, res) => {
  const expected = process.env.BACKUP_KEY;
  if (!expected || (req.query.key || '') !== expected) { res.status(403).send('forbidden'); return; }
  try {
    const s = stamp();
    const kind = req.query.kind === 'daily' ? 'daily' : 'hourly';
    const keep = kind === 'daily' ? DAILY_KEEP : HOURLY_KEEP;
    const r = await writeBackup(kind, kind === 'daily' ? s.day : s.hour, keep);
    res.json({ ok: true, kind, ...r });
  } catch (e) { res.status(500).json({ ok: false, error: e.message }); }
});
