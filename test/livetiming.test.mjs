import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';
import { Recording, gapValue, lapSeconds, parsePy, readRecording, resolveStints, RECORDINGS_DIR } from '../livetiming.mjs';
import { prepare, snapshot } from '../public/model.js';

// Una riga come le scrive Fast-F1: lista Python con topic, dati e istante.
const py = (v) => {
  if (v === null) return 'None';
  if (v === true) return 'True';
  if (v === false) return 'False';
  if (typeof v === 'number') return String(v);
  if (typeof v === 'string') return `'${v.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (Array.isArray(v)) return `[${v.map(py).join(', ')}]`;
  return `{${Object.entries(v).map(([k, x]) => `${py(k)}: ${py(x)}`).join(', ')}}`;
};
const delta = (topic, data, iso) => py([topic, data, iso]);
const keyframe = (topic, data) => py([topic, JSON.stringify({ ...data, _kf: true }), '']);
const T = (s) => `2026-11-22T04:${s}Z`;

test('legge i letterali Python, comprese stringhe con escape e JSON annidato', () => {
  assert.deepEqual(parsePy("{'a': True, 'b': [1, -2.5, None], 'c': 'l\\'ok', 'd': \"x'y\"}"), {
    a: true,
    b: [1, -2.5, null],
    c: "l'ok",
    d: "x'y",
  });
  const line = py(['SessionInfo', JSON.stringify({ Meeting: { Name: 'São Paulo \\u00e3' } }), '']);
  const [, json] = parsePy(line);
  assert.equal(JSON.parse(json).Meeting.Name, 'São Paulo \\u00e3');
  assert.equal(parsePy("'\\xe3\\u00e9'"), 'ãé');
  assert.throws(() => parsePy("{'a': "));
});

test('tempi e distacchi nel formato di OpenF1', () => {
  assert.equal(lapSeconds('1:21.388'), 81.388);
  assert.equal(lapSeconds('59.5'), 59.5);
  assert.equal(lapSeconds(''), null);
  assert.equal(gapValue('+1.234'), 1.234);
  assert.equal(gapValue('LAP 23'), 0);
  assert.equal(gapValue('1 L'), '+1 LAP');
  assert.equal(gapValue('2L'), '+2 LAPS');
  assert.equal(gapValue(''), null);
});

function race() {
  const rec = new Recording();
  const lines = [
    keyframe('Heartbeat', { Utc: T('00:00.000') }),
    keyframe('SessionInfo', { Meeting: { Name: 'Las Vegas Grand Prix', Location: 'Las Vegas' }, Name: 'Race', Type: 'Race', StartDate: '2026-11-21T20:00:00', EndDate: '2026-11-21T22:00:00', GmtOffset: '-08:00:00', Path: '2026/vegas/race/' }),
    keyframe('DriverList', { 16: { Tla: 'LEC', TeamName: 'Ferrari', TeamColour: 'E80020', FullName: 'Charles LECLERC' }, 44: { Tla: 'HAM', TeamName: 'Ferrari', TeamColour: 'E80020', FullName: 'Lewis HAMILTON' } }),
    keyframe('SessionStatus', { Status: 'Inactive' }),
    keyframe('LapCount', { CurrentLap: 1, TotalLaps: 3 }),
    keyframe('TimingAppData', { Lines: { 16: { Stints: [{ Compound: 'MEDIUM', StartLaps: 0, TotalLaps: 0 }] }, 44: { Stints: [{ Compound: 'HARD', StartLaps: 0, TotalLaps: 0 }] } } }),
    keyframe('TimingData', { Lines: { 16: { NumberOfLaps: 0, Position: '1', InPit: false, PitOut: false }, 44: { NumberOfLaps: 0, Position: '2', InPit: false, PitOut: false } } }),
    delta('SessionStatus', { Status: 'Started' }, T('01:00.000')),
    delta('TimingData', { Lines: { 16: { NumberOfLaps: 1, LastLapTime: { Value: '1:40.000' }, GapToLeader: 'LAP 1', IntervalToPositionAhead: { Value: 'LAP 1' } } } }, T('02:40.000')),
    delta('TimingData', { Lines: { 44: { NumberOfLaps: 1, LastLapTime: { Value: '1:41.000' }, GapToLeader: '+1.000', IntervalToPositionAhead: { Value: '+1.000' } } } }, T('02:41.000')),
    // HAM entra ai box a fine giro 2 ed esce sul giro 3.
    delta('TimingData', { Lines: { 44: { InPit: true, NumberOfPitStops: 1 } } }, T('04:15.000')),
    delta('TimingData', { Lines: { 16: { NumberOfLaps: 2, LastLapTime: { Value: '1:35.000' } } } }, T('04:15.000')),
    delta('TimingData', { Lines: { 44: { NumberOfLaps: 2, LastLapTime: { Value: '1:50.000' } } } }, T('04:31.000')),
    delta('TimingAppData', { Lines: { 44: { Stints: { 1: { Compound: 'SOFT', StartLaps: 0, TotalLaps: 0 } } } } }, T('04:33.000')),
    delta('TimingData', { Lines: { 44: { InPit: false, PitOut: true } } }, T('04:39.000')),
    delta('RaceControlMessages', { Messages: { 3: { Utc: '2026-11-22T04:05:00', Lap: 3, Category: 'Flag', Flag: 'YELLOW', Scope: 'Sector', Message: 'YELLOW IN TRACK SECTOR 2' } } }, T('05:00.100')),
    delta('RaceControlMessages', { Messages: { 4: { Utc: '2026-11-22T04:05:50', Lap: 3, Category: 'Flag', Flag: 'CHEQUERED', Message: 'CHEQUERED FLAG' } } }, T('05:50.100')),
    delta('TimingData', { Lines: { 16: { NumberOfLaps: 3, LastLapTime: { Value: '1:36.000' } } } }, T('05:51.000')),
    delta('TimingData', { Lines: { 44: { NumberOfLaps: 3, LastLapTime: { Value: '1:30.000' }, InPit: true } } }, T('06:01.000')),
    // Ricollegamento: lo stesso stato arriva di nuovo come keyframe e non deve creare doppioni.
    keyframe('Heartbeat', { Utc: T('07:00.000') }),
    keyframe('RaceControlMessages', { Messages: [{ Utc: '2026-11-22T04:05:00', Lap: 3, Category: 'Flag', Flag: 'YELLOW', Scope: 'Sector', Message: 'YELLOW IN TRACK SECTOR 2' }] }),
    keyframe('TimingData', { Lines: { 16: { NumberOfLaps: 3, LastLapTime: { Value: '1:36.000' }, Position: '1' }, 44: { NumberOfLaps: 3, Position: '2' } } }),
  ];
  for (const l of lines) rec.line(l);
  return rec;
}

test('ricostruisce giri, soste e gomme di una gara', () => {
  const b = race().bundle('rec:test');
  assert.equal(b.session.total_laps, 3);
  assert.equal(b.session.date_start, '2026-11-22T04:00:00.000Z');
  assert.deepEqual(
    b.laps.filter((l) => l.driver_number === 16).map((l) => [l.lap_number, l.date_start.slice(14, 23), l.lap_duration]),
    [
      [1, '01:00.000', 100],
      [2, '02:40.000', 95],
      [3, '04:15.000', 96],
    ],
  );
  const ham = b.laps.filter((l) => l.driver_number === 44);
  assert.deepEqual(ham.map((l) => l.lap_number), [1, 2, 3], 'nessun giro dopo la bandiera a scacchi');
  assert.equal(ham.find((l) => l.lap_number === 3).is_pit_out_lap, true);
  assert.deepEqual(b.pit, [{ date: '2026-11-22T04:04:15.000Z', driver_number: 44, lap_number: 2, lane_duration: 24, pit_duration: 24, stop_duration: null }]);
  assert.deepEqual(
    b.stints.filter((s) => s.driver_number === 44).map((s) => [s.stint_number, s.lap_start, s.lap_end, s.compound]),
    [
      [1, 1, 2, 'HARD'],
      [2, 3, null, 'SOFT'],
    ],
  );
  const leader = b.intervals.find((r) => r.driver_number === 16);
  assert.equal(leader.gap_to_leader, 0);
  assert.equal(b.race_control.filter((r) => r.message === 'YELLOW IN TRACK SECTOR 2').length, 1);
  assert.ok(b.race_control.some((r) => r.message === 'SESSION STARTED' && r.date === '2026-11-22T04:01:00.000Z'));
  assert.equal(b.team_radio.length, 0);

  const S = prepare(b);
  assert.equal(S.totalLaps, 3);
  assert.equal(snapshot(S, Date.parse(T('04:20.000'))).byNum.get(44).stops, 1);
});

test('una registrazione partita a gara in corso usa la cronologia della sessione', () => {
  const rec = new Recording();
  const lines = [
    keyframe('Heartbeat', { Utc: T('30:00.000') }),
    keyframe('SessionInfo', { Name: 'Race', Type: 'Race', StartDate: '2026-11-21T20:00:00', GmtOffset: '-08:00:00', Path: 'p/' }),
    keyframe('DriverList', { 1: { Tla: 'NOR', TeamName: 'McLaren', TeamColour: 'F47600' } }),
    keyframe('SessionStatus', { Status: 'Started' }),
    keyframe('TimingAppData', { Lines: { 1: { Stints: [{ Compound: 'MEDIUM', StartLaps: 0, TotalLaps: 15 }, { Compound: 'HARD', StartLaps: 0, TotalLaps: 4 }] } } }),
    keyframe('SessionData', { StatusSeries: [{ Utc: '2026-11-21T03:00:00Z', SessionStatus: 'Started' }, { Utc: '2026-11-22T04:01:00.000Z', SessionStatus: 'Started' }] }),
    keyframe('TimingData', { Lines: { 1: { NumberOfLaps: 18, Position: '1', InPit: false } } }),
    delta('TimingData', { Lines: { 1: { NumberOfLaps: 19, LastLapTime: { Value: '1:35.000' } } } }, T('30:20.000')),
  ];
  for (const l of lines) rec.line(l);
  const b = rec.bundle('rec:late');
  assert.equal(b.session.started, '2026-11-22T04:01:00.000Z', 'ignora la sessione del giorno prima');
  assert.equal(b.session.recorded_from, '2026-11-22T04:30:20.000Z');
  assert.deepEqual(b.stints.map((s) => [s.lap_start, s.compound]), [[1, 'MEDIUM'], [16, 'HARD']]);
  assert.deepEqual(b.laps.map((l) => l.lap_number), [19, 20]);
  assert.equal(b.laps[0].lap_duration, 95);
});

test('ricava all\'indietro le gomme montate prima della registrazione', () => {
  const tyres = [{ TotalLaps: 20, StartLaps: 0 }, { TotalLaps: 25, StartLaps: 2 }, { TotalLaps: 5, StartLaps: 0 }];
  assert.deepEqual(resolveStints(tyres, [1, null, null], 48), [1, 21, 44]);
  assert.deepEqual(resolveStints(tyres, [1, 22, null], 48), [1, 22, 44]);
});

test('la telemetria compressa diventa colonne, senza i valori assenti', () => {
  const rec = race();
  const payload = (utc, ch) => deflateRawSync(JSON.stringify({ Entries: [{ Utc: utc, Cars: { 16: { Channels: ch } } }] })).toString('base64');
  rec.line(delta('CarData.z', payload('2026-11-22T04:03:00.100Z', { 0: 11000, 2: 300, 3: 8, 4: 100, 5: 0 }), T('03:00.300')));
  rec.line(delta('CarData.z', payload('2026-11-22T04:03:00.400Z', { 0: 11000, 2: 301, 3: 8, 4: 104, 5: 0 }), T('03:00.600')));
  rec.line(delta('CarData.z', payload('2026-11-22T04:03:00.700Z', { 0: 10500, 2: 250, 3: 7, 4: 0, 5: 100 }), T('03:00.900')));
  assert.deepEqual(rec.car(16), {
    t: [Date.parse('2026-11-22T04:03:00.100Z'), Date.parse('2026-11-22T04:03:00.700Z')],
    speed: [300, 250],
    throttle: [100, 0],
    brake: [0, 100],
    gear: [8, 7],
    rpm: [11000, 10500],
  });
});

test('legge il file un pezzo alla volta e aspetta le righe incomplete', async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'muretto-'));
  const file = path.join(dir, '2026-11-22_Las_Vegas_Grand_Prix_Race.txt');
  const lines = race().constructor === Recording ? null : null;
  void lines;
  const all = [
    keyframe('Heartbeat', { Utc: T('00:00.000') }),
    keyframe('DriverList', { 16: { Tla: 'LEC', TeamName: 'Ferrari', TeamColour: 'E80020' } }),
    keyframe('TimingData', { Lines: { 16: { NumberOfLaps: 0, Position: '1', InPit: false } } }),
    delta('SessionStatus', { Status: 'Started' }, T('01:00.000')),
    delta('TimingData', { Lines: { 16: { NumberOfLaps: 1, LastLapTime: { Value: '1:40.000' } } } }, T('02:40.000')),
  ];
  const text = `${all.join('\n')}\n`;
  const cut = text.lastIndexOf("['TimingData'") + 20;
  writeFileSync(file, text.slice(0, cut));
  const id = '2026-11-22_Las_Vegas_Grand_Prix_Race';
  let entry = await readRecording(id, dir);
  assert.deepEqual(entry.rec.bundle('x').laps.map((l) => l.lap_duration), [null], 'riga a metà: il giro 1 non è ancora finito');
  appendFileSync(file, text.slice(cut));
  entry = await readRecording(id, dir);
  assert.deepEqual(entry.rec.bundle('x').laps.map((l) => [l.lap_number, l.lap_duration]), [[1, 100], [2, null]]);
  assert.equal(await readRecording('../../etc/passwd', dir), null, 'solo file della cartella delle registrazioni');
});

// Confronto con OpenF1 sulla gara del Messico 2026, se registrazione e cache sono presenti.
const MEXICO = '2026-11-01_Mexico_City_Grand_Prix_Race';
const CACHE = new URL('../data/11404/', import.meta.url);
const haveMexico = existsSync(path.join(RECORDINGS_DIR, `${MEXICO}.txt`)) && existsSync(new URL('laps.json', CACHE));
test('Messico 2026: stessi giri e stesso ordine d\'arrivo di OpenF1', { skip: !haveMexico && 'registrazione o cache assenti' }, async () => {
  const b = (await readRecording(MEXICO)).rec.bundle('rec:mex');
  const read = (n) => JSON.parse(readFileSync(new URL(`${n}.json`, CACHE)));
  const laps = new Map(read('laps').map((l) => [`${l.driver_number}|${l.lap_number}`, l.lap_duration]));
  let same = 0;
  let both = 0;
  for (const l of b.laps) {
    const o = laps.get(`${l.driver_number}|${l.lap_number}`);
    if (o == null || l.lap_duration == null) continue;
    both++;
    if (Math.abs(o - l.lap_duration) < 0.002) same++;
  }
  assert.ok(both > 1000 && same / both > 0.99, `${same} giri uguali su ${both}`);
  const finalOrder = (rows) => {
    const m = new Map();
    for (const r of [...rows].sort((a, x) => Date.parse(a.date) - Date.parse(x.date))) m.set(r.driver_number, r.position);
    return [...m].sort((a, x) => a[1] - x[1]).map((x) => x[0]);
  };
  assert.deepEqual(finalOrder(b.position), finalOrder(read('position')));
});
