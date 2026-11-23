// Modello del muretto box. Funzioni pure, usate sia dal browser sia dai test.
// Regola centrale: ogni calcolo riceve un istante `t` e usa solo ciò che era noto
// a quell'istante, così il replay non anticipa mai cosa succederà.

// Valori stimati, non misurati dai dati: tutti qui per poterli tarare.
export const ASSUMPTIONS = Object.freeze({
  fuelGainPerLap: 0.05, // s/giro guadagnati dall'alleggerimento del carburante
  defaultPitLoss: 24, // s, usato finché la gara non ha almeno 3 soste misurabili
  scLossFactor: 0.5, // quota della perdita box che resta sotto Safety Car
  vscLossFactor: 0.65, // idem sotto Virtual Safety Car
  outlapWarmupLoss: 0.5, // s persi nel giro di uscita per scaldare la gomma
  windowToleranceS: 0.75, // scarto dall'ottimo entro cui un giro è "in finestra"
});

const MIN_DEG_LAPS = 4;
const MIN_PIT_SAMPLES = 3;
const MAX_NORMAL_STOP_S = 5;
const LAP_OUTLIER_RATIO = 1.07;
const RETIRED_LAP_RATIO = 2.2;
const TRAFFIC_MARGIN_S = 1.5;
const ATTACK_RANGE_S = 1;
const CLOSING_RATE_S = 0.15;
const HIGH_DEG_S = 0.12;
const EVOLVING_TRACK_DEG_S = -0.03; // degrado così negativo = pista che migliora, non gomma
const CROSSOVER_S = 1;
const CROSSOVER_MIN_CARS = 2;

const WET = new Set(['INTERMEDIATE', 'WET']);

const ms = (s) => (s ? Date.parse(s) : null);
const isNum = (x) => typeof x === 'number' && Number.isFinite(x);

