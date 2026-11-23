import {
  ASSUMPTIONS,
  analyse,
  autoRival,
  cleanLaps,
  compareLaps,
  gapSeries,
  mentionsDriver,
  prepare,
  snapshot,
  telemetryLaps,
} from './model.js';
import { LineChart, tableFor } from './charts.js';

const $ = (id) => document.getElementById(id);
const COLOR_ME = '#3987e5';
const COLOR_RIVAL = '#d95926';
const TICK_MS = 250;
const RADIO_HOST = 'livetiming.formula1.com';
const DEFAULT_DRIVER = 16;
const LIVE_POLL_MS = 3000;
const REC_PREFIX = 'rec:';

const state = {
  S: null,
  sessionKey: null,
  me: DEFAULT_DRIVER,
  rivalChoice: 'auto',
  rival: null,
  t: 0,
  playing: false,
  speed: 1,
  dirty: true,
  pickedLap: null,
  decisions: [],
  cars: new Map(),
  keys: {},
  loadToken: 0,
  live: false,
  polling: false,
};

const fmtLap = (s) => {
  if (s == null) return '—';
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(3).padStart(6, '0')}`;
};
const fmtLapShort = (s) => {
  const m = Math.floor(s / 60);
  return `${m}:${(s - m * 60).toFixed(1).padStart(4, '0')}`;
};
const fmtGap = (x) => (typeof x === 'number' ? `+${x.toFixed(3)}` : x ?? '—');
const fmtInt = (x) => (typeof x === 'number' ? x.toFixed(3) : x ?? '—');
const fmtSigned = (x, d = 1) => `${x >= 0 ? '+' : '−'}${Math.abs(x).toFixed(d)}`;
const fmtClock = (msValue) => {
  const s = Math.max(Math.floor(msValue / 1000), 0);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(Math.floor(s / 3600))}:${p(Math.floor(s / 60) % 60)}:${p(s % 60)}`;
};

function setText(id, value) {
  const node = $(id);
  if (node.textContent !== value) node.textContent = value;
}

function changed(name, key) {
  if (state.keys[name] === key) return false;
  state.keys[name] = key;
  return true;
}

function notice(text) {
  $('notice').hidden = !text;
  $('notice').textContent = text ?? '';
}

async function api(path) {
  const res = await fetch(path);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error ?? `Errore ${res.status}`);
  return body;
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  return { session: p.get('s') || null, me: Number(p.get('me')) || null, rival: p.get('r') };
}

// Le sessioni di OpenF1 hanno una chiave numerica, le registrazioni di F1Data "rec:<file>".
const isRecording = (key) => String(key).startsWith(REC_PREFIX);
const sessionPath = (key) =>
  isRecording(key) ? `/api/rec/${encodeURIComponent(String(key).slice(REC_PREFIX.length))}` : `/api/session/${key}`;

function writeHash() {
  const p = new URLSearchParams({ s: state.sessionKey, me: state.me, r: state.rivalChoice });
  history.replaceState(null, '', `#${p}`);
}

function option(value, label) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  return o;
}

// --- Grafici ---------------------------------------------------------------

const lapChart = new LineChart($('lapChart'), {
  label: 'Tempi sul giro dei due piloti',
  title: 'Tempo',
  yFormat: fmtLapShort,
  xFormat: (x) => `G${Math.round(x)}`,
  directLabels: true,
  breakOver: 1.5,
  onPick: (lap) => {
    state.pickedLap = lap;
    state.dirty = true;
  },
});
const gapChart = new LineChart($('gapChart'), {
  label: 'Distacco dal pilota di confronto',
  title: 'Distacco',
  yFormat: (v) => fmtSigned(v),
  xFormat: (x) => `G${Math.round(x)}`,
  zero: true,
  breakOver: 1.5,
});
const pct = (x) => `${Math.round(x)}%`;
const telemetryCharts = [
  new LineChart($('telSpeed'), { title: 'Velocità', label: 'Velocità lungo il giro', yFormat: (v) => String(Math.round(v)), xFormat: pct, hideXAxis: true, directLabels: true }),
  new LineChart($('telThrottle'), { title: 'Gas', label: 'Acceleratore lungo il giro', yFormat: (v) => String(Math.round(v)), xFormat: pct, yDomain: [0, 100], yTicks: 2, hideXAxis: true, directLabels: true }),
  new LineChart($('telBrake'), { title: 'Freno', label: 'Freno lungo il giro', yFormat: (v) => String(Math.round(v)), xFormat: pct, yDomain: [0, 100], yTicks: 1, hideXAxis: true, directLabels: true }),
  new LineChart($('telDelta'), { title: 'Delta', label: 'Delta tempo lungo il giro', yFormat: (v) => fmtSigned(v, 2), xFormat: pct, zero: true, yTicks: 3, directLabels: true }),
];
telemetryCharts.forEach((c) => {
  c.peers = telemetryCharts.filter((p) => p !== c);
});

