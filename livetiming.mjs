// Legge le registrazioni del live timing di F1 fatte da F1Data (Fast-F1) e le traduce
// nello stesso formato di OpenF1 che usa il muretto. Il file cresce durante la sessione:
// ogni lettura riprende da dove si era fermata la precedente.
//
// Ogni riga è una lista Python: ['Topic', dati, 'istante']. I dati sono un dict Python
// (aggiornamento parziale) oppure una stringa JSON (stato completo, "keyframe", inviato
// a ogni collegamento e con istante vuoto). Gli aggiornamenti si fondono in uno stato e
// gli eventi (giri, soste, distacchi…) nascono solo quando un valore cambia, così i
// keyframe ripetuti a ogni ricollegamento non creano doppioni.
import { open, readdir, stat } from 'node:fs/promises';
import { inflateRawSync } from 'node:zlib';
import os from 'node:os';
import path from 'node:path';

export const RECORDINGS_DIR =
  process.env.F1DATA_RECORDINGS ?? path.join(os.homedir(), 'Desktop/F1Data/live_dashboard/recordings');

const RADIO_BASE = 'https://livetiming.formula1.com/static/';
const RACE_FILE = /_(Race|Sprint)\.txt$/;
const LIVE_IDLE_MS = 3 * 60e3; // file fermo da più di così: la registrazione non è in corso
const SESSION_MARGIN_MS = 2 * 3600e3; // i keyframe portano anche messaggi delle sessioni precedenti
const LAP_TIME_MATCH_MS = 15e3;
const LATE_LAP_MS = 3e3; // giro chiuso in ritardo (buco nella registrazione): vale il tempo ufficiale
const STATUS_MESSAGES = { Started: 'SESSION STARTED', Aborted: 'SESSION ABORTED', Finished: 'SESSION FINISHED' };
const CHUNK = 8 * 1024 * 1024;
const FINISHED = new Set(['Finished', 'Finalised', 'Ends']);
// Topic che il muretto non usa: si scartano prima di leggerli.
const STATUS_DEDUP_MS = 10e3;
const SKIP = ['Position.z', 'TopThree', 'TimingStats', 'ContentStreams', 'AudioStreams', 'ExtrapolatedClock', 'DriverRaceInfo'].map(
  (t) => `['${t}'`,
);

// --- Letterali Python ---------------------------------------------------------

export function parsePy(src) {
  let i = 0;
  const fail = () => {
    throw new SyntaxError(`Letterale Python non valido alla posizione ${i}`);
  };
  const ws = () => {
    while (i < src.length) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) i++;
      else break;
    }
  };
  const expect = (ch) => {
    ws();
    if (src[i] !== ch) fail();
    i++;
  };
  const NUMBER = /-?\d+(\.\d+)?([eE][+-]?\d+)?/y;

  function string(q) {
    i++;
    let out = '';
    let nextQuote = -2;
    let nextSlash = -2;
    for (;;) {
      if (nextQuote < i) nextQuote = src.indexOf(q, i);
      if (nextSlash !== -1 && nextSlash < i) nextSlash = src.indexOf('\\', i);
      if (nextQuote === -1) fail();
      if (nextSlash === -1 || nextQuote < nextSlash) {
        out += src.slice(i, nextQuote);
        i = nextQuote + 1;
        return out;
      }
      out += src.slice(i, nextSlash);
      const e = src[nextSlash + 1];
      i = nextSlash + 2;
      if (e === 'n') out += '\n';
      else if (e === 't') out += '\t';
      else if (e === 'r') out += '\r';
      else if (e === 'x' || e === 'u' || e === 'U') {
        const len = e === 'x' ? 2 : e === 'u' ? 4 : 8;
        out += String.fromCodePoint(parseInt(src.slice(i, i + len), 16));
        i += len;
      } else if (e === '\\' || e === "'" || e === '"') out += e;
      else out += `\\${e}`;
    }
  }

  function value() {
    ws();
    const c = src[i];
    if (c === '{' || c === '[') {
      const dict = c === '{';
      const close = dict ? '}' : ']';
      const out = dict ? {} : [];
      i++;
      ws();
      if (src[i] === close) {
        i++;
        return out;
      }
      for (;;) {
        if (dict) {
          const key = value();
          expect(':');
          out[key] = value();
        } else {
          out.push(value());
        }
        ws();
        if (src[i] === ',') {
          i++;
          ws();
          if (src[i] === close) {
            i++;
            return out;
          }
          continue;
        }
        expect(close);
        return out;
      }
    }
    if (c === "'" || c === '"') return string(c);
    if (src.startsWith('True', i)) return (i += 4), true;
    if (src.startsWith('False', i)) return (i += 5), false;
    if (src.startsWith('None', i)) return (i += 4), null;
    NUMBER.lastIndex = i;
    const m = NUMBER.exec(src);
    if (!m) fail();
    i += m[0].length;
    return Number(m[0]);
  }

  const out = value();
  ws();
  if (i !== src.length) fail();
  return out;
}