export function median(xs) {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function at(rows, t) {
  if (!rows?.length) return null;
  let lo = 0;
  let hi = rows.length - 1;
  let found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (rows[mid].t <= t) {
      found = rows[mid];
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

function groupBy(rows, key) {
  const out = new Map();
  for (const r of rows) {
    if (!out.has(r[key])) out.set(r[key], []);
    out.get(r[key]).push(r);
  }
  return out;
}

const byTime = (a, b) => a.t - b.t;

// Traduce i messaggi di direzione gara in finestre SC / VSC / bandiera rossa.
export function neutralWindows(rc) {
  const out = [];
  let cur = null;
  const close = (t) => {
    if (cur) cur.end = t;
    cur = null;
  };
  const open = (kind, t) => {
    close(t);
    cur = { kind, start: t, end: Infinity };
    out.push(cur);
  };
  for (const r of rc) {
    const m = r.msg;
    if (/RED FLAG/.test(m)) open('RED', r.t);
    else if (/^(VSC|VIRTUAL SAFETY CAR) DEPLOYED/.test(m)) open('VSC', r.t);
    else if (/^SAFETY CAR DEPLOYED/.test(m)) open('SC', r.t);
    else if (/^(VSC|VIRTUAL SAFETY CAR) ENDING/.test(m)) {
      if (cur?.kind === 'VSC') close(r.t);
    } else if (r.flag === 'CLEAR' && r.scope === 'Track') {
      // Durante la rossa arriva comunque TRACK CLEAR: chiude solo la Safety Car.
      if (cur?.kind === 'SC') close(r.t);
    } else if (/^SAFETY CAR LIGHTS ON|^SESSION STARTED/.test(m)) {
      // "RESUMPTION ORDER" e "RACE WILL RESUME" arrivano a gara ancora sospesa: non contano.
      if (cur?.kind === 'RED') close(r.t);
    } else if (r.flag === 'CHEQUERED') close(r.t);
  }
  return out;
}

export function prepare(raw) {
  const drivers = [...raw.drivers].sort((a, b) => a.driver_number - b.driver_number);

  const lapRows = raw.laps.map((l) => ({
    num: l.driver_number,
    n: l.lap_number,
    start: ms(l.date_start),
    dur: l.lap_duration ?? null,
    out: Boolean(l.is_pit_out_lap),
    end: null,
  }));
  const laps = groupBy(lapRows, 'num');
  for (const list of laps.values()) {
    list.sort((a, b) => a.n - b.n);
    list.forEach((l, i) => {
      if (l.start != null && l.dur != null) l.end = l.start + l.dur * 1000;
      else l.end = list[i + 1]?.start ?? null;
    });
  }

  const stints = groupBy(
    raw.stints.map((s) => ({
      num: s.driver_number,
      no: s.stint_number,
      compound: s.compound,
      from: s.lap_start,
      ageStart: s.tyre_age_at_start ?? 0,
    })),
    'num',
  );
  for (const list of stints.values()) list.sort((a, b) => a.from - b.from);

  const pits = raw.pit
    .map((p) => ({ num: p.driver_number, lap: p.lap_number, t: ms(p.date), lane: p.lane_duration, stop: p.stop_duration }))
    .sort(byTime);

  const intervals = groupBy(
    raw.intervals.map((i) => ({ num: i.driver_number, t: ms(i.date), gap: i.gap_to_leader, int: i.interval })).sort(byTime),
    'num',
  );
  const position = groupBy(
    raw.position.map((p) => ({ num: p.driver_number, t: ms(p.date), pos: p.position })).sort(byTime),
    'num',
  );
  const weather = raw.weather
    .map((w) => ({
      t: ms(w.date),
      air: w.air_temperature,
      track: w.track_temperature,
      rain: w.rainfall,
      wind: w.wind_speed,
      humidity: w.humidity,
    }))
    .sort(byTime);
  const rc = raw.race_control
    .map((r) => ({ t: ms(r.date), lap: r.lap_number, cat: r.category, flag: r.flag, scope: r.scope, num: r.driver_number, msg: r.message ?? '' }))
    .sort(byTime);
  const radio = raw.team_radio.map((r) => ({ t: ms(r.date), num: r.driver_number, url: r.recording_url })).sort(byTime);

  const lapStarts = lapRows.filter((l) => l.n === 1 && l.start != null).map((l) => l.start);
  const lapEnds = lapRows.filter((l) => l.end != null).map((l) => l.end);
  const start = lapStarts.length ? Math.min(...lapStarts) : ms(raw.session?.date_start);
  const end = lapEnds.length ? Math.max(...lapEnds) + 90_000 : ms(raw.session?.date_end);

  return {
    session: raw.session,
    drivers,
    tla: new Map(drivers.map((d) => [d.driver_number, d.name_acronym])),
    laps,
    stints,
    pits,
    intervals,
    position,
    weather,
    rc,
    radio,
    neutral: neutralWindows(rc),
    start,
    end,
    // Le registrazioni di F1Data conoscono i giri totali fin dal via; OpenF1 no.
    totalLaps: raw.session?.total_laps ?? lapRows.reduce((m, l) => Math.max(m, l.n), 0),
  };
}

function stintAt(S, num, lap) {
  let found = null;
  for (const s of S.stints.get(num) ?? []) if (s.from <= lap) found = s;
  return found;
}

const overlapsNeutral = (S, l) => S.neutral.some((w) => w.start < l.end && w.end > l.start);

// Giri rappresentativi del ritmo: niente primo giro, soste, neutralizzazioni, fuori soglia.
export function cleanLaps(S, num, t) {
  const inLaps = new Set(S.pits.filter((p) => p.num === num && p.t <= t).map((p) => p.lap));
  const groups = new Map();
  for (const l of S.laps.get(num) ?? []) {
    if (l.end == null || l.end > t || l.dur == null) continue;
    if (l.n === 1 || l.out || inLaps.has(l.n) || inLaps.has(l.n - 1) || overlapsNeutral(S, l)) continue;
    const no = stintAt(S, num, l.n)?.no ?? 0;
    if (!groups.has(no)) groups.set(no, []);
    groups.get(no).push(l);
  }
  const out = [];
  for (const [no, list] of groups) {
    const limit = median(list.map((l) => l.dur)) * LAP_OUTLIER_RATIO;
    for (const l of list) if (l.dur <= limit) out.push({ ...l, stint: no });
  }
  return out.sort((a, b) => a.n - b.n);
}

function statusAt(S, t) {
  if (S.rc.some((r) => r.flag === 'CHEQUERED' && r.t <= t)) return { kind: 'END', label: 'Bandiera a scacchi' };
  const w = S.neutral.find((x) => x.start <= t && x.end > t);
  if (w?.kind === 'RED') return { kind: 'RED', label: 'Bandiera rossa' };
  if (w?.kind === 'SC') return { kind: 'SC', label: 'Safety Car' };
  if (w?.kind === 'VSC') return { kind: 'VSC', label: 'Virtual SC' };
  return { kind: 'GREEN', label: 'Pista libera' };
}

export function snapshot(S, t) {
  const rows = S.drivers.map((d) => {
    const num = d.driver_number;
    let cur = null;
    let last = null;
    let best = null;
    for (const l of S.laps.get(num) ?? []) {
      if (l.start != null && l.start <= t) cur = l;
      if (l.end != null && l.end <= t && l.dur != null) {
        last = l;
        if (best == null || l.dur < best) best = l.dur;
      }
    }
    const iv = at(S.intervals.get(num), t);
    const stint = cur ? stintAt(S, num, cur.n) : null;
    return {
      num,
      tla: d.name_acronym,
      team: d.team_name,
      color: d.team_colour,
      pos: at(S.position.get(num), t)?.pos ?? null,
      lap: cur?.n ?? 0,
      lapStart: cur?.start ?? null,
      outLap: Boolean(cur?.out),
      rawGap: iv?.gap ?? null,
      interval: iv?.int ?? null,
      gap: null,
      compound: stint?.compound ?? null,
      age: stint && cur ? stint.ageStart + (cur.n - stint.from) : null,
      stintNo: stint?.no ?? null,
      lastLap: last?.dur ?? null,
      bestLap: best,
      stops: S.pits.filter((p) => p.num === num && p.t <= t).length,
      out: false,
    };
  });

  const typical = median(rows.map((r) => r.lastLap).filter(isNum)) ?? 100;
  const newest = Math.max(...rows.map((r) => r.lapStart ?? -Infinity));
  for (const r of rows) {
    r.out = newest > -Infinity && (r.lapStart == null || newest - r.lapStart > typical * 1000 * RETIRED_LAP_RATIO);
  }

  rows.sort((a, b) => a.out - b.out || (a.pos ?? 99) - (b.pos ?? 99));

  // gap_to_leader diventa testo ("+1 LAP") per i doppiati: si ricostruisce sommando gli intervalli.
  let prev = null;
  for (const r of rows) {
    if (r.out) continue;
    if (isNum(r.rawGap)) r.gap = r.rawGap;
    else if (prev != null && isNum(r.interval)) r.gap = prev + r.interval;
    if (r.gap != null) prev = r.gap;
  }

  return {
    t,
    lap: Math.max(0, ...rows.map((r) => r.lap)),
    rows,
    byNum: new Map(rows.map((r) => [r.num, r])),
    status: statusAt(S, t),
    weather: at(S.weather, t),
  };
}

// Distacco di fine giro tra due piloti: positivo se `a` è dietro a `b`.
export function gapSeries(S, a, b, t) {
  const lapsB = new Map((S.laps.get(b) ?? []).map((l) => [l.n, l]));
  const cleanA = new Set(cleanLaps(S, a, t).map((l) => l.n));
  const cleanB = new Set(cleanLaps(S, b, t).map((l) => l.n));
  const out = [];
  for (const la of S.laps.get(a) ?? []) {
    const lb = lapsB.get(la.n);
    if (!lb || la.end == null || lb.end == null || la.end > t || lb.end > t) continue;
    out.push({ lap: la.n, gap: (la.end - lb.end) / 1000, clean: cleanA.has(la.n) && cleanB.has(la.n) });
  }
  return out;
}

// Variazione del distacco per giro sugli ultimi giri puliti (negativa = `a` si avvicina a `b`).
export function gapRate(S, a, b, t) {
  const pts = gapSeries(S, a, b, t).filter((p) => p.clean).slice(-4);
  if (pts.length < 3) return null;
  const first = pts[0];
  const last = pts[pts.length - 1];
  return (last.gap - first.gap) / (last.lap - first.lap);
}

function theilSen(points) {
  const slopes = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      if (points[j].x !== points[i].x) slopes.push((points[j].y - points[i].y) / (points[j].x - points[i].x));
    }
  }
  return median(slopes);
}

// Degrado della gomma attuale in s/giro, depurato dall'effetto carburante.
export function degradation(S, row, t) {
  if (!row?.stintNo) return null;
  const stint = (S.stints.get(row.num) ?? []).find((s) => s.no === row.stintNo);
  const laps = cleanLaps(S, row.num, t).filter((l) => l.stint === row.stintNo);
  if (laps.length < MIN_DEG_LAPS) return null;
  const slope = theilSen(laps.map((l) => ({ x: stint.ageStart + (l.n - stint.from), y: l.dur })));
  return { value: slope + ASSUMPTIONS.fuelGainPerLap, laps: laps.length };
}

// Perdita reale di una sosta: giro di ingresso + uscita rispetto al ritmo pulito attorno.
export function pitLoss(S, t) {
  const samples = [];
  for (const p of S.pits) {
    if (p.t > t || (p.stop != null && p.stop > MAX_NORMAL_STOP_S)) continue;
    const list = S.laps.get(p.num) ?? [];
    const inLap = list.find((l) => l.n === p.lap);
    const outLap = list.find((l) => l.n === p.lap + 1);
    if (!inLap?.dur || !outLap?.dur || inLap.end > t || outLap.end > t) continue;
    if (overlapsNeutral(S, inLap) || overlapsNeutral(S, outLap)) continue;
    const ref = cleanLaps(S, p.num, t)
      .filter((l) => l.n >= p.lap - 4 && l.n <= p.lap + 5)
      .map((l) => l.dur);
    if (ref.length < 3) continue;
    const loss = inLap.dur + outLap.dur - 2 * median(ref);
    if (loss > 10 && loss < 60) samples.push(loss);
  }
  if (samples.length < MIN_PIT_SAMPLES) return { value: ASSUMPTIONS.defaultPitLoss, samples: samples.length, estimated: true };
  return { value: median(samples), samples: samples.length, estimated: false };
}

export function effectivePitLoss(loss, status) {
  if (status.kind === 'RED') return 0;
  if (status.kind === 'SC') return loss * ASSUMPTIONS.scLossFactor;
  if (status.kind === 'VSC') return loss * ASSUMPTIONS.vscLossFactor;
  return loss;
}

// Dove rientreresti entrando ai box adesso.
export function boxNow(snap, me, effective) {
  if (me?.gap == null || me.out) return null;
  const projected = me.gap + effective;
  const others = snap.rows.filter((r) => r.num !== me.num && !r.out && r.gap != null);
  const front = others.filter((r) => r.gap < projected);
  const back = others.filter((r) => r.gap >= projected);
  const ahead = front[front.length - 1] ?? null;
  const behind = back[0] ?? null;
  const rowOut = (r) => (r ? { num: r.num, tla: r.tla, margin: Math.abs(r.gap - projected) } : null);
  return {
    pos: front.length + 1,
    ahead: rowOut(ahead),
    behind: rowOut(behind),
    traffic: Boolean(ahead && Math.abs(ahead.gap - projected) < TRAFFIC_MARGIN_S),
  };
}

function compoundsUsed(S, num, lap) {
  return new Set((S.stints.get(num) ?? []).filter((s) => s.from <= lap && s.compound).map((s) => s.compound));
}

// Sull'asciutto servono due mescole diverse; chi ha usato gomme da bagnato ne è esente.
export function mandatoryStopPending(S, row) {
  const used = compoundsUsed(S, row.num, row.lap);
  return used.size === 1 && !WET.has([...used][0]);
}

// Confronta il costo di restare fuori con quello di una sosta fra k giri, su un degrado lineare.
export function pitWindow(S, row, deg, effective, baseLoss = effective) {
  const remaining = S.totalLaps - row.lap;
  if (!deg || remaining < 2 || row.age == null || deg.value < EVOLVING_TRACK_DEG_S) return null;
  const d = Math.max(deg.value, 0);
  const stintCost = (startAge, laps) => {
    let sum = 0;
    for (let i = 1; i <= laps; i++) sum += d * (startAge + i);
    return sum;
  };
  const mandatory = mandatoryStopPending(S, row);
  const stay = mandatory ? Infinity : stintCost(row.age, remaining);
  const costs = [];
  for (let k = 0; k < remaining; k++) {
    // Lo sconto di SC/VSC vale solo per chi si ferma adesso.
    const stopCost = k === 0 ? effective : baseLoss;
    costs.push({ k, cost: stintCost(row.age, k) + stopCost + stintCost(0, remaining - k) });
  }
  const best = costs.reduce((a, b) => (b.cost < a.cost ? b : a));
  const inWindow = costs.filter((c) => c.cost <= best.cost + ASSUMPTIONS.windowToleranceS);
  return {
    stayOut: stay <= best.cost,
    mandatory,
    remaining,
    fromLap: row.lap + inWindow[0].k,
    toLap: row.lap + inWindow[inWindow.length - 1].k,
    opensNow: inWindow[0].k === 0,
    gain: Number.isFinite(stay) ? stay - best.cost : null,
  };
}

// Stima se una sosta anticipata basta a superare chi hai davanti.
export function undercut(ahead, deg, degAhead) {
  if (!isNum(ahead?.interval) || ahead.age == null) return null;
  const rates = [deg?.value, degAhead?.value].filter(isNum);
  if (!rates.length) return null;
  const gain = Math.max(0, Math.max(...rates) * Math.max(ahead.age - 1, 0) - ASSUMPTIONS.outlapWarmupLoss);
  return { needed: ahead.interval, gain, ok: gain > ahead.interval };
}

// Asciutto contro bagnato: quanto gira più veloce chi è sull'altro tipo di gomma.
export function crossover(S, snap, me) {
  if (!me?.compound) return null;
  const groups = { wet: [], dry: [] };
  for (const r of snap.rows) {
    if (r.out || !r.compound) continue;
    const last = cleanLaps(S, r.num, snap.t).at(-1);
    if (!last || r.lap - last.n > 2 || last.stint !== r.stintNo) continue;
    groups[WET.has(r.compound) ? 'wet' : 'dry'].push(last.dur);
  }
  const mine = WET.has(me.compound) ? 'wet' : 'dry';
  const other = mine === 'wet' ? 'dry' : 'wet';
  if (groups.wet.length < CROSSOVER_MIN_CARS || groups.dry.length < CROSSOVER_MIN_CARS) return null;
  const delta = median(groups[mine]) - median(groups[other]);
  return { other, delta, cars: groups[other].length, faster: delta > CROSSOVER_S };
}

const neighbours = (snap, me) => {
  const live = snap.rows.filter((r) => !r.out);
  const i = live.findIndex((r) => r.num === me.num);
  return { ahead: i > 0 ? live[i - 1] : null, behind: i >= 0 && i < live.length - 1 ? live[i + 1] : null };
};

export const autoRival = (snap, meNum) => {
  const me = snap.byNum.get(meNum);
  if (!me) return null;
  const { ahead, behind } = neighbours(snap, me);
  return (ahead ?? behind)?.num ?? null;
};

export function mentionsDriver(r, num, tla) {
  return r.num === num || new RegExp(`\\b${num} \\(${tla}\\)`).test(r.msg);
}

const SEVERITY = { critical: 0, warning: 1, info: 2 };
const s1 = (x) => Math.abs(x).toFixed(1);
const s2 = (x) => Math.abs(x).toFixed(2);

// Tutto ciò che serve al muretto per il pilota scelto, all'istante t.
export function analyse(S, snap, meNum) {
  const t = snap.t;
  const me = snap.byNum.get(meNum);
  if (!me) return null;
  const { ahead, behind } = neighbours(snap, me);
  const deg = degradation(S, me, t);
  const degAhead = ahead ? degradation(S, ahead, t) : null;
  const loss = pitLoss(S, t);
  const effective = effectivePitLoss(loss.value, snap.status);
  const finished = snap.status.kind === 'END';
  const box = finished ? null : boxNow(snap, me, effective);
  const window = finished ? null : pitWindow(S, me, deg, effective, loss.value);
  const cut = ahead ? undercut(ahead, deg, degAhead) : null;
  const cross = crossover(S, snap, me);
  const mandatory = me.lap > 0 && mandatoryStopPending(S, me);
  const trackEvolving = Boolean(deg && deg.value < EVOLVING_TRACK_DEG_S);
  const rateAhead = ahead ? gapRate(S, me.num, ahead.num, t) : null;
  const rateBehind = behind ? gapRate(S, behind.num, me.num, t) : null;
  const remaining = Math.max(S.totalLaps - me.lap, 0);

  const calls = [];
  const say = (severity, text) => calls.push({ severity, text });
  const racing = !me.out && snap.status.kind !== 'END' && me.lap > 0;
  const pittedRecently = S.pits.some((p) => p.num === me.num && p.t <= t && me.lap - p.lap <= 1);

  if (me.out) say('info', `${me.tla} è fuori gara.`);

  if (racing) {
    if (snap.status.kind === 'RED') {
      say('critical', 'Bandiera rossa: si possono cambiare le gomme senza perdere tempo in corsia.');
    } else if ((snap.status.kind === 'SC' || snap.status.kind === 'VSC') && !pittedRecently) {
      const rejoin = box ? ` Rientreresti P${box.pos}.` : '';
      say('critical', `${snap.status.label}: la sosta costa circa ${s1(effective)} s invece di ${s1(loss.value)}.${rejoin}`);
    }

    if (snap.weather?.rain && me.compound && !WET.has(me.compound)) {
      say('critical', 'Pioggia in pista e sei su gomma da asciutto.');
    }

    if (cross?.faster && !pittedRecently) {
      const tyre = cross.other === 'dry' ? 'da asciutto' : 'da bagnato';
      say('critical', `Chi è su gomma ${tyre} gira ${s1(cross.delta)} s più veloce: valuta il cambio.`);
    }

    if (mandatory && remaining <= 5) {
      say('critical', `Manca la sosta obbligatoria per la seconda mescola: restano ${remaining} giri.`);
    }

    if (ahead && S.pits.some((p) => p.num === ahead.num && p.t <= t && t - p.t < 45_000)) {
      say('warning', `${ahead.tla} si è appena fermato: valuta se coprire o allungare.`);
    }
    if (behind && S.pits.some((p) => p.num === behind.num && p.t <= t && t - p.t < 45_000)) {
      say('warning', `${behind.tla} ha fatto la sosta: rischio undercut su di te.`);
    }

    const green = snap.status.kind === 'GREEN';
    if (!green) {
      // A pista neutralizzata i distacchi non dicono nulla su attacco e difesa.
    } else if (ahead && isNum(ahead.interval) && ahead.interval <= ATTACK_RANGE_S) {
      say('info', `${ahead.tla} a ${s2(ahead.interval)} s: sei in zona attacco.`);
    } else if (ahead && isNum(ahead.interval) && rateAhead != null && rateAhead < -CLOSING_RATE_S) {
      const lapsToAttack = Math.ceil((ahead.interval - ATTACK_RANGE_S) / -rateAhead);
      say(
        'info',
        lapsToAttack <= remaining
          ? `Recuperi ${s2(rateAhead)} s/giro su ${ahead.tla}: in zona attacco tra ${lapsToAttack} giri.`
          : `Recuperi ${s2(rateAhead)} s/giro su ${ahead.tla}, ma non basta per arrivarci entro la fine.`,
      );
    }

    if (!green) {
      // Come sopra.
    } else if (behind && isNum(behind.interval) && behind.interval <= ATTACK_RANGE_S) {
      say('warning', `${behind.tla} a ${s2(behind.interval)} s dietro: sei sotto attacco.`);
    } else if (behind && isNum(behind.interval) && rateBehind != null && rateBehind < -CLOSING_RATE_S) {
      say('warning', `${behind.tla} ti riprende ${s2(rateBehind)} s/giro (ora a ${s1(behind.interval)} s).`);
    }

    if (deg && deg.value >= HIGH_DEG_S) {
      say('warning', `Degrado alto: ${s2(deg.value)} s/giro con gomma a ${me.age} giri.`);
    }

    if (trackEvolving) {
      say('info', 'Pista in miglioramento: il degrado non si legge, guarda il ritmo degli altri.');
    }

    if (window && !pittedRecently && snap.status.kind === 'GREEN') {
      if (window.stayOut) {
        say('info', 'Con questo degrado una sosta non si ripaga: resta fuori.');
      } else if (window.opensNow) {
        const rejoin = box ? ` Rientro previsto P${box.pos}${box.traffic ? ', nel traffico' : ''}.` : '';
        say('warning', `Finestra box aperta fino al giro ${window.toLap}.${rejoin}`);
      } else {
        say('info', `Finestra box stimata: giri ${window.fromLap}–${window.toLap}.`);
      }
    }

    if (S.rc.some((r) => r.flag === 'BLUE' && r.num === me.num && r.t <= t && t - r.t < 40_000)) {
      say('info', 'Bandiera blu: fai passare chi ti sta doppiando.');
    }

    const recent = [...S.rc].reverse().find(
      (r) => r.t <= t && t - r.t < 180_000 && r.flag !== 'BLUE' && mentionsDriver(r, me.num, me.tla),
    );
    if (recent) say('warning', recent.msg);
  }

  calls.sort((a, b) => SEVERITY[a.severity] - SEVERITY[b.severity]);

  return { me, ahead, behind, deg, degAhead, loss, effective, box, window, cut, cross, mandatory, trackEvolving, rateAhead, rateBehind, remaining, calls };
}

// Sceglie il giro da confrontare: l'ultimo pulito per entrambi, altrimenti l'ultimo di ciascuno.
export function telemetryLaps(S, a, b, t, requestedLap = null) {
  const ca = cleanLaps(S, a, t);
  const cb = cleanLaps(S, b, t);
  if (!ca.length || !cb.length) return null;
  const setB = new Map(cb.map((l) => [l.n, l]));
  if (requestedLap != null) {
    const la = ca.find((l) => l.n === requestedLap);
    const lb = setB.get(requestedLap);
    if (la && lb) return { a: la, b: lb };
  }
  const shared = ca.filter((l) => setB.has(l.n));
  if (shared.length) {
    const la = shared[shared.length - 1];
    return { a: la, b: setB.get(la.n) };
  }
  return { a: ca[ca.length - 1], b: cb[cb.length - 1] };
}

function lapTrace(car, lap) {
  const pts = [];
  let dist = 0;
  let prevT = null;
  for (let i = 0; i < car.t.length; i++) {
    const t = car.t[i];
    if (t < lap.start || t > lap.end) continue;
    if (prevT != null) dist += (car.speed[i] / 3.6) * ((t - prevT) / 1000);
    prevT = t;
    pts.push({ d: dist, t: (t - lap.start) / 1000, speed: car.speed[i], throttle: car.throttle[i], brake: car.brake[i], gear: car.gear[i] });
  }
  return { pts, total: dist };
}

function sampleAt(trace, frac, key) {
  const target = frac * trace.total;
  const { pts } = trace;
  let i = 1;
  while (i < pts.length - 1 && pts[i].d < target) i++;
  const p0 = pts[i - 1];
  const p1 = pts[i];
  const span = p1.d - p0.d || 1;
  const w = Math.min(Math.max((target - p0.d) / span, 0), 1);
  return p0[key] + (p1[key] - p0[key]) * w;
}

// Porta i due giri sulla stessa ascissa (% di giro) e calcola il delta cumulato.
export function compareLaps(carA, lapA, carB, lapB, steps = 200) {
  const a = lapTrace(carA, lapA);
  const b = lapTrace(carB, lapB);
  if (a.pts.length < 10 || b.pts.length < 10) return null;
  const out = { x: [], speedA: [], speedB: [], throttleA: [], throttleB: [], brakeA: [], brakeB: [], delta: [] };
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    out.x.push(f * 100);
    out.speedA.push(sampleAt(a, f, 'speed'));
    out.speedB.push(sampleAt(b, f, 'speed'));
    out.throttleA.push(sampleAt(a, f, 'throttle'));
    out.throttleB.push(sampleAt(b, f, 'throttle'));
    out.brakeA.push(sampleAt(a, f, 'brake'));
    out.brakeB.push(sampleAt(b, f, 'brake'));
    out.delta.push(sampleAt(a, f, 't') - sampleAt(b, f, 't'));
  }
  return out;
}
