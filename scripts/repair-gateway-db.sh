#!/usr/bin/env bash
# repair-gateway-db.sh — PLAN-GATEWAY-DB-REPAIR (0.6.26) §3.
#
# Rebuild MCP-servers/Vodou-Console/gateway.db from a damaged file:
#   backup → .recover into a fresh file → drop+rebuild FTS from content → VACUUM
#   → integrity_check == ok, MATCH works, probe insert succeeds → swap → restart.
#
# The 08-15 repair rebuilt the FTS index in place and never VACUUMed; the freelist
# stayed wrong and re-corrupted the file within a day. This script never writes
# into the damaged file — the recovered database has a correct freelist by
# construction — and refuses to swap unless every check passes.
#
# Usage:  bash scripts/repair-gateway-db.sh            # full run (stops services)
#         bash scripts/repair-gateway-db.sh --dry-run  # backup + recover + verify, no swap, no restart
# Env:    VODOU_FORCE_STOP=1 to stop a gateway that is mid-chat (see stop-vodou-services.sh)
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
GW_DIR="$ROOT/MCP-servers/Vodou-Console"
DB="$GW_DIR/gateway.db"
TS="$(date +%Y%m%dT%H%M%S)"           # local time — this is a directory name
OUT="$ROOT/backups/gateway-db-repair-$TS"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1
log() { echo "[$(date +%H:%M:%S)] [repair-gateway-db] $*"; }
die() { log "ERROR: $*"; exit 1; }

# ─── 0. preconditions ────────────────────────────────────────────────────────
[ -f "$DB" ] || die "no $DB"
sqlite3 -version | awk '{split($1,v,"."); if (v[1]<3 || (v[1]==3 && v[2]<40)) exit 1}' \
  || die "sqlite3 >= 3.40 required for .recover (have $(sqlite3 -version | cut -d' ' -f1))"
size_kb=$(du -k "$DB" | cut -f1)
free_kb=$(df -k "$ROOT" | awk 'NR==2{print $4}')
[ "$free_kb" -gt $((size_kb * 4)) ] || die "need >= 4x DB size free (db=${size_kb}K free=${free_kb}K)"
mkdir -p "$OUT"
log "db=$DB (${size_kb}K) out=$OUT dry_run=$DRY"

log "integrity_check BEFORE (summary):"
sqlite3 "$DB" "PRAGMA integrity_check(2000);" 2>&1 | tee "$OUT/integrity_before.txt" \
  | grep -oE "^Freelist.*|Tree [0-9]+|never used|malformed" | sort | uniq -c | sed 's/^/    /' || true
before_msgs_scan=$(sqlite3 "$DB" "SELECT count(*) FROM gateway_messages;" 2>/dev/null || echo "?")
before_msgs_idx=$(sqlite3 "$DB" "SELECT count(*) FROM gateway_messages INDEXED BY idx_gw_messages_conv;" 2>/dev/null || echo "?")
before_convs=$(sqlite3 "$DB" "SELECT count(*) FROM gateway_conversations;" 2>/dev/null || echo "?")
log "before: gateway_messages scan=$before_msgs_scan index=$before_msgs_idx conversations=$before_convs"

# ─── 1. stop writers, backup ─────────────────────────────────────────────────
if [ "$DRY" = "0" ]; then
  log "stopping gateway + daemon + worker (active-turn guard applies)"
  ./stop-vodou-services.sh 2>&1 | tail -3 || die "stop-vodou-services failed — not touching the file"
  if lsof "$DB" >/dev/null 2>&1; then
    lsof "$DB" | head -5
    die "something still holds gateway.db open — refusing to continue"
  fi
fi
log "backup: copying db + wal + shm"
cp "$DB" "$OUT/gateway.db.original"
[ -f "$DB-wal" ] && cp "$DB-wal" "$OUT/gateway.db-wal.original"
[ -f "$DB-shm" ] && cp "$DB-shm" "$OUT/gateway.db-shm.original"
# page-level copy through the SQLite backup API as a second, independent copy
sqlite3 "$DB" ".backup '$OUT/gateway.db.pagecopy'" 2>&1 | head -2 || true

