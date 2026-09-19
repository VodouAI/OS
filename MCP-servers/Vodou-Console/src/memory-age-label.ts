/**
 * PLAN-MEMORIES-ARE-FACTS-NOT-WORK-LOGS §4.2 (F2) — the gateway's half of the age
 * label. The engine's twin is `src/memory/age_label.rs`; both are held to
 * `tests/fixtures/memory-ranking/age-labels.json`, so the two cannot drift.
 *
 * Rules: a replaced note always says `true until 12 Sep`; a status note always
 * says its age (`5d ago`, `3mo ago`); a fact only past PREF 180 / DECISION 270 /
 * IDENTITY 365 / DEPENDENCY 90 days (DEPENDENCY: label only, FU-18). Dates are the person's days. `VODOU_MEMORY_AGE_LABELS=0`
 * turns labels off.
 */
import { dayKeyOfNaiveUtc, todayKey } from './user-time.js';

/** Status-kind tags. The vocabulary gate (memory_extraction.rs) holds this list
 *  equal to the engine's `tag_kind` Status set. */
export const STATUS_TAGS = ['DONE', 'PLANNED', 'ISSUE', 'METRIC', 'DIGEST'];

const HORIZON_DAYS: Record<string, number> = { PREF: 180, DECISION: 270, IDENTITY: 365, DEPENDENCY: 90 };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function dayNumber(day: string): number {
  const [y, m, d] = day.split('-').map(Number);
  return Math.round(Date.UTC(y, m - 1, d) / 86_400_000);
}

export function shortAge(days: number): string {
  const d = Math.max(0, days);
  if (d === 0) return 'today';
  if (d < 14) return `${d}d ago`;
  if (d < 60) return `${Math.floor(d / 7)}w ago`;
  if (d < 365) return `${Math.floor(d / 30)}mo ago`;
  return `${Math.floor(d / 365)}y ago`;
}

/** The pure rule, on local `YYYY-MM-DD` days. */
export function ageLabel(
  tag: string | null | undefined,
  datedDay: string | null | undefined,
  untilDay: string | null | undefined,
  today: string,
): string | null {
  if (untilDay) {
    const [y, m, d] = untilDay.split('-').map(Number);
    const base = `true until ${d} ${MONTHS[m - 1]}`;
    return y === Number(today.slice(0, 4)) ? base : `${base} ${y}`;
  }
  if (!datedDay || !tag) return null;
  if (tag === 'DIGEST') {
    // A weekly summary is dated its week's last day; say which week.
    const [y, m, d] = datedDay.split('-').map(Number);
    const start = new Date(Date.UTC(y, m - 1, d) - 6 * 86_400_000);
    const base = `week of ${start.getUTCDate()} ${MONTHS[start.getUTCMonth()]}`;
    return start.getUTCFullYear() === Number(today.slice(0, 4)) ? base : `${base} ${start.getUTCFullYear()}`;
  }
  const days = Math.max(0, dayNumber(today) - dayNumber(datedDay));
  if (STATUS_TAGS.includes(tag)) return shortAge(days);
  const horizon = HORIZON_DAYS[tag];
  return horizon !== undefined && days > horizon ? shortAge(days) : null;
}

/** The label for a `mem search --json` row (`created_at` is COALESCE(valid_at, created_at)). */
export function ageLabelForRow(row: { chunk_tag?: string | null; created_at?: string | null; superseded_at?: string | null }): string | null {
  if (process.env.VODOU_MEMORY_AGE_LABELS === '0') return null;
  return ageLabel(
    row.chunk_tag,
    row.created_at ? dayKeyOfNaiveUtc(row.created_at) : null,
    row.superseded_at ? dayKeyOfNaiveUtc(row.superseded_at) : null,
    todayKey(),
  );
}