// --- Utilità -------------------------------------------------------------------

// Gli istanti senza fuso (messaggi di direzione gara) sono in UTC.
export function toMs(s) {
  if (!s) return null;
  const v = Date.parse(/[zZ]$|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  return Number.isFinite(v) ? v : null;
}

const iso = (t) => (t == null ? null : new Date(t).toISOString());

function merge(target, src) {
  for (const [k, v] of Object.entries(src)) {
    if (k === '_kf') continue;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      if (!target[k] || typeof target[k] !== 'object') target[k] = {};
      merge(target[k], v);
    } else {
      target[k] = v;
    }
  }
  return target;
}

// Le liste arrivano come array nei keyframe e come {"indice": …} negli aggiornamenti.
const list = (x) => (Array.isArray(x) ? x.filter(Boolean) : x && typeof x === 'object' ? Object.keys(x).sort((a, b) => a - b).map((k) => x[k]) : []);
const count = (x) => (Array.isArray(x) ? x.length : x && typeof x === 'object' ? Object.keys(x).length : 0);

export function lapSeconds(s) {
  if (typeof s !== 'string' || !s.trim()) return null;
  const parts = s.trim().split(':').map(Number);
  if (parts.some((p) => !Number.isFinite(p))) return null;
  return parts.reduce((acc, p) => acc * 60 + p, 0);
}

// "+1.234" → 1.234; "LAP 12" (il leader) → 0; "1 L" → "+1 LAP", come in OpenF1.
export function gapValue(s) {
  if (s == null || s === '') return null;
  if (typeof s === 'number') return s;
  if (/^LAP/i.test(s)) return 0;
  const lapped = s.match(/(\d+)\s*L/i);
  if (lapped) return `+${lapped[1]} LAP${lapped[1] === '1' ? '' : 'S'}`;
  const v = Number(s.replace('+', ''));
  return Number.isFinite(v) ? v : null;
}

function gmtOffsetMs(s) {
  const m = /^(-)?(\d+):(\d+)/.exec(s ?? '');
  if (!m) return 0;
  return (m[1] ? -1 : 1) * (Number(m[2]) * 3600e3 + Number(m[3]) * 60e3);
}

// --- Ricostruzione della sessione ----------------------------------------------

export class Recording {
  constructor() {
    this.t = null; // istante dell'ultimo messaggio
    this.info = {};
    this.totalLaps = null;
    this.currentLap = null;
    this.status = null;
    this.statusEvents = [];
    this.dataFrom = null;
    this.started = null;
    this.finished = null;
    this.chequered = null;
    this.driverInfo = {};
    this.timing = {};
    this.app = {};
    this.drivers = new Map();
    this.pit = [];
    this.intervals = [];
    this.position = [];
    this.weather = [];
    this.rc = new Map();
    this.radio = new Map();
    this.cars = new Map();
  }

  driver(num) {
    if (!this.drivers.has(num)) this.drivers.set(num, { laps: new Map(), stintStart: [], pitOpen: null, pending: null });
    return this.drivers.get(num);
  }

