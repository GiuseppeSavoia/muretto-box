import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { analyse, boxNow, effectivePitLoss, neutralWindows, pitWindow, prepare, snapshot } from '../public/model.js';

const T0 = Date.parse('2026-01-01T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();

// Gara sintetica: `n` piloti, giri da 90 s con degrado `deg`, sosta facoltativa.
function race({ drivers = 2, laps = 20, deg = 0.1, pitLap = null, compound = 'SOFT', rc = [] } = {}) {
  const raw = { session: { date_start: iso(T0), date_end: iso(T0 + 3600e3) }, drivers: [], laps: [], stints: [], pit: [], weather: [], race_control: rc, team_radio: [], position: [], intervals: [] };
  for (let d = 1; d <= drivers; d++) {
    raw.drivers.push({ driver_number: d, name_acronym: `D${d}`, team_name: 'T', team_colour: 'ffffff' });
    raw.stints.push({ driver_number: d, stint_number: 1, compound, lap_start: 1, lap_end: laps, tyre_age_at_start: 0 });
    raw.position.push({ driver_number: d, date: iso(T0), position: d });
    let at = T0 + (d - 1) * 2000;
    for (let n = 1; n <= laps; n++) {
      const dur = 90 + deg * (n - 1) + (pitLap && d === 1 && (n === pitLap || n === pitLap + 1) ? 13 : 0);
      raw.laps.push({ driver_number: d, lap_number: n, date_start: iso(at), lap_duration: dur, is_pit_out_lap: pitLap && d === 1 && n === pitLap + 1 });
      at += dur * 1000;
      raw.intervals.push({ driver_number: d, date: iso(at), gap_to_leader: d === 1 ? 0 : (d - 1) * 2, interval: d === 1 ? 0 : 2 });
    }
  }
  if (pitLap) raw.pit.push({ driver_number: 1, lap_number: pitLap, date: iso(T0 + pitLap * 91e3), lane_duration: 24, stop_duration: 2.5 });
  return raw;
}

test('la Safety Car si chiude con TRACK CLEAR, la rossa no', () => {
  const r = (t, msg, extra = {}) => ({ t, msg, flag: null, scope: null, ...extra });
  const windows = neutralWindows([
    r(1, 'SAFETY CAR DEPLOYED'),
    r(2, 'RED FLAG - RACE SUSPENDED'),
    r(3, 'TRACK CLEAR', { flag: 'CLEAR', scope: 'Track' }),
    r(4, 'SAFETY CAR LIGHTS ON'),
    r(5, 'VSC DEPLOYED'),
    r(6, 'VSC ENDING'),
  ]);
  assert.deepEqual(windows.map((w) => [w.kind, w.start, w.end]), [['SC', 1, 2], ['RED', 2, 4], ['VSC', 5, 6]]);
});

test('la rossa resta aperta finché la gara non riparte davvero', () => {
  const r = (t, msg) => ({ t, msg, flag: null, scope: null });
  const windows = neutralWindows([
    r(1, 'RED FLAG - RACE SUSPENDED'),
    r(2, 'RESUMPTION ORDER: 3, 16, 12'),
    r(3, 'RACE WILL RESUME AT 15:45'),
    r(4, 'SESSION STARTED'),
  ]);
  assert.deepEqual(windows.map((w) => [w.kind, w.start, w.end]), [['RED', 1, 4]]);
});

test('lo sconto Safety Car vale solo per chi si ferma subito', () => {
  const S = prepare(race({ laps: 50, compound: 'INTERMEDIATE' }));
  const row = { num: 1, lap: 20, age: 19 };
  const w = pitWindow(S, row, { value: 0.05 }, 10, 22);
  assert.equal(w.opensNow, true);
  assert.equal(w.toLap, 20);
});

test('a pista neutralizzata niente chiamate di attacco o difesa', () => {
  const rc = [{ date: iso(T0 + 1000), category: 'SafetyCar', flag: null, scope: null, lap_number: 1, driver_number: null, message: 'SAFETY CAR DEPLOYED' }];
  const raw = race({ drivers: 3, rc });
  raw.intervals = raw.intervals.map((i) => ({ ...i, interval: i.driver_number === 1 ? 0 : 0.2 }));
  const S = prepare(raw);
  const a = analyse(S, snapshot(S, S.end - 200_000), 2);
  assert.ok(a.calls.every((c) => !/zona attacco|sotto attacco/.test(c.text)), JSON.stringify(a.calls));
});

test('una bandiera di settore non chiude la Safety Car', () => {
  const w = neutralWindows([
    { t: 1, msg: 'SAFETY CAR DEPLOYED', flag: null, scope: null },
    { t: 2, msg: 'CLEAR IN TRACK SECTOR 16', flag: 'CLEAR', scope: 'Sector' },
  ]);
  assert.equal(w[0].end, Infinity);
});

test('il degrado viene stimato togliendo l\'effetto carburante', () => {
  const S = prepare(race({ deg: 0.1 }));
  const a = analyse(S, snapshot(S, S.end), 1);
  assert.ok(Math.abs(a.deg.value - 0.15) < 1e-6, `degrado ${a.deg.value}`);
});

test('senza abbastanza soste la perdita box resta una stima dichiarata', () => {
  const S = prepare(race({ pitLap: 10 }));
  const a = analyse(S, snapshot(S, S.end), 1);
  assert.equal(a.loss.estimated, true);
  assert.equal(a.loss.value, 24);
});

test('sotto SC la sosta costa meno, in rossa niente', () => {
  assert.equal(effectivePitLoss(20, { kind: 'SC' }), 10);
  assert.equal(effectivePitLoss(20, { kind: 'VSC' }), 13);
  assert.equal(effectivePitLoss(20, { kind: 'RED' }), 0);
  assert.equal(effectivePitLoss(20, { kind: 'GREEN' }), 20);
});

test('il rientro dai box conta chi resta davanti, doppiati compresi', () => {
  const rows = [
    { num: 1, tla: 'AAA', gap: 0 },
    { num: 2, tla: 'BBB', gap: 5 },
    { num: 3, tla: 'CCC', gap: 22 },
    { num: 4, tla: 'DDD', gap: 30 },
  ];
  const box = boxNow({ rows }, rows[1], 20);
  assert.equal(box.pos, 3);
  assert.equal(box.ahead.tla, 'CCC');
  assert.equal(box.behind.tla, 'DDD');
  assert.ok(Math.abs(box.ahead.margin - 3) < 1e-9);
});

test('con degrado nullo non conviene fermarsi, salvo sosta obbligatoria', () => {
  const S = prepare(race({ deg: 0, laps: 30 }));
  const row = { num: 1, lap: 10, age: 9 };
  assert.equal(pitWindow(S, row, { value: 0 }, 20).mandatory, true);
  assert.equal(pitWindow(S, row, { value: 0 }, 20).stayOut, false);
  const wet = prepare(race({ deg: 0, laps: 30, compound: 'INTERMEDIATE' }));
  assert.equal(pitWindow(wet, row, { value: 0 }, 20).stayOut, true);
});

test('con degrado forte la finestra cade prima di metà distanza residua', () => {
  const S = prepare(race({ laps: 50, compound: 'INTERMEDIATE' }));
  const w = pitWindow(S, { num: 1, lap: 10, age: 9 }, { value: 0.2 }, 20);
  assert.equal(w.stayOut, false);
  assert.ok(w.fromLap > 10 && w.toLap < 35, `finestra ${w.fromLap}-${w.toLap}`);
  assert.ok(w.gain > 0);
});

test('una pista che migliora non produce una finestra box', () => {
  const S = prepare(race({ laps: 50, compound: 'INTERMEDIATE' }));
  assert.equal(pitWindow(S, { num: 1, lap: 10, age: 9 }, { value: -0.5 }, 20), null);
});

test('il crossover segnala chi è più veloce sull\'altra gomma', () => {
  const raw = race({ drivers: 4, laps: 12, deg: 0, compound: 'INTERMEDIATE' });
  raw.stints = raw.stints.map((s) => (s.driver_number > 2 ? { ...s, compound: 'SOFT' } : s));
  for (const l of raw.laps) if (l.driver_number > 2) l.lap_duration -= 3;
  const S = prepare(raw);
  const a = analyse(S, snapshot(S, S.end), 1);
  assert.equal(a.cross.faster, true);
  assert.equal(a.cross.other, 'dry');
  assert.ok(Math.abs(a.cross.delta - 3) < 1e-6);
  assert.ok(a.calls.some((c) => c.severity === 'critical' && c.text.includes('asciutto')));
});

// Controllo sui dati veri, se la cache di una gara è presente: il modello a tempo t
// deve dare lo stesso risultato avendo i dati completi o solo quelli noti a t.
const CACHE = new URL('../data/11412/', import.meta.url);
const load = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, CACHE)));