const TABLES = {
  laps: { host: () => $('lapChart'), charts: [lapChart], head: 'Giro', fmt: (x) => `G${Math.round(x)}` },
  gap: { host: () => $('gapChart'), charts: [gapChart], head: 'Giro', fmt: (x) => `G${Math.round(x)}` },
  tel: { host: () => $('telBody'), charts: telemetryCharts, head: 'Giro %', fmt: pct },
};

function refreshTable(name) {
  const cfg = TABLES[name];
  cfg.host().querySelector(':scope > .table-view')?.remove();
  if (cfg.open) cfg.host().append(tableFor(cfg.charts, cfg.head, cfg.fmt));
}

document.querySelectorAll('[data-table]').forEach((btn) => {
  btn.setAttribute('aria-pressed', 'false');
  btn.addEventListener('click', () => {
    const name = btn.dataset.table;
    TABLES[name].open = !TABLES[name].open;
    btn.setAttribute('aria-pressed', String(TABLES[name].open));
    refreshTable(name);
  });
});

// --- Rendering --------------------------------------------------------------

const towerRows = new Map();

function buildTower() {
  towerRows.clear();
  const body = $('tower');
  body.replaceChildren();
  for (const d of state.S.drivers) {
    const tr = document.createElement('tr');
    const cells = ['pos', 'name', 'gap', 'int', 'tyre', 'last', 'stops'].map((k) => {
      const td = document.createElement('td');
      if (['gap', 'int', 'last', 'stops'].includes(k)) td.className = 'n';
      return [k, td];
    });
    const refs = Object.fromEntries(cells);

    const pick = document.createElement('button');
    pick.className = 'pick';
    pick.title = `Confronta con ${d.full_name}`;
    pick.style.setProperty('--team', `#${d.team_colour}`);
    pick.append(document.createElement('i'), document.createTextNode(d.name_acronym));
    pick.addEventListener('click', () => {
      if (d.driver_number === state.me) return;
      state.rivalChoice = String(d.driver_number);
      $('rival').value = state.rivalChoice;
      resetSelection();
    });
    refs.name.append(pick);

    const chip = document.createElement('span');
    chip.className = 'tyre';
    const age = document.createElement('span');
    const out = document.createElement('span');
    out.className = 'outlap';
    refs.tyre.append(chip, age, out);

    tr.append(...cells.map(([, td]) => td));
    body.append(tr);
    towerRows.set(d.driver_number, { tr, refs, chip, age, out });
  }
}

const TYRE = {
  SOFT: ['S', '--tyre-s'],
  MEDIUM: ['M', '--tyre-m'],
  HARD: ['H', '--tyre-h'],
  INTERMEDIATE: ['I', '--tyre-i'],
  WET: ['W', '--tyre-w'],
};
const TYRE_NAME = { SOFT: 'Soft', MEDIUM: 'Medium', HARD: 'Hard', INTERMEDIATE: 'Intermedia', WET: 'Da bagnato' };

const put = (node, text) => {
  if (node.textContent !== text) node.textContent = text;
};