  lap(d, n) {
    if (!d.laps.has(n)) d.laps.set(n, { n, start: null, end: null, dur: null, out: false });
    return d.laps.get(n);
  }

  over(t) {
    return this.chequered != null && t >= this.chequered;
  }

  line(text) {
    if (!text.startsWith("['")) return;
    for (const prefix of SKIP) if (text.startsWith(prefix)) return;
    let topic;
    let raw;
    let ts;
    try {
      [topic, raw, ts] = parsePy(text);
    } catch {
      return; // riga troncata o illeggibile: si salta
    }
    const at = toMs(ts);
    if (at != null) {
      this.t = at;
      this.dataFrom ??= at;
    }

    if (topic === 'CarData.z') return this.carData(raw);
    let data = raw;
    if (typeof raw === 'string') {
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
    }
    if (!data || typeof data !== 'object') return;
    // I keyframe non hanno istante: vale quello del loro Heartbeat.
    if (topic === 'Heartbeat') {
      if (at == null) this.t = toMs(data.Utc) ?? this.t;
      return;
    }
    const t = this.t;
    if (t == null) return;

    switch (topic) {
      case 'SessionInfo':
        merge(this.info, data);
        break;
      case 'SessionStatus':
        // Il keyframe dice solo lo stato attuale; quando è cambiato lo dice SessionData.
        if (at == null) this.status ??= data.Status;
        else this.sessionStatus(data.Status, t);
        break;
      case 'SessionData':
        for (const e of list(data.StatusSeries)) if (e?.SessionStatus) this.sessionStatus(e.SessionStatus, toMs(e.Utc));
        break;
      case 'LapCount':
        if (data.TotalLaps) this.totalLaps = data.TotalLaps;
        if (data.CurrentLap) this.currentLap = data.CurrentLap;
        break;
      case 'DriverList':
        for (const [num, d] of Object.entries(data)) if (/^\d+$/.test(num) && d && typeof d === 'object') merge((this.driverInfo[num] ??= {}), d);
        break;
      case 'TimingData':
        for (const [num, upd] of Object.entries(data.Lines ?? {})) this.timingLine(Number(num), upd, t);
        break;
      case 'TimingAppData':
        for (const [num, upd] of Object.entries(data.Lines ?? {})) this.appLine(Number(num), upd);
        break;
      case 'RaceControlMessages':
        for (const m of list(data.Messages)) this.raceControl(m);
        break;
      case 'TeamRadio':
        for (const c of list(data.Captures)) {
          if (c?.Path && !this.radio.has(c.Path)) this.radio.set(c.Path, { t: toMs(c.Utc), num: Number(c.RacingNumber), path: c.Path });
        }
        break;
      case 'WeatherData':
        this.weatherRow(data, t);
        break;
      default:
    }
  }

  // Gli stessi cambi arrivano da SessionStatus e da SessionData: si tiene il primo.
  sessionStatus(status, t) {
    if (!status || t == null) return;
    // SessionData porta anche gli stati delle sessioni precedenti del weekend.
    if (this.startUtc != null && t < this.startUtc - SESSION_MARGIN_MS) return;
    if (this.statusEvents.some((e) => e.status === status && Math.abs(e.t - t) < STATUS_DEDUP_MS)) return;
    this.statusEvents.push({ status, t });
    const latest = this.statusEvents.reduce((a, b) => (b.t >= a.t ? b : a));
    this.status = latest.status;
    // OpenF1 ricava questi messaggi dallo stato della sessione: il modello li usa per la bandiera rossa.
    if (STATUS_MESSAGES[status] && (status === 'Started' || this.started != null)) {
      const message = STATUS_MESSAGES[status];
      this.rc.set(`${t}|${message}`, { t, lap: this.currentLap, category: 'SessionStatus', flag: null, scope: null, sector: null, num: null, message });
    }
    if (status === 'Started' && (this.started == null || t < this.started)) {
      this.started = t;
      for (const [num, d] of this.drivers) {
        if (!(this.timing[num]?.NumberOfLaps > 0)) this.lap(d, 1).start ??= t;
      }
    }
    if (FINISHED.has(status) && this.started != null && this.finished == null) this.finished = t;
    if (FINISHED.has(status) && this.started != null) this.chequered ??= t;
  }