function upTo(raw, t) {
  const before = (d) => Date.parse(d) <= t;
  const laps = raw.laps
    .filter((l) => l.date_start && before(l.date_start))
    .map((l) => (Date.parse(l.date_start) + (l.lap_duration ?? 0) * 1000 > t ? { ...l, lap_duration: null } : l));
  const lapNow = Math.max(0, ...laps.map((l) => l.lap_number));
  return {
    ...raw,
    laps,
    stints: raw.stints.filter((s) => s.lap_start <= lapNow).map((s) => ({ ...s, lap_end: null })),
    pit: raw.pit.filter((p) => before(p.date)),
    intervals: raw.intervals.filter((p) => before(p.date)),
    position: raw.position.filter((p) => before(p.date)),
    weather: raw.weather.filter((p) => before(p.date)),
    race_control: raw.race_control.filter((p) => before(p.date)),
    team_radio: raw.team_radio.filter((p) => before(p.date)),
  };
}

test('il replay non anticipa il futuro (gara reale)', { skip: !existsSync(new URL('laps.json', CACHE)) }, () => {
  const raw = { session: { date_start: '2026-11-08T17:00:00Z', date_end: '2026-11-08T19:00:00Z' } };
  for (const n of ['drivers', 'stints', 'pit', 'weather', 'race_control', 'team_radio', 'position', 'intervals', 'laps']) raw[n] = load(n);
  const full = prepare(raw);
  const span = full.end - full.start;
  for (const f of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85, 0.98]) {
    const t = full.start + span * f;
    const partial = prepare(upTo(raw, t));
    partial.totalLaps = full.totalLaps;
    const clean = (a) => JSON.stringify({ ...a, me: null }, (k, v) => (v === Infinity ? 'inf' : v));
    for (const num of [16, 1, 44, 87]) {
      assert.equal(clean(analyse(partial, snapshot(partial, t), num)), clean(analyse(full, snapshot(full, t), num)), `f=${f} n=${num}`);
    }
  }
});
