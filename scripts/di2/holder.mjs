// The long-lived handle: what the gateway process is.
import { open, ftsIc, quick } from './shared.mjs';
const [F, secs] = [process.argv[2], Number(process.argv[3]||40)];
const db = open(F);
const end = Date.now() + secs*1000; let ticks=0, ftsFail=0, quickFail=0, matchFail=0; const seen=new Set();
while (Date.now() < end) {
  ticks++;
  const q = quick(db); const f = process.env.DI2_NOFTS === '1' ? 'ok' : ftsIc(db);
  if (q !== 'ok') { quickFail++; seen.add('quick: '+q); }
  if (f !== 'ok') { ftsFail++; seen.add('fts: '+f); }
  if (process.env.DI2_NOFTS !== '1') {
    try { db.prepare(`SELECT COUNT(*) n FROM gateway_messages_fts WHERE content MATCH 'memory OR gateway'`).get(); }
    catch (e) { matchFail++; seen.add('match: '+e.message); }
  }
  const t = Date.now()+150; while (Date.now()<t);   // busy-wait, no timers
}
console.log(`holder: ${ticks} ticks · quick_check failures ${quickFail} · FTS integrity failures ${ftsFail} · MATCH failures ${matchFail}`);
for (const s of seen) console.log(`  distinct: ${s}`);
db.close();