  timingLine(num, upd, t) {
    const st = (this.timing[num] ??= {});
    const before = pick(st);
    merge(st, upd);
    const after = pick(st);
    const d = this.driver(num);
    const live = this.started != null || this.status === 'Started';

    if (this.started != null && !d.laps.has(1) && !(after.laps > 0)) this.lap(d, 1).start = this.started;

    if (after.laps != null && after.laps !== before.laps) {
      if (before.laps == null || after.laps < before.laps) {
        // Primo dato (registrazione partita a gara in corso) o correzione: si riparte da qui.
        if (live && after.laps > 0) this.lap(d, after.laps + 1).start ??= t;
      } else {
        for (let n = before.laps + 1; n <= after.laps; n++) {
          if (n === after.laps) this.lap(d, n).end = t;
          else this.lap(d, n);
        }
        const done = this.lap(d, after.laps);
        if (d.pending && t - d.pending.t < LAP_TIME_MATCH_MS) {
          done.dur ??= d.pending.dur;
          d.pending = null;
        }
        if (after.last && after.last !== before.last) done.dur ??= lapSeconds(after.last);
        const end = this.lapEnd(d, done, t);
        done.end = end;
        const finished = this.over(t) || (this.totalLaps != null && after.laps >= this.totalLaps);
        if (live && !finished) this.lap(d, after.laps + 1).start = end;
      }
    }

    // Tempo arrivato da solo, senza il cambio del numero di giri (quel caso è gestito sopra).
    if (after.last && after.last !== before.last && after.laps === before.laps) {
      const dur = lapSeconds(after.last);
      const lap = after.laps ? d.laps.get(after.laps) : null;
      if (dur != null && lap && lap.dur == null && lap.end != null && t - lap.end < LAP_TIME_MATCH_MS) lap.dur = dur;
      else if (dur != null && before.laps != null) d.pending = { dur, t };
    }

    if (live && after.pitOut && !before.pitOut && before.pitOut !== undefined) {
      this.lap(d, (after.laps ?? 0) + 1).out = true;
    }

    if (after.inPit && before.inPit === false && live && !this.over(t)) {
      d.pitOpen = { t, num, lap: (after.laps ?? 0) + 1, lane: null, used: false };
      this.pit.push(d.pitOpen);
    } else if (!after.inPit && before.inPit && d.pitOpen) {
      d.pitOpen.lane = (t - d.pitOpen.t) / 1000;
      d.pitOpen = null;
    }

    if (live && (after.gap !== before.gap || after.int !== before.int)) {
      this.intervals.push({ t, num, gap: gapValue(after.gap), int: gapValue(after.int) });
    }
    if (after.pos && after.pos !== before.pos) this.position.push({ t, num, pos: Number(after.pos) });
  }

  // Di norma il giro finisce quando arriva il messaggio, come in OpenF1. Se il messaggio
  // arriva molto dopo (registrazione ricollegata), la fine si ricava dal tempo ufficiale.
  lapEnd(d, lap, t) {
    const start = lap.start ?? d.laps.get(lap.n - 1)?.end ?? null;
    if (start == null || lap.dur == null) return t;
    const official = start + lap.dur * 1000;
    return t - official > LATE_LAP_MS && official < t ? official : t;
  }

  appLine(num, upd) {
    const st = (this.app[num] ??= {});
    const before = count(st.Stints);
    merge(st, upd);
    const stints = list(st.Stints);
    const d = this.driver(num);
    for (let i = before; i < stints.length; i++) if (d.stintStart[i] == null) d.stintStart[i] = this.stintStartLap(num, d, i);
  }

