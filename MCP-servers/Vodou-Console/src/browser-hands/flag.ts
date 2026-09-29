/**
 * Browser Hands on/off (PLAN-BROWSER-HANDS). Its own tiny module so tools.ts can
 * ask without importing the browser machinery. Off unless VODOU_BROWSER_HANDS=1
 * until the fresh-install test passes (§14.6).
 */
export function browserHandsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const v = String(env.VODOU_BROWSER_HANDS ?? '').trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}
