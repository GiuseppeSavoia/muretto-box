// Prova generale della diretta: rimanda una registrazione di F1Data come se la gara fosse
// partita da pochi minuti, spostando tutti gli orari a oggi e scrivendo le righe al loro
// momento. Il muretto va avviato puntando alla cartella di prova:
//
//   node tools/prova-diretta.mjs <registrazione.txt> <cartella>/2026-01-01_Prova_Race.txt [minuti fa] [secondi]
//   F1DATA_RECORDINGS=<cartella> PORT=8421 node server.mjs
import { readFileSync, appendFileSync, writeFileSync } from 'node:fs';
import { inflateRawSync, deflateRawSync } from 'node:zlib';
const [src, out, minutesAgo = '8', runFor = '600'] = process.argv.slice(2);
if (!src || !out) {
  console.error('Uso: node tools/prova-diretta.mjs <registrazione.txt> <file di uscita _Race.txt> [minuti fa] [secondi]');
  process.exit(1);
}
const lines = readFileSync(src, 'utf8').split('\n').filter(Boolean);
// La partenza è il primo cambio di stato "Started" con un istante.
const startLine = lines.find((l) => l.startsWith("['SessionStatus', {") && l.includes("'Status': 'Started'"));
const START = Date.parse(startLine?.match(/'(\d{4}-[^']+)'\]$/)?.[1] ?? '');
if (!Number.isFinite(START)) {
  console.error('Partenza della gara non trovata nella registrazione.');
  process.exit(1);
}
const delta = Date.now() - Number(minutesAgo) * 60e3 - START;
const ISO = /(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(\.\d+)?(Z)?/g;
const shift = (text) => text.replace(ISO, (m, base, frac, z) => {
  const t = Date.parse(`${base}${frac ?? ''}Z`) + delta;
  const s = new Date(t).toISOString();
  return frac ? (z ? s : s.slice(0, -1)) : (z ? `${s.slice(0, 19)}Z` : s.slice(0, 19));
});
const tsOf = (l) => { const m = l.match(/, '([^']*)'\]$/); return m && m[1] ? Date.parse(m[1]) : null; };
let last = null;
const items = lines.map((l) => {
  let text = l;
  if (l.startsWith("['CarData.z'")) {
    const m = l.match(/^\['CarData\.z', '([^']+)', '([^']*)'\]$/);
    if (m) {
      const json = shift(inflateRawSync(Buffer.from(m[1], 'base64')).toString('utf8'));
      text = `['CarData.z', '${deflateRawSync(json).toString('base64')}', '${shift(m[2])}']`;
    }
  } else text = shift(l);
  const ts = tsOf(text) ?? last;
  last = ts;
  return { ts, text };
});
writeFileSync(out, '');
let i = 0;
const flush = () => {
  const now = Date.now();
  const batch = [];
  while (i < items.length && (items[i].ts == null || items[i].ts <= now)) batch.push(items[i++].text);
  if (batch.length) appendFileSync(out, `${batch.join('\n')}\n`);
};
flush();
console.log('scritte', i, 'righe su', items.length);
const end = Date.now() + Number(runFor) * 1000;
const timer = setInterval(() => { flush(); if (Date.now() > end || i >= items.length) { clearInterval(timer); console.log('fine', i); } }, 500);