  // Giro di partenza di una gomma nuova: quello dopo la sosta che l'ha montata.
  // Se la sosta non è stata registrata (gomme montate prima dell'inizio della registrazione)
  // resta null e si ricava in uscita dai giri fatti su ogni gomma.
  stintStartLap(num, d, i) {
    if (i === 0) return 1;
    const pit = this.pit.filter((p) => p.num === num && !p.used).at(-1);
    if (!pit) return null;
    pit.used = true;
    return pit.lap + 1;
  }

  raceControl(m) {
    if (!m?.Message) return;
    const key = `${m.Utc}|${m.Message}`;
    if (this.rc.has(key)) return;
    const t = toMs(m.Utc);
    this.rc.set(key, {
      t,
      lap: m.Lap ?? null,
      category: m.Category ?? null,
      flag: m.Flag ?? null,
      scope: m.Scope ?? null,
      sector: m.Sector ?? null,
      num: m.RacingNumber != null ? Number(m.RacingNumber) : null,
      message: m.Message,
    });
    if (m.Flag === 'CHEQUERED' && this.started != null && t >= this.started) this.chequered ??= t;
  }

  weatherRow(data, t) {
    const num = (k) => (data[k] == null || data[k] === '' ? null : Number(data[k]));
    const row = {
      t,
      air: num('AirTemp'),
      track: num('TrackTemp'),
      humidity: num('Humidity'),
      pressure: num('Pressure'),
      rain: num('Rainfall'),
      windDir: num('WindDirection'),
      wind: num('WindSpeed'),
    };
    const prev = this.weather.at(-1);
    if (prev && ['air', 'track', 'humidity', 'pressure', 'rain', 'windDir', 'wind'].every((k) => prev[k] === row[k])) return;
    if (row.air == null || row.track == null) return;
    this.weather.push(row);
  }

  // Canali: 0 giri motore, 2 velocità, 3 marcia, 4 acceleratore, 5 freno.
  carData(raw) {
    if (typeof raw !== 'string') return;
    let data;
    try {
      data = JSON.parse(inflateRawSync(Buffer.from(raw, 'base64')).toString('utf8'));
    } catch {
      return;
    }
    for (const entry of data.Entries ?? []) {
      const t = toMs(entry.Utc);
      if (t == null) continue;
      for (const [num, car] of Object.entries(entry.Cars ?? {})) {
        const ch = car?.Channels;
        if (!ch || ch[4] > 100 || ch[5] > 100) continue;
        let c = this.cars.get(Number(num));
        if (!c) this.cars.set(Number(num), (c = { t: [], speed: [], throttle: [], brake: [], gear: [], rpm: [] }));
        if (c.t.length && t <= c.t.at(-1)) continue;
        c.t.push(t);
        c.speed.push(ch[2]);
        c.throttle.push(ch[4]);
        c.brake.push(ch[5]);
        c.gear.push(ch[3]);
        c.rpm.push(ch[0]);
      }
    }
  }

  // --- Uscita in formato OpenF1 ---

  get startUtc() {
    const s = toMs(this.info.StartDate);
    return s == null ? null : s - gmtOffsetMs(this.info.GmtOffset);
  }

  get endUtc() {
    const s = toMs(this.info.EndDate);
    return s == null ? null : s - gmtOffsetMs(this.info.GmtOffset);
  }

  session(key) {
    const meeting = this.info.Meeting ?? {};
    return {
      session_key: key,
      session_name: this.info.Name ?? null,
      session_type: this.info.Type ?? null,
      meeting_name: meeting.Name ?? null,
      location: meeting.Location ?? null,
      country_name: meeting.Country?.Name ?? null,
      year: this.startUtc ? new Date(this.startUtc).getUTCFullYear() : null,
      date_start: iso(this.startUtc),
      date_end: iso(this.endUtc),
      total_laps: this.totalLaps,
      status: this.status,
      started: iso(this.started),
      finished: iso(this.finished),
      recorded_from: iso(this.dataFrom),
      recorded_until: iso(this.t),
      source: 'F1Data',
    };
  }