# ─── 2. recover into a fresh file ────────────────────────────────────────────
REC="$OUT/gateway.recovered.db"
log ".recover → $REC"
sqlite3 "$DB" ".recover" > "$OUT/recover.sql" 2> "$OUT/recover.stderr" || true
[ -s "$OUT/recover.sql" ] || die ".recover produced no SQL (see $OUT/recover.stderr)"
sqlite3 "$REC" < "$OUT/recover.sql" 2> "$OUT/recover.apply.stderr" || true
if [ -s "$OUT/recover.apply.stderr" ]; then
  log "recover.apply had $(wc -l < "$OUT/recover.apply.stderr") stderr line(s) (kept in $OUT) — expected for shadow tables"
fi
lf=$(sqlite3 "$REC" "SELECT count(*) FROM lost_and_found;" 2>/dev/null || echo 0)
log "lost_and_found rows: $lf"

# ─── 2b. salvage rows .recover could not attribute ───────────────────────────
# .recover drops rows whose page it cannot tie to a table (dry run 2026-08-16:
# gateway_messages 64,031 → 63,790; gateway_settings 100 → 97). Most of those
# rows are still readable in the ORIGINAL by primary key — cross-linked pages
# break tree walks, not point lookups — so copy them across one by one
# (per-row so a genuinely unreadable page skips instead of aborting), then try
# lost_and_found_1 (12-field = gateway_messages-shaped orphans) for the rest.
# .recover re-emits the FTS virtual table + its triggers; drop them NOW so the
# salvage inserts below don't fire FTS writes (step 3 rebuilds from content).
sqlite3 "$REC" "DROP TRIGGER IF EXISTS gateway_messages_fts_ai; DROP TRIGGER IF EXISTS gateway_messages_fts_ad; DROP TRIGGER IF EXISTS gateway_messages_fts_au;" 2>/dev/null || true
sqlite3 "$REC" "DROP TABLE IF EXISTS gateway_messages_fts;" 2>/dev/null || true
for t in gateway_messages_fts_data gateway_messages_fts_idx gateway_messages_fts_docsize gateway_messages_fts_config gateway_messages_fts_content; do
  sqlite3 "$REC" "DROP TABLE IF EXISTS $t;" 2>/dev/null || true
done
log "salvage: rows readable in the original but missing from recovered"
sqlite3 "$DB" "SELECT id FROM gateway_messages INDEXED BY idx_gw_messages_conv;" 2>/dev/null | sort -n > "$OUT/ids_orig.txt" || true
sqlite3 "$DB" "SELECT id FROM gateway_messages NOT INDEXED;" 2>/dev/null | sort -n >> "$OUT/ids_orig.txt" || true
sort -un "$OUT/ids_orig.txt" -o "$OUT/ids_orig.txt"
sqlite3 "$REC" "SELECT id FROM gateway_messages;" | sort -n > "$OUT/ids_rec.txt"
comm -23 "$OUT/ids_orig.txt" "$OUT/ids_rec.txt" > "$OUT/ids_missing.txt"
n_missing=$(wc -l < "$OUT/ids_missing.txt" | tr -d ' ')
n_salvaged=0
if [ "$n_missing" -gt 0 ]; then
  while read -r mid; do
    [ -n "$mid" ] || continue
    if sqlite3 "$REC" "ATTACH '$DB' AS orig; INSERT OR IGNORE INTO main.gateway_messages SELECT * FROM orig.gateway_messages WHERE id = $mid AND typeof(content) IN ('text','null') AND typeof(conversation_id)='text';" 2>/dev/null; then
      n_salvaged=$((n_salvaged+1))
    fi
  done < "$OUT/ids_missing.txt"