function renderTower(snap) {
  const order = snap.rows.map((r) => r.num).join();
  if (changed('towerOrder', order)) {
    for (const r of snap.rows) $('tower').append(towerRows.get(r.num).tr);
  }
  snap.rows.forEach((r, i) => {
    const row = towerRows.get(r.num);
    row.tr.className = [r.num === state.me && 'is-me', r.num === state.rival && 'is-rival', r.out && 'is-out'].filter(Boolean).join(' ');
    put(row.refs.pos, r.out ? '—' : String(r.pos ?? i + 1));
    put(row.refs.gap, r.out ? 'FUORI' : i === 0 ? 'Leader' : fmtGap(r.rawGap));
    put(row.refs.int, r.out || i === 0 ? '' : fmtInt(r.interval));
    put(row.refs.last, fmtLap(r.lastLap));
    put(row.refs.stops, String(r.stops));
    const [letter, tone] = TYRE[r.compound] ?? ['?', '--muted'];
    put(row.chip, letter);
    row.chip.style.setProperty('--tyre', `var(${tone})`);
    row.chip.title = TYRE_NAME[r.compound] ?? 'Mescola sconosciuta';
    put(row.age, r.age == null ? '' : String(r.age));
    put(row.out, r.outLap && !r.out ? 'OUT' : '');
  });
}

function renderHeader(snap) {
  const { S } = state;
  const status = $('status');
  status.dataset.kind = snap.status.kind;
  if (changed('status', snap.status.label)) {
    status.replaceChildren(document.createElement('i'), document.createTextNode(snap.status.label));
  }
  setText('lap', `Giro ${snap.lap} / ${S.totalLaps}`);
  const w = snap.weather;
  setText(
    'weather',
    w ? `Aria ${w.air.toFixed(0)}° · Pista ${w.track.toFixed(0)}° · ${w.rain ? 'Pioggia' : 'Asciutto'} · Vento ${w.wind.toFixed(1)} m/s` : '',
  );
  setText('clock', fmtClock(snap.t - S.start));
  $('scrub').max = S.end;
  $('scrub').value = snap.t;
  $('play').textContent = state.playing ? 'Ferma' : 'Avvia';
  renderLive(snap);
}

// In diretta il muretto segue l'ora reale; tornando indietro si guarda in differita.
function renderLive(snap) {
  const btn = $('goLive');
  btn.hidden = !state.live;
  if (!state.live) return;
  const behind = Math.round((Date.now() - snap.t) / 1000);
  const onAir = state.playing && behind <= 2;
  btn.dataset.on = String(onAir);
  setText('goLive', onAir ? 'In diretta' : `Differita −${fmtClock(behind * 1000)} · Torna in diretta`);
}

function rateAheadText(rate) {
  if (rate == null) return 'Andamento in attesa di giri puliti';
  if (Math.abs(rate) < 0.005) return 'Distacco stabile';
  return rate < 0 ? `Recuperi ${Math.abs(rate).toFixed(2)} s/giro` : `Perdi ${rate.toFixed(2)} s/giro`;
}

function rateBehindText(rate) {
  if (rate == null) return 'Andamento in attesa di giri puliti';
  if (Math.abs(rate) < 0.005) return 'Distacco stabile';
  return rate < 0 ? `Ti riprende ${Math.abs(rate).toFixed(2)} s/giro` : `Si allontana ${rate.toFixed(2)} s/giro`;
}

function renderBattle(a) {
  setText('meWho', a.me.tla);
  setText('mePos', a.me.out ? 'Fuori' : `P${a.me.pos ?? '—'}`);
  setText('meSub', `Ultimo ${fmtLap(a.me.lastLap)} · Migliore ${fmtLap(a.me.bestLap)}`);
  setText('aheadWho', a.ahead?.tla ?? '—');
  setText('aheadGap', a.ahead && typeof a.me.interval === 'number' ? a.me.interval.toFixed(3) : '—');
  setText('aheadRate', a.ahead ? rateAheadText(a.rateAhead) : 'In testa');
  setText('behindWho', a.behind?.tla ?? '—');
  setText('behindGap', a.behind && typeof a.behind.interval === 'number' ? a.behind.interval.toFixed(3) : '—');
  setText('behindRate', a.behind ? rateBehindText(a.rateBehind) : 'Ultimo in gara');
}