  bundle(key) {
    const from = (this.startUtc ?? this.started ?? 0) - SESSION_MARGIN_MS;
    const drivers = Object.entries(this.driverInfo)
      .filter(([, d]) => d.Tla)
      .map(([num, d]) => ({
        driver_number: Number(num),
        broadcast_name: d.BroadcastName ?? null,
        full_name: d.FullName ?? `${d.FirstName ?? ''} ${d.LastName ?? ''}`.trim(),
        name_acronym: d.Tla,
        team_name: d.TeamName ?? null,
        team_colour: d.TeamColour ?? '888888',
        first_name: d.FirstName ?? null,
        last_name: d.LastName ?? null,
      }));

    const laps = [];
    const stints = [];
    for (const [num, d] of this.drivers) {
      const sorted = [...d.laps.values()].sort((a, b) => a.n - b.n);
      for (const [i, lap] of sorted.entries()) {
        if (lap.start == null && lap.end == null) continue;
        // Giro aperto e mai chiuso, seguito da giri non consecutivi: è il buco prima della registrazione.
        const orphan = lap.end == null && lap.dur == null && i < sorted.length - 1 && !d.laps.has(lap.n + 1);
        if (orphan) continue;
        const start = lap.start ?? d.laps.get(lap.n - 1)?.end ?? (lap.end != null && lap.dur != null ? lap.end - lap.dur * 1000 : null);
        laps.push({
          driver_number: num,
          lap_number: lap.n,
          date_start: iso(start),
          lap_duration: lap.dur,
          is_pit_out_lap: lap.out,
        });
      }
      const tyres = list(this.app[num]?.Stints);
      const starts = resolveStints(tyres, d.stintStart, this.timing[num]?.NumberOfLaps ?? 0);
      tyres.forEach((s, i) => {
        const lapStart = starts[i];
        const next = starts[i + 1];
        stints.push({
          driver_number: num,
          stint_number: i + 1,
          lap_start: lapStart,
          lap_end: next != null ? next - 1 : null,
          compound: typeof s.Compound === 'string' && s.Compound !== 'UNKNOWN' ? s.Compound.toUpperCase() : null,
          tyre_age_at_start: Number(s.StartLaps ?? 0),
        });
      });
    }

    return {
      session: this.session(key),
      drivers,
      laps,
      stints,
      pit: this.pit.map((p) => ({ date: iso(p.t), driver_number: p.num, lap_number: p.lap, lane_duration: p.lane, pit_duration: p.lane, stop_duration: null })),
      intervals: this.intervals.map((r) => ({ date: iso(r.t), driver_number: r.num, gap_to_leader: r.gap, interval: r.int })),
      position: this.position.map((r) => ({ date: iso(r.t), driver_number: r.num, position: r.pos })),
      weather: this.weather.map((w) => ({
        date: iso(w.t),
        air_temperature: w.air,
        track_temperature: w.track,
        humidity: w.humidity,
        pressure: w.pressure,
        rainfall: w.rain,
        wind_direction: w.windDir,
        wind_speed: w.wind,
      })),
      race_control: [...this.rc.values()]
        .filter((r) => r.t != null && r.t >= from)
        .sort((a, b) => a.t - b.t)
        .map((r) => ({
          date: iso(r.t),
          lap_number: r.lap,
          category: r.category,
          flag: r.flag,
          scope: r.scope,
          sector: r.sector,
          driver_number: r.num,
          message: r.message,
        })),
      team_radio: this.info.Path
        ? [...this.radio.values()]
            .filter((r) => r.t != null && r.t >= from)
            .sort((a, b) => a.t - b.t)
            .map((r) => ({ date: iso(r.t), driver_number: r.num, recording_url: `${RADIO_BASE}${this.info.Path}${r.path}` }))
        : [],
    };
  }

  car(num) {
    return this.cars.get(num) ?? { t: [], speed: [], throttle: [], brake: [], gear: [], rpm: [] };
  }
}