fi
# second chance: 12-field orphans in lost_and_found_1 for ids still missing
n_lf=0
if sqlite3 "$REC" "SELECT 1 FROM sqlite_master WHERE name='lost_and_found_1';" | grep -q 1; then
  n_lf=$(sqlite3 "$REC" "SELECT count(*) FROM lost_and_found_1 WHERE nfield=12 AND typeof(c0)='integer' AND c0 NOT IN (SELECT id FROM gateway_messages);" 2>/dev/null || echo 0)
  if [ "${n_lf:-0}" -gt 0 ]; then
    sqlite3 "$REC" "INSERT OR IGNORE INTO gateway_messages (id, conversation_id, role, content, created_at, principal_id, sender_label, skill_name, excluded_from_context, dedupe_key, source_msg_id, model)
      SELECT c0,c1,c2,c3,c4,c5,c6,c7,c8,c9,c10,c11 FROM lost_and_found_1
      WHERE nfield=12 AND typeof(c0)='integer' AND typeof(c1)='text' AND typeof(c2)='text' AND typeof(c3) IN ('text','null')
        AND c0 NOT IN (SELECT id FROM gateway_messages)
        AND c1 IN (SELECT id FROM gateway_conversations);" 2>/dev/null || true
  fi
fi
# settings + any other table whose count differs: copy missing rows by primary key from the original
sqlite3 "$REC" "ATTACH '$DB' AS orig; INSERT OR IGNORE INTO main.gateway_settings SELECT * FROM orig.gateway_settings WHERE key NOT IN (SELECT key FROM main.gateway_settings);" 2>/dev/null || true
after_salvage=$(sqlite3 "$REC" "SELECT count(*) FROM gateway_messages;")
log "salvage: missing=$n_missing copied_by_id=$n_salvaged lost_and_found_1_candidates=${n_lf:-0} gateway_messages now=$after_salvage"
# export + drop the lost_and_found tables — kept as CSV in $OUT, not shipped in the live db
for lt in $(sqlite3 "$REC" "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'lost_and_found%';"); do
  sqlite3 -header -csv "$REC" "SELECT * FROM $lt;" > "$OUT/$lt.csv" 2>/dev/null || true
  sqlite3 "$REC" "DROP TABLE $lt;"
done

# ─── 3. FTS: drop shadow salvage, recreate from content ──────────────────────
log "FTS: drop + recreate + rebuild"
FTS_DDL=$(sqlite3 "$DB" "SELECT sql FROM sqlite_master WHERE name='gateway_messages_fts';" 2>/dev/null || true)
[ -n "$FTS_DDL" ] || FTS_DDL="CREATE VIRTUAL TABLE gateway_messages_fts USING fts5(content, content='gateway_messages', content_rowid='id', tokenize='porter unicode61')"
sqlite3 "$REC" "DROP TABLE IF EXISTS gateway_messages_fts;" 2>/dev/null || true
for t in gateway_messages_fts_data gateway_messages_fts_idx gateway_messages_fts_docsize gateway_messages_fts_config gateway_messages_fts_content; do
  sqlite3 "$REC" "DROP TABLE IF EXISTS $t;" 2>/dev/null || true
done
sqlite3 "$REC" "$FTS_DDL;"
# triggers as db.ts creates them (idempotent — db.ts uses IF NOT EXISTS)
sqlite3 "$REC" "
CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_ai AFTER INSERT ON gateway_messages BEGIN
  INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
END;
CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_ad AFTER DELETE ON gateway_messages BEGIN
  INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
END;
CREATE TRIGGER IF NOT EXISTS gateway_messages_fts_au AFTER UPDATE ON gateway_messages BEGIN
  INSERT INTO gateway_messages_fts(gateway_messages_fts, rowid, content) VALUES('delete', old.id, old.content);
  INSERT INTO gateway_messages_fts(rowid, content) VALUES (new.id, new.content);
END;"
sqlite3 "$REC" "INSERT INTO gateway_messages_fts(gateway_messages_fts) VALUES('rebuild');"