const SEVERITY_LABEL = { critical: 'URGENTE', warning: 'ATTENZIONE', info: 'INFO' };

function renderCalls(a) {
  const top = a.calls.slice(0, 5);
  if (!changed('calls', JSON.stringify(top))) return;
  const list = $('calls');
  if (!top.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Nessuna chiamata.';
    list.replaceChildren(li);
    return;
  }
  list.replaceChildren(
    ...top.map((c) => {
      const li = document.createElement('li');
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.dataset.s = c.severity;
      tag.textContent = SEVERITY_LABEL[c.severity];
      const text = document.createElement('span');
      text.textContent = c.text;
      li.append(tag, text);
      return li;
    }),
  );
}

function renderStrategy(a, snap) {
  const { me, deg, loss, effective, box, window: win, cut, ahead, trackEvolving, mandatory } = a;
  setText('stTyre', me.compound ? `${TYRE_NAME[me.compound] ?? me.compound} · ${me.age} giri · ${me.stops} soste` : '—');
  setText(
    'stDeg',
    trackEvolving
      ? 'Non leggibile, pista in miglioramento'
      : deg
        ? `${deg.value.toFixed(2)} s/giro su ${deg.laps} giri puliti`
        : 'In attesa di almeno 4 giri puliti',
  );
  setText(
    'stLoss',
    `${loss.value.toFixed(1)} s ${loss.estimated ? '(stima iniziale)' : `(${loss.samples} soste)`}${
      snap.status.kind !== 'GREEN' && snap.status.kind !== 'END' ? ` → ${effective.toFixed(1)} s ora` : ''
    }`,
  );
  if (box) {
    const ahd = box.ahead ? `dietro ${box.ahead.tla} di ${box.ahead.margin.toFixed(1)}` : 'in testa';
    const bhd = box.behind ? `, davanti a ${box.behind.tla} di ${box.behind.margin.toFixed(1)}` : '';
    setText('stBox', `P${box.pos}, ${ahd}${bhd}${box.traffic ? ' · traffico' : ''}`);
  } else {
    setText('stBox', '—');
  }
  let windowText = 'In attesa di dati sul degrado';
  if (trackEvolving) windowText = 'Non stimabile';
  else if (win?.stayOut) windowText = 'Nessuna sosta conviene';
  else if (win) windowText = `Giri ${win.fromLap}–${win.toLap}${win.gain != null ? ` · vale ${win.gain.toFixed(1)} s` : ''}`;
  if (mandatory) windowText += ' · manca la 2ª mescola';
  setText('stWindow', windowText);
  setText(
    'stCut',
    cut && ahead ? `su ${ahead.tla}: servono ${cut.needed.toFixed(1)} s, stima ${cut.gain.toFixed(1)} s · ${cut.ok ? 'possibile' : 'non basta'}` : '—',
  );
}

function renderDecisions() {
  const { S } = state;
  const items = state.decisions.map((d) => {
    const real = S.pits.find((p) => p.num === state.me && p.t > d.t && p.t <= state.t);
    const li = document.createElement('li');
    const predicted = d.pos ? `, rientro stimato P${d.pos}` : '';
    let outcome = ' · la squadra non si è ancora fermata';
    if (real) {
      const diff = real.lap - d.lap;
      outcome = ` · squadra al giro ${real.lap} (${diff === 0 ? 'stesso giro' : `${diff > 0 ? '+' : ''}${diff}`})`;
    }
    li.textContent = `Giro ${d.lap}${predicted}${outcome}`;
    return li;
  });
  const key = items.map((i) => i.textContent).join('|');
  if (changed('decisions', key)) $('decisions').replaceChildren(...items);
}

function lapLabel(t) {
  const { S } = state;
  const list = S.laps.get(state.me) ?? [];
  let n = 0;
  for (const l of list) if (l.start != null && l.start <= t) n = l.n;
  return `G${n}`;
}

