// Crea in MultiViewer il setup "Muretto · Top 4" sui tre schermi:
//   verticale    → 1 onboard in primo piano + 8 onboard dei 4 top team, a coppie per squadra
//   orizzontale  → F1 LIVE a tutto schermo, con l'audio
//   MacBook      → live timing di MultiViewer
//
// MultiViewer abbina ogni finestra al flusso della sessione aperta tramite numero e sigla del
// pilota, quindi lo stesso setup va bene per qualsiasi gara. channelId è -1 apposta: un id
// vecchio potrebbe coincidere con il canale di un altro pilota nella sessione nuova.
//
//   node multiviewer/make-setup.mjs            scrive il setup (MultiViewer deve essere chiuso)
//   node multiviewer/make-setup.mjs --dry-run  stampa solo il setup
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const FILE = join(homedir(), 'Library/Application Support/MultiViewer/setups.config.json');
const SETUP_ID = '7b3f2c1e-4a5d-4e8f-9c21-0d6a1b2c3e4f';
const NAME = 'Muretto · Top 4';

// Da aggiornare a inizio 2027 con la nuova classifica costruttori.
const TEAMS = [
  ['Mercedes', [[63, 'RUS', 'George', 'Russell'], [12, 'ANT', 'Andrea Kimi', 'Antonelli']]],
  ['Ferrari', [[16, 'LEC', 'Charles', 'Leclerc'], [44, 'HAM', 'Lewis', 'Hamilton']]],
  ['Red Bull Racing', [[3, 'VER', 'Max', 'Verstappen'], [6, 'HAD', 'Isack', 'Hadjar']]],
  ['McLaren', [[1, 'NOR', 'Lando', 'Norris'], [81, 'PIA', 'Oscar', 'Piastri']]],
];
// Onboard in primo piano all'avvio: lo cambi dal player durante la gara.
const FOCUS = 'LEC';

function screens() {
  const js = `
    ObjC.import('AppKit');
    const s = $.NSScreen.screens, H = s.objectAtIndex(0).frame.size.height, out = [];
    for (let i = 0; i < s.count; i++) {
      const sc = s.objectAtIndex(i), f = sc.frame, v = sc.visibleFrame;
      out.push({
        id: ObjC.unwrap(sc.deviceDescription.objectForKey('NSScreenNumber')),
        label: ObjC.unwrap(sc.localizedName),
        scaleFactor: sc.backingScaleFactor,
        bounds: { x: f.origin.x, y: H - f.origin.y - f.size.height, width: f.size.width, height: f.size.height },
        workArea: { x: v.origin.x, y: H - v.origin.y - v.size.height, width: v.size.width, height: v.size.height },
      });
    }
    JSON.stringify(out);`;
  return JSON.parse(execFileSync('osascript', ['-l', 'JavaScript', '-e', js], { encoding: 'utf8' }));
}

const all = screens();
const builtIn = all.find((d) => /built-in/i.test(d.label));
const vertical = all.find((d) => d !== builtIn && d.bounds.height > d.bounds.width);
const horizontal = all.find((d) => d !== builtIn && d.bounds.width > d.bounds.height);
if (!builtIn || !vertical || !horizontal) {
  console.error('Servono MacBook, un monitor verticale e uno orizzontale collegati. Trovati:', all.map((d) => d.label));
  process.exit(1);
}

let nextId = 1;
const windowState = (display, x, y, width, height, keepRatio = true) => ({
  bounds: { x, y, width, height },
  isMaximized: false,
  isFullScreen: false,
  isAlwaysOnTop: false,
  displayId: display.id,
  maintainAspectRatio: keepRatio,
});

function onboard(team, [driverNumber, tla, firstName, lastName], ws) {
  return {
    id: nextId++,
    type: 'f1tv.player',
    state: {
      streamData: { title: tla, type: 'obc', channelId: -1 },
      driverData: { driverNumber, firstName, lastName, teamName: team, tla },
      driverHeaderMode: 'obc_live_timing',
      playerState: { muted: true, volume: 100 },
    },
    windowState: ws,
  };
}

const windows = [];

// Monitor verticale: 1080×608 in alto, poi 4 righe da 540×304.
{
  const { x, y, width } = vertical.workArea;
  const focusH = Math.round((width * 9) / 16);
  const tileW = width / 2;
  const tileH = Math.round((tileW * 9) / 16);
  const [team, drivers] = TEAMS.find(([, ds]) => ds.some((d) => d[1] === FOCUS));
  windows.push(onboard(team, drivers.find((d) => d[1] === FOCUS), windowState(vertical, x, y, width, focusH)));
  TEAMS.forEach(([teamName, drivers], row) => {
    drivers.forEach((driver, col) => {
      windows.push(onboard(teamName, driver, windowState(vertical, x + col * tileW, y + focusH + row * tileH, tileW, tileH)));
    });
  });
}

// Monitor orizzontale: la gara, unico player con l'audio.
{
  const { x, y, width, height } = horizontal.workArea;
  windows.push({
    id: nextId++,
    type: 'f1tv.player',
    state: {
      streamData: { title: 'F1 LIVE', type: 'additional', channelId: -1 },
      playerState: { muted: false, volume: 100 },
    },
    windowState: windowState(horizontal, x, y, width, height),
  });
}

// MacBook: live timing su tutta l'area utile.
{
  const { x, y, width, height } = builtIn.workArea;
  windows.push({
    id: nextId++,
    type: 'f1.live-timing.index',
    state: { activeLiveTimingLayoutId: 0 },
    windowState: windowState(builtIn, x, y, width, height, false),
  });
}

const now = new Date().toISOString();
const rotation = (d) => (d === vertical ? 270 : 0);
const setup = {
  id: SETUP_ID,
  version: 1,
  name: NAME,
  insertedAt: now,
  updatedAt: now,
  displays: [builtIn, horizontal, vertical].map((d) => ({
    id: d.id,
    label: d.label,
    bounds: d.bounds,
    workArea: d.workArea,
    scaleFactor: d.scaleFactor,
    rotation: rotation(d),
    touchSupport: 'unknown',
  })),
  windows,
};

if (process.argv.includes('--dry-run')) {
  console.log(JSON.stringify(setup, null, 2));
  process.exit(0);
}

try {
  execFileSync('pgrep', ['-x', 'MultiViewer']);
  console.error('Chiudi MultiViewer prima: mentre è aperto potrebbe sovrascrivere il file.');
  process.exit(1);
} catch {
  // pgrep esce con errore quando MultiViewer non è in esecuzione: è il caso giusto.
}

const config = JSON.parse(readFileSync(FILE, 'utf8'));
copyFileSync(FILE, `${FILE}.bak`);
const previous = config.setups.find((s) => s.id === SETUP_ID);
if (previous) setup.insertedAt = previous.insertedAt;
config.setups = [...config.setups.filter((s) => s.id !== SETUP_ID), setup];
writeFileSync(FILE, JSON.stringify(config));
console.log(`Setup "${NAME}" scritto: ${windows.length} finestre, ${windows.length - 1} player. Copia di sicurezza in setups.config.json.bak`);