# ─── 4. VACUUM + verify ──────────────────────────────────────────────────────
log "VACUUM"
sqlite3 "$REC" "VACUUM;"
sqlite3 "$REC" "PRAGMA journal_mode=WAL;" >/dev/null
IC=$(sqlite3 "$REC" "PRAGMA integrity_check;")
[ "$IC" = "ok" ] || { echo "$IC" | head -20; die "recovered db does NOT pass integrity_check — not swapping"; }
FL=$(sqlite3 "$REC" "PRAGMA freelist_count;")
after_msgs=$(sqlite3 "$REC" "SELECT count(*) FROM gateway_messages;")
after_convs=$(sqlite3 "$REC" "SELECT count(*) FROM gateway_conversations;")
fts_hits=$(sqlite3 "$REC" "SELECT count(*) FROM gateway_messages_fts WHERE content MATCH 'the';")
[ "$fts_hits" -gt 0 ] || die "FTS MATCH returns 0 after rebuild — not swapping"
sqlite3 "$REC" "PRAGMA trusted_schema=ON; BEGIN; INSERT INTO gateway_messages (conversation_id, role, content) VALUES ('repair-probe','user','repair probe the quick brown fox'); ROLLBACK;" \
  || die "probe insert (with FTS triggers) failed on recovered db — not swapping"
log "after:  integrity=ok freelist=$FL gateway_messages=$after_msgs conversations=$after_convs fts_hits(the)=$fts_hits"
log "row-count deltas per table (original scan → recovered):"
for t in $(sqlite3 "$REC" "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' AND name<>'lost_and_found' ORDER BY name;"); do
  b=$(sqlite3 "$DB" "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "ERR")
  a=$(sqlite3 "$REC" "SELECT count(*) FROM \"$t\";" 2>/dev/null || echo "ERR")
  [ "$b" = "$a" ] || echo "    $t: $b → $a"
done
{
  echo "ts=$TS"; echo "before_msgs_scan=$before_msgs_scan before_msgs_idx=$before_msgs_idx before_convs=$before_convs"
  echo "after_msgs=$after_msgs after_convs=$after_convs lost_and_found=$lf freelist_after=$FL fts_hits=$fts_hits"
} > "$OUT/summary.txt"

if [ "$DRY" = "1" ]; then
  log "DRY RUN complete — recovered db at $REC passes all checks; nothing swapped, services untouched"
  exit 0
fi

# ─── 5. swap ─────────────────────────────────────────────────────────────────
if lsof "$DB" >/dev/null 2>&1; then die "gateway.db acquired an open handle during repair — not swapping"; fi
log "swap: original → $OUT/gateway.db.replaced ; recovered → $DB"
mv "$DB" "$OUT/gateway.db.replaced"
[ -f "$DB-wal" ] && mv "$DB-wal" "$OUT/gateway.db-wal.replaced"
[ -f "$DB-shm" ] && mv "$DB-shm" "$OUT/gateway.db-shm.replaced"
mv "$REC" "$DB"
rm -f "$REC-wal" "$REC-shm"
sqlite3 "$DB" "PRAGMA journal_mode=WAL; PRAGMA integrity_check;" | tail -1 | grep -qx ok || die "post-swap integrity_check failed (rollback: mv $OUT/gateway.db.replaced $DB)"

# ─── 6. restart + verify ─────────────────────────────────────────────────────
log "restart services"
bash scripts/restart-gateway.sh 2>&1 | tail -3 || true
for _ in $(seq 1 15); do
  h=$(curl -fsS -m 3 http://127.0.0.1:${WEB_PORT:-8765}/health 2>/dev/null || true)
  if printf '%s' "$h" | grep -q '"dbHealthy":true'; then log "health: dbHealthy=true"; break; fi
  sleep 2
done
printf '%s' "${h:-}" | grep -q '"dbHealthy":true' || log "WARNING: /health does not report dbHealthy:true yet — check .vodou/gateway.log"
log "done. backups + recovered artifacts in $OUT ; rollback: stop services, mv $OUT/gateway.db.replaced $DB, start"