function renderRaceControl(snap, a) {
  const { S } = state;
  const list = S.rc.filter(
    (r) => r.t <= snap.t && (r.flag !== 'BLUE' || r.num === state.me) && !(r.flag === 'CLEAR' && r.scope === 'Sector'),
  );
  if (!changed('rc', `${list.length}|${state.me}`)) return;
  $('rc').replaceChildren(
    ...list
      .slice(-50)
      .reverse()
      .map((r) => {
        const li = document.createElement('li');
        if (mentionsDriver(r, a.me.num, a.me.tla)) li.className = 'mine';
        const lap = document.createElement('span');
        lap.textContent = `G${r.lap ?? '—'}`;
        const msg = document.createElement('div');
        msg.textContent = r.msg;
        li.append(lap, msg);
        return li;
      }),
  );
}

let audio = null;

function safeRadioUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && u.hostname === RADIO_HOST ? u.href : null;
  } catch {
    return null;
  }
}

function renderRadio(snap) {
  const { S } = state;
  const list = S.radio.filter((r) => r.t <= snap.t && (r.num === state.me || r.num === state.rival));
  if (!changed('radio', `${list.length}|${state.me}|${state.rival}`)) return;
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'none';
    li.textContent = 'Nessun messaggio finora.';
    li.style.display = 'block';
    $('radio').replaceChildren(li);
    return;
  }
  $('radio').replaceChildren(
    ...list
      .slice(-25)
      .reverse()
      .map((r) => {
        const li = document.createElement('li');
        const lap = document.createElement('span');
        lap.textContent = lapLabel(r.t);
        const btn = document.createElement('button');
        const label = `Ascolta ${S.tla.get(r.num) ?? r.num}`;
        btn.textContent = label;
        const src = safeRadioUrl(r.url);
        btn.disabled = !src;
        btn.addEventListener('click', () => {
          audio?.pause();
          audio = new Audio(src);
          audio.play().catch(() => notice('Audio del team radio non disponibile.'));
        });
        li.append(lap, btn);
        return li;
      }),
  );
}

function renderLegends(snap) {
  const me = snap.byNum.get(state.me);
  const rival = snap.byNum.get(state.rival);
  if (!changed('legend', `${me?.tla}|${rival?.tla}`)) return;
  const key = (name, color) => {
    const s = document.createElement('span');
    const i = document.createElement('i');
    i.style.setProperty('--key', color);
    s.append(i, document.createTextNode(name ?? '—'));
    return s;
  };
  document.querySelectorAll('[data-legend]').forEach((host) => {
    host.replaceChildren(key(me?.tla, COLOR_ME), key(rival?.tla, COLOR_RIVAL));
  });
}

function renderLapCharts(snap) {
  const { S } = state;
  const me = snap.byNum.get(state.me);
  const rival = snap.byNum.get(state.rival);
  if (!me || !rival) return;
  if (!changed('lapCharts', `${state.me}|${state.rival}|${me.lap}|${rival.lap}`)) return;
  const toPoints = (num) => cleanLaps(S, num, snap.t).map((l) => [l.n, l.dur]);
  lapChart.setData([
    { name: me.tla, color: COLOR_ME, points: toPoints(me.num) },
    { name: rival.tla, color: COLOR_RIVAL, points: toPoints(rival.num) },
  ]);
  setText('gapTitle', `Distacco da ${rival.tla}`);
  gapChart.setData([
    { name: `${me.tla} su ${rival.tla}`, color: COLOR_ME, points: gapSeries(S, me.num, rival.num, snap.t).map((p) => [p.lap, p.gap]) },
  ]);
  refreshTable('laps');
  refreshTable('gap');
}

function car(num) {
  if (!state.cars.has(num)) {
    const promise = api(`${sessionPath(state.sessionKey)}/car/${num}`).catch((err) => {
      state.cars.delete(num);
      throw err;
    });
    state.cars.set(num, promise);
  }
  return state.cars.get(num);
}

