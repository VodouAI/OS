/**
 * `NOTHING_TO_REPORT` — the one reply a skill gives when it has nothing to say.
 *
 * The TS twin of `memory::entities::is_nothing_to_report` (Rust), which grades
 * the run `did_the_job / nothing_to_report`. A reply like that must not ring
 * anyone: meeting-brief fires every half hour on weekdays, and an empty window
 * is its normal answer.
 *
 * One spelling, because there are two places that must agree: channel delivery
 * (index.ts) and the extension inbox push (`notifyPanelOfRun`). The inline check
 * guarded only the first, so every quiet brief still landed in the panel's inbox
 * as "Meeting brief — NOTHING_TO_REPORT" (found 2026-09-14).
 *
 * NOT exact equality — run 828 (2026-09-10): the model wrote one preamble line
 * before the sentinel. The sentinel is the LAST thing said; anything after it is
 * a real reply.
 */
export const NOTHING_TO_REPORT = 'NOTHING_TO_REPORT';

export function isNothingToReport(text: string | null | undefined): boolean {
  if (!text) return false;
  const lastLine = text.trim().split('\n').filter((l) => l.trim()).pop() || '';
  return lastLine.trim().replace(/^[*`_]+|[*`_]+$/g, '') === NOTHING_TO_REPORT;
}
