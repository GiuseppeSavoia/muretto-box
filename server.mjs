// Server locale del muretto box: serve l'interfaccia e fa da proxy verso OpenF1
// con coda anti rate-limit e cache su disco delle sessioni concluse.
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { RECORDINGS_DIR, listRecordings, readRecording } from './livetiming.mjs';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT) || 8420;
const API = 'https://api.openf1.org/v1';
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC = path.join(ROOT, 'public');
const CACHE = path.join(ROOT, 'data');

const BUNDLE = ['drivers', 'stints', 'pit', 'weather', 'race_control', 'team_radio', 'position', 'intervals', 'laps'];
const MIN_GAP_MS = 450;
const SETTLE_MS = 3 * 3600e3; // i dati si considerano definitivi 3 ore dopo la fine sessione
const SESSIONS_TTL_MS = 10 * 60e3;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Tutte le richieste a OpenF1 passano in fila indiana, distanziate.
let queue = Promise.resolve();
function upstream(pathAndQuery) {
  const job = queue.then(async () => {
    await sleep(MIN_GAP_MS);
    return fetchWithRetry(pathAndQuery);
  });
  queue = job.catch(() => {});
  return job;
}

async function fetchWithRetry(pathAndQuery) {
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(`${API}/${pathAndQuery}`, { signal: AbortSignal.timeout(90_000) });
    if (res.status === 429 || res.status >= 500) {
      await sleep(1500 * 2 ** attempt);
      continue;
    }
    // OpenF1 risponde 404 quando un feed non ha (ancora) righe.
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`OpenF1 ha risposto ${res.status} per ${pathAndQuery}`);
    return res.json();
  }
  throw new Error(`OpenF1 non disponibile dopo vari tentativi: ${pathAndQuery}`);
}

let sessionsMemo = { at: 0, list: [] };
async function raceSessions() {
  if (sessionsMemo.list.length && Date.now() - sessionsMemo.at < SESSIONS_TTL_MS) return sessionsMemo.list;
  const year = new Date().getUTCFullYear();
  const all = [];
  for (const y of [year, year - 1]) all.push(...(await upstream(`sessions?year=${y}&session_type=Race`)));
  const list = all
    .filter((s) => Date.parse(s.date_start) < Date.now() && !s.is_cancelled)
    .sort((a, b) => Date.parse(b.date_start) - Date.parse(a.date_start));
  sessionsMemo = { at: Date.now(), list };
  return list;
}

const isSettled = (session) => Date.now() > Date.parse(session.date_end) + SETTLE_MS;

async function cached(session, name, produce) {
  const file = path.join(CACHE, String(session.session_key), `${name}.json`);
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch {
    // assente: si scarica
  }
  const data = await produce();
  const hasRows = Array.isArray(data) ? data.length > 0 : data.t?.length > 0;
  if (isSettled(session) && hasRows) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(data));
  }
  return data;
}

async function findSession(key) {
  const session = (await raceSessions()).find((s) => s.session_key === key);
  if (!session) throw httpError(404, 'Sessione non trovata');
  return session;
}

async function bundle(key) {
  const session = await findSession(key);
  const out = { session };
  for (const name of BUNDLE) {
    out[name] = await cached(session, name, () => upstream(`${name}?session_key=${key}`));
  }
  return out;
}

// La telemetria grezza pesa ~6 MB per pilota: si taglia alla finestra di gara e
// si riduce a colonne. I valori > 100 di freno/acceleratore indicano dato assente.
async function carData(key, driver) {
  const session = await findSession(key);
  return cached(session, `car_${driver}`, async () => {
    const rows = await upstream(`car_data?session_key=${key}&driver_number=${driver}`);
    const from = Date.parse(session.date_start);
    const to = Date.parse(session.date_end);
    const out = { t: [], speed: [], throttle: [], brake: [], gear: [], rpm: [] };
    for (const r of rows) {
      const t = Date.parse(r.date);
      if (t < from || t > to || r.throttle > 100 || r.brake > 100) continue;
      out.t.push(t);
      out.speed.push(r.speed);
      out.throttle.push(r.throttle);
      out.brake.push(r.brake);
      out.gear.push(r.n_gear);
      out.rpm.push(r.rpm);
    }
    return out;
  });
}

// Registrazioni del live timing fatte da F1Data: la sessione in diretta e quelle passate.
async function recording(id) {
  const entry = await readRecording(id);
  if (!entry) throw httpError(404, 'Registrazione non trovata');
  return entry;
}

async function recordingBundle(id) {
  const entry = await recording(id);
  const out = entry.rec.bundle(`rec:${id}`);
  out.session.live = Date.now() - entry.mtime < 3 * 60e3 && !entry.rec.finished;
  return out;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) throw httpError(403, 'Percorso non consentito');
  let body;
  try {
    body = await readFile(file);
  } catch {
    throw httpError(404, 'File non trovato');
  }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(body);
}

async function route(req, res) {
  if (req.method !== 'GET') throw httpError(405, 'Metodo non consentito');
  const { pathname } = new URL(req.url, `http://${HOST}`);
  if (pathname === '/api/sessions') return sendJson(res, 200, await raceSessions());
  if (pathname === '/api/recordings') return sendJson(res, 200, { dir: RECORDINGS_DIR, list: await listRecordings() });
  let r = pathname.match(/^\/api\/rec\/([^/]{1,160})$/);
  if (r) return sendJson(res, 200, await recordingBundle(decodeURIComponent(r[1])));
  r = pathname.match(/^\/api\/rec\/([^/]{1,160})\/car\/(\d{1,3})$/);
  if (r) return sendJson(res, 200, (await recording(decodeURIComponent(r[1]))).rec.car(Number(r[2])));
  let m = pathname.match(/^\/api\/session\/(\d{1,7})$/);
  if (m) return sendJson(res, 200, await bundle(Number(m[1])));
  m = pathname.match(/^\/api\/session\/(\d{1,7})\/car\/(\d{1,3})$/);
  if (m) return sendJson(res, 200, await carData(Number(m[1]), Number(m[2])));
  if (pathname.startsWith('/api/')) throw httpError(404, 'Endpoint sconosciuto');
  return serveStatic(pathname, res);
}

http
  .createServer((req, res) => {
    route(req, res).catch((err) => {
      if (!err.status) console.error(err);
      if (!res.headersSent) sendJson(res, err.status ?? 502, { error: err.message });
      else res.end();
    });
  })
  .listen(PORT, HOST, () => console.log(`Muretto box pronto su http://localhost:${PORT}`));