async function renderTelemetry(snap) {
  const { S } = state;
  if (state.rival == null) return;
  const laps = telemetryLaps(S, state.me, state.rival, snap.t, state.pickedLap);
  if (!laps) return;
  const key = `${state.sessionKey}|${state.me}|${state.rival}|${laps.a.n}|${laps.b.n}`;
  if (!changed('telemetry', key)) return;
  const nameA = S.tla.get(state.me);
  const nameB = S.tla.get(state.rival);
  const hosts = telemetryCharts.map((c) => c.host);
  hosts.forEach((h) => h.classList.add('stale'));
  setText('telTitle', 'Scarico la telemetria…');
  try {
    const [carA, carB] = await Promise.all([car(state.me), car(state.rival)]);
    if (state.keys.telemetry !== key) return;
    const cmp = compareLaps(carA, laps.a, carB, laps.b);
    if (!cmp) {
      setText('telTitle', `Telemetria non disponibile per il giro ${laps.a.n}`);
      return;
    }
    const zip = (ys) => cmp.x.map((x, i) => [x, ys[i]]);
    const pair = (a, b) => [
      { name: nameA, color: COLOR_ME, points: zip(a) },
      { name: nameB, color: COLOR_RIVAL, points: zip(b) },
    ];
    telemetryCharts[0].setData(pair(cmp.speedA, cmp.speedB));
    telemetryCharts[1].setData(pair(cmp.throttleA, cmp.throttleB));
    telemetryCharts[2].setData(pair(cmp.brakeA, cmp.brakeB));
    telemetryCharts[3].setData([{ name: nameA, color: COLOR_ME, points: zip(cmp.delta) }]);
    refreshTable('tel');
    const lapText = laps.a.n === laps.b.n ? `Giro ${laps.a.n}` : `Giri ${laps.a.n} e ${laps.b.n}`;
    setText('telTitle', `${lapText} · ${nameA} ${fmtLap(laps.a.dur)} · ${nameB} ${fmtLap(laps.b.dur)}`);
  } catch (err) {
    state.keys.telemetry = null;
    notice(`Telemetria non scaricata: ${err.message}`);
  } finally {
    hosts.forEach((h) => h.classList.remove('stale'));
  }
}

function render() {
  const { S } = state;
  if (!S) return;
  const snap = snapshot(S, state.t);
  state.rival = state.rivalChoice === 'auto' ? autoRival(snap, state.me) : Number(state.rivalChoice);
  const a = analyse(S, snap, state.me);
  state.analysis = a;
  renderHeader(snap);
  renderTower(snap);
  if (a) {
    renderBattle(a);
    renderCalls(a);
    renderStrategy(a, snap);
    renderRaceControl(snap, a);
  }
  renderDecisions();
  renderRadio(snap);
  renderLegends(snap);
  renderLapCharts(snap);
  renderTelemetry(snap);
}

// --- Orologio del replay ----------------------------------------------------

let lastTick = performance.now();
let lastPaint = 0;

setInterval(() => {
  const now = performance.now();
  const dt = now - lastTick;
  lastTick = now;
  if (state.S && state.live) state.S.end = Math.max(state.S.end, Date.now());
  if (state.S && state.playing) {
    state.t = Math.min(state.t + dt * state.speed, state.S.end);
    // In diretta si resta agganciati all'ora reale invece di fermarsi.
    if (state.t >= state.S.end && !state.live) state.playing = false;
    state.dirty = true;
  }
  if (state.dirty && now - lastPaint >= TICK_MS - 10) {
    state.dirty = false;
    lastPaint = now;
    render();
  }
}, TICK_MS / 2);

function seek(delta) {
  const { S } = state;
  if (!S) return;
  state.t = Math.min(Math.max(state.t + delta, S.start), S.end);
  state.dirty = true;
}

// Il confronto cambia: si azzerano la scelta del giro e le decisioni non legate al pilota.
function resetSelection() {
  state.pickedLap = null;
  state.dirty = true;
  writeHash();
}

// --- Caricamento ------------------------------------------------------------

