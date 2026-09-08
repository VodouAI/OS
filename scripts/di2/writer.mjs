import { open, mkrand, WORDS } from './shared.mjs';
const [F, tag, secs] = [process.argv[2], process.argv[3], Number(process.argv[4]||30)];
const db = open(F);
const rand = mkrand(tag.charCodeAt(0)*7919); const text = n => Array.from({length:n},()=>WORDS[(rand()*WORDS.length)|0]).join(' ');
const convs=['c-alpha','c-beta','c-gamma','c-delta'];
const ins = db.prepare('INSERT INTO gateway_messages(conversation_id,role,content,skill_name,turn_id) VALUES (?,?,?,?,?)');
const upC = db.prepare('UPDATE gateway_messages SET content = ? WHERE id = ?');
const upTag = db.prepare('UPDATE gateway_messages SET excluded_from_context = 1 WHERE skill_name = ? AND excluded_from_context = 0');
const upPat = db.prepare("UPDATE gateway_messages SET excluded_from_context = 1, skill_name = COALESCE(skill_name, ?) WHERE role = 'assistant' AND excluded_from_context = 0 AND content LIKE ?");
const pick = db.prepare('SELECT id FROM gateway_messages ORDER BY id LIMIT ? OFFSET ?');
const end = Date.now() + secs*1000; let n=0, errs=0;
while (Date.now() < end) {
  try {
    for (let i=0;i<40;i++) ins.run(convs[(rand()*4)|0], rand()<.5?'user':'assistant', text(10+((rand()*100)|0)), rand()<.15?'daily-brief':null, `${tag}-${n}-${i}`);
    const rows = pick.all(30, (rand()*3000)|0).map(r=>r.id);
    for (const id of rows.slice(0,10)) upC.run(text(40+((rand()*150)|0)), id);
    upTag.run('daily-brief'); upPat.run('pattern','%vodou%');
    if (rows.length) db.prepare(`DELETE FROM gateway_messages WHERE id IN (${rows.map(()=>'?').join(',')})`).run(...rows);
    n++;
  } catch (e) { errs++; }
}
console.log(`writer ${tag}: ${n} rounds, ${errs} errors`);
db.close();