// Giri di partenza delle gomme non registrati: all'indietro dall'ultima, con i giri fatti su ognuna.
export function resolveStints(tyres, known, lapsDone) {
  const starts = tyres.map((_, i) => known[i] ?? null);
  const run = (s) => Math.max(Number(s?.TotalLaps ?? 0) - Number(s?.StartLaps ?? 0), 0);
  for (let i = tyres.length - 1; i >= 0; i--) {
    if (starts[i] != null) continue;
    const next = i === tyres.length - 1 ? lapsDone + 1 : starts[i + 1];
    starts[i] = Math.max(next - run(tyres[i]), 1);
  }
  starts[0] = 1;
  return starts;
}

function pick(st) {
  return {
    laps: st.NumberOfLaps,
    last: st.LastLapTime?.Value,
    inPit: st.InPit,
    pitOut: st.PitOut,
    pos: st.Position,
    gap: st.GapToLeader,
    int: st.IntervalToPositionAhead?.Value,
  };
}

// --- File su disco ---------------------------------------------------------------

const loaded = new Map(); // nome file → { rec, offset, mtime, busy }

const nfc = (s) => s.normalize('NFC');

export async function listRecordings(dir = RECORDINGS_DIR) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out = [];
  for (const name of names.filter((n) => RACE_FILE.test(n))) {
    const info = await stat(path.join(dir, name));
    if (!info.size) continue;
    const [, date, slug] = nfc(name).match(/^(\d{4}-\d{2}-\d{2})_(.+)\.txt$/) ?? [];
    if (!date) continue;
    const id = nfc(name).replace(/\.txt$/, '');
    let live = Date.now() - info.mtimeMs < LIVE_IDLE_MS;
    // Un file che cresce ancora può essere solo un ricollegamento a sessione finita.
    if (live) live = !(await readRecording(id, dir)).rec.finished;
    out.push({ id, date, title: slug.replace(/_/g, ' '), live, size: info.size, mtime: new Date(info.mtimeMs).toISOString() });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date) || b.id.localeCompare(a.id));
}

async function fileFor(id, dir) {
  let names;
  try {
    names = await readdir(dir);
  } catch {
    return null;
  }
  const name = names.find((n) => RACE_FILE.test(n) && nfc(n).replace(/\.txt$/, '') === nfc(id));
  return name ? path.join(dir, name) : null;
}

// Legge solo la parte nuova del file; l'ultima riga, se incompleta, aspetta il giro dopo.
export async function readRecording(id, dir = RECORDINGS_DIR) {
  const file = await fileFor(id, dir);
  if (!file) return null;
  let entry = loaded.get(file);
  if (!entry) loaded.set(file, (entry = { rec: new Recording(), offset: 0, mtime: 0, busy: Promise.resolve() }));
  const job = entry.busy.then(async () => {
    const info = await stat(file);
    if (info.size < entry.offset) Object.assign(entry, { rec: new Recording(), offset: 0 });
    if (info.size > entry.offset) {
      const fh = await open(file, 'r');
      try {
        const decoder = new TextDecoder('utf-8');
        let rest = Buffer.alloc(0);
        let pos = entry.offset;
        while (pos < info.size) {
          const buf = Buffer.alloc(Math.min(CHUNK, info.size - pos));
          const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
          if (!bytesRead) break;
          pos += bytesRead;
          const all = rest.length ? Buffer.concat([rest, buf.subarray(0, bytesRead)]) : buf.subarray(0, bytesRead);
          const cut = all.lastIndexOf(10);
          if (cut === -1) {
            rest = all;
            continue;
          }
          for (const text of decoder.decode(all.subarray(0, cut)).split('\n')) entry.rec.line(text);
          entry.offset = pos - (all.length - cut - 1);
          rest = all.subarray(cut + 1);
        }
      } finally {
        await fh.close();
      }
    }
    entry.mtime = info.mtimeMs;
    return entry;
  });
  entry.busy = job.catch(() => {});
  return job;
}