function fillDriverSelects() {
  const { S } = state;
  const sorted = [...S.drivers].sort((a, b) => a.name_acronym.localeCompare(b.name_acronym));
  $('me').replaceChildren(...sorted.map((d) => option(d.driver_number, `${d.name_acronym} · ${d.full_name}`)));
  $('me').value = state.me;
  $('rival').replaceChildren(
    option('auto', 'Auto: chi ha davanti'),
    ...sorted.filter((d) => d.driver_number !== state.me).map((d) => option(d.driver_number, d.name_acronym)),
  );
  $('rival').value = state.rivalChoice;
}

async function loadSession(key, { fallbacks = [] } = {}) {
  const token = ++state.loadToken;
  state.playing = false;
  state.live = false;
  notice(isRecording(key) ? 'Leggo la registrazione di F1Data.' : 'Scarico i dati della gara. La prima volta richiede circa dieci secondi.');
  try {
    const raw = await api(sessionPath(key));
    if (token !== state.loadToken) return;
    if (!raw.laps.length) {
      if (fallbacks.length) return loadSession(fallbacks[0], { fallbacks: fallbacks.slice(1) });
      if (raw.session?.live) {
        state.sessionKey = key;
        state.S = null;
        state.live = true;
        notice('Registrazione di F1Data in corso: il muretto parte con il primo giro.');
        schedulePoll(token);
        return;
      }
      notice(
        isRecording(key)
          ? 'Questa registrazione non contiene giri di gara.'
          : 'Per questa sessione non ci sono ancora dati gratuiti: per la diretta usa le registrazioni di F1Data.',
      );
      return;
    }
    state.S = prepare(raw);
    state.sessionKey = key;
    $('session').value = key;
    state.cars.clear();
    state.keys = {};
    state.decisions = [];
    state.pickedLap = null;
    if (!state.S.tla.has(state.me)) state.me = state.S.drivers[0].driver_number;
    if (state.rivalChoice !== 'auto' && (!state.S.tla.has(Number(state.rivalChoice)) || Number(state.rivalChoice) === state.me)) {
      state.rivalChoice = 'auto';
    }
    fillDriverSelects();
    buildTower();
    $('scrub').min = state.S.start;
    $('scrub').max = state.S.end;
    // Una registrazione partita a gara in corso non ha dati prima del suo inizio.
    const from = Date.parse(raw.session?.recorded_from ?? '');
    state.t = Number.isFinite(from) ? Math.min(Math.max(state.S.start, from), state.S.end) : state.S.start;
    state.live = Boolean(raw.session?.live);
    if (state.live) {
      state.t = Date.now();
      state.speed = 1;
      $('speed').value = '1';
      state.playing = true;
      schedulePoll(token);
    }
    state.dirty = true;
    writeHash();
    notice(null);
  } catch (err) {
    if (token === state.loadToken) notice(`Dati non disponibili: ${err.message}`);
  }
}

// Durante la diretta si rilegge la registrazione: il server legge solo la parte nuova del file.
function schedulePoll(token) {
  if (state.polling) return;
  state.polling = true;
  setTimeout(() => {
    state.polling = false;
    if (token === state.loadToken) refreshLive(token);
  }, LIVE_POLL_MS);
}

async function refreshLive(token) {
  try {
    const raw = await api(sessionPath(state.sessionKey));
    if (token !== state.loadToken) return;
    if (!raw.laps.length) return schedulePoll(token);
    if (!state.S) return loadSession(state.sessionKey);
    const known = state.S.drivers.map((d) => d.driver_number).join();
    state.S = prepare(raw);
    state.S.end = Math.max(state.S.end, Date.now());
    state.cars.clear(); // la telemetria in cache non ha i giri appena finiti
    if (state.S.drivers.map((d) => d.driver_number).join() !== known) {
      fillDriverSelects();
      buildTower();
      state.keys.towerOrder = null;
    }
    state.live = Boolean(raw.session?.live);
    if (!state.live) notice('La registrazione di F1Data è finita: ora puoi rivederla come un replay.');
    else notice(null);
    state.dirty = true;
  } catch (err) {
    if (token === state.loadToken) notice(`Diretta interrotta, riprovo: ${err.message}`);
  }
  if (state.live && token === state.loadToken) schedulePoll(token);
}

function group(label, options) {
  const g = document.createElement('optgroup');
  g.label = label;
  g.append(...options);
  return g;
}

async function init() {
  try {
    const [sessions, recordings] = await Promise.all([
      api('/api/sessions').catch(() => []),
      api('/api/recordings').catch(() => ({ list: [] })),
    ]);
    const recs = recordings.list.map((r) => ({ ...r, key: `${REC_PREFIX}${r.id}` }));
    const groups = [];
    if (recs.length) {
      groups.push(group('Registrazioni F1Data', recs.map((r) => option(r.key, `${r.live ? '● IN DIRETTA · ' : `${r.date} · `}${r.title}`))));
    }
    groups.push(
      group(
        'Archivio OpenF1',
        sessions.map((s) => option(String(s.session_key), `${s.year} · ${s.location}${s.session_name === 'Race' ? '' : ` · ${s.session_name}`}`)),
      ),
    );
    $('session').replaceChildren(...groups);
    const hash = readHash();
    if (hash.me) state.me = hash.me;
    if (hash.rival) state.rivalChoice = hash.rival;
    const live = recs.find((r) => r.live);
    const keys = [...recs.map((r) => r.key), ...sessions.map((s) => String(s.session_key))];
    const openf1 = sessions.map((s) => String(s.session_key));
    // Se F1Data sta registrando una gara, il muretto parte da lì.
    if (live) await loadSession(live.key);
    else if (hash.session && keys.includes(hash.session)) await loadSession(hash.session);
    else if (openf1.length) await loadSession(openf1[0], { fallbacks: openf1.slice(1, 4) });
    else if (recs.length) await loadSession(recs[0].key);
    else notice('Nessuna gara disponibile.');
  } catch (err) {
    notice(`Impossibile leggere il calendario: ${err.message}`);
  }
}

// --- Comandi ----------------------------------------------------------------

$('session').addEventListener('change', (e) => loadSession(e.target.value));
$('goLive').addEventListener('click', () => {
  if (!state.S || !state.live) return;
  state.t = Date.now();
  state.speed = 1;
  $('speed').value = '1';
  state.playing = true;
  state.dirty = true;
});
$('me').addEventListener('change', (e) => {
  state.me = Number(e.target.value);
  if (state.rivalChoice === String(state.me)) state.rivalChoice = 'auto';
  state.decisions = [];
  fillDriverSelects();
  resetSelection();
});
$('rival').addEventListener('change', (e) => {
  state.rivalChoice = e.target.value;
  resetSelection();
});
$('speed').addEventListener('change', (e) => {
  state.speed = Number(e.target.value);
});
$('play').addEventListener('click', () => {
  if (!state.S) return;
  state.playing = !state.playing;
  state.dirty = true;
});
$('scrub').addEventListener('input', (e) => {
  state.t = Number(e.target.value);
  state.dirty = true;
});
for (const [id, delta] of [['back60', -60e3], ['back10', -10e3], ['fwd10', 10e3], ['fwd60', 60e3]]) {
  $(id).addEventListener('click', () => seek(delta));
}
$('callBox').addEventListener('click', () => {
  const a = state.analysis;
  if (!a || a.me.lap === 0) return;
  state.decisions.push({ lap: a.me.lap, t: state.t, pos: a.box?.pos ?? null });
  state.dirty = true;
});

document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('select, input, button, svg')) return;
  if (e.code === 'Space') {
    e.preventDefault();
    $('play').click();
  } else if (e.key === 'ArrowLeft') seek(e.shiftKey ? -60e3 : -10e3);
  else if (e.key === 'ArrowRight') seek(e.shiftKey ? 60e3 : 10e3);
});

// Le assunzioni restano visibili a chi passa il mouse sulla strategia.
$('stLoss').title = `Sotto SC resta il ${ASSUMPTIONS.scLossFactor * 100}% della perdita, sotto VSC il ${ASSUMPTIONS.vscLossFactor * 100}%. Sono stime.`;

init();
