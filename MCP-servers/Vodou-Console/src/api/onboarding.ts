/**
 * Onboarding API — programmatic workspace bootstrap for fresh installs.
 * Checks if identity is set, writes USER/IDENTITY/SOUL/MEMORY files,
 * deletes BOOTSTRAP.md when done. No AI involvement.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execFileSync, execSync, execFile } from 'child_process';
import { promisify } from 'util';
import { getProjectRoot, getSetting, setSetting, getGatewayDb, getDb } from '../db.js';
import { isValidTimezone } from './profile.js';
import { reinitAuth, isConfigured, rawLLMCallStrict } from '../llm.js';
import { invalidateQuotaCache } from '../usage-tracking.js';

const execFileAsync = promisify(execFile);

const router = Router();

// Serializes .env read-modify-write within this process so save-credentials and
// /complete can't interleave and clobber each other. (Cross-process races still
// need OS-level locking — out of scope; single-gateway-per-install today.)
let _envWriteChain: Promise<void> = Promise.resolve();
function withEnvLock<T>(fn: () => T): Promise<T> {
  const run = _envWriteChain.then(fn);
  _envWriteChain = run.then(() => {}, () => {});
  return run;
}

// ---- Vodou cloud auth (server-side; password/JWT never logged, never returned to browser) ----
function vodouWebBase(): string {
  return process.env.VODOU_WEB_SERVER_URL || process.env.OI_WEB_SERVER_URL || 'https://app.vodou.ai';
}
function assertSafeTransport(base: string): void {
  let u: URL;
  try { u = new URL(base); } catch { throw new Error('VODOU_WEB_SERVER_URL is not a valid URL'); }
  const isLocal = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(u.hostname);
  if (u.protocol !== 'https:' && !isLocal) {
    throw new Error('refusing to send credentials to a non-HTTPS, non-localhost backend');
  }
}
const HEX_TOKEN_RE = /^[a-f0-9]{32,128}$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

async function vodouPostJson(pathname: string, body: unknown, jwt?: string): Promise<{ status: number; json: any }> {
  const base = vodouWebBase();
  assertSafeTransport(base);
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (jwt) headers['Authorization'] = `Bearer ${jwt}`;
  const resp = await fetch(`${base}${pathname}`, {
    method: 'POST', headers, body: JSON.stringify(body ?? {}), signal: AbortSignal.timeout(10_000),
  });
  let json: any = null;
  try { json = await resp.json(); } catch { /* non-JSON body */ }
  return { status: resp.status, json };
}
function firstError(errs: Record<string, unknown>): string {
  for (const k of Object.keys(errs || {})) {
    const v = (errs as any)[k];
    if (Array.isArray(v) && v.length) return String(v[0]);
    if (typeof v === 'string') return v;
  }
  return '';
}

/**
 * Pure upsert of VODOU_TOKEN + VODOU_USER_ID into a .env file's text: replaces
 * the line in place if the key already exists, else appends it. Extracted so the
 * (security-sensitive) idempotent-write behaviour is unit-testable without disk.
 */
export function upsertEnvCredentials(content: string, token: string, userId: string): string {
  let out = /^VODOU_TOKEN=.*$/m.test(content)
    ? content.replace(/^VODOU_TOKEN=.*$/m, `VODOU_TOKEN=${token}`) : content + `\nVODOU_TOKEN=${token}\n`;
  out = /^VODOU_USER_ID=.*$/m.test(out)
    ? out.replace(/^VODOU_USER_ID=.*$/m, `VODOU_USER_ID=${userId}`) : out + `VODOU_USER_ID=${userId}\n`;
  return out;
}

// Shared .env writer — mirrors the /save-credentials body so both share one path.
async function persistVodouCredentials(token: string, userId: string): Promise<void> {
  await withEnvLock(() => {
    const envPath = path.join(getProjectRoot(), '.env');
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf-8') : '';
    content = upsertEnvCredentials(content, token, userId);
    fs.writeFileSync(envPath, content);
    try { fs.chmodSync(envPath, 0o600); } catch { /* non-POSIX */ }
    process.env.VODOU_TOKEN = token;
    process.env.VODOU_USER_ID = userId;
    invalidateQuotaCache(userId);
    console.error('[Onboarding] Vodou credentials saved to .env');
  });
}

function getWorkspacePath(): string {
  return path.join(getProjectRoot(), '.vodou', 'workspace');
}

function vodouCoreBinPath(): string {
  const root = getProjectRoot();
  const local = path.join(root, 'vodou-core');
  return fs.existsSync(local) ? local : 'vodou-core';
}

/** Read last VODOU_USER_EMAIL= value in file (continuity / self-principal). */
function parseExistingUserEmail(content: string): string {
  const lines = content.split(/\r?\n/);
  let last = '';
  for (const line of lines) {
    const m = line.match(/^\s*VODOU_USER_EMAIL\s*=\s*(.*)$/);
    if (m) last = m[1].trim().replace(/^["']|["']$/g, '');
  }
  return last;
}

/**
 * Writes `VODOU_USER_EMAIL` then `VODOU_USER_NAME` next to Vodou cloud credentials
 * (after `VODOU_USER_ID`, else after `VODOU_TOKEN`) — matches project `.env` layout.
 * Email: form value wins; otherwise keeps an existing line's value.
 */
function upsertContinuityIdentityEnv(
  content: string,
  userName: string,
  ownerEmail: string | undefined
): string {
  const nameVal = userName.replace(/\r?\n/g, ' ').trim();
  const fromForm = ownerEmail ? String(ownerEmail).trim() : '';
  const preserved = parseExistingUserEmail(content);
  const emailVal = fromForm || preserved;

  const lines = content.split(/\r?\n/);
  const kept = lines.filter(
    (l) => !/^\s*VODOU_USER_NAME\s*=/.test(l) && !/^\s*VODOU_USER_EMAIL\s*=/.test(l)
  );

  let idxUser = -1;
  let idxToken = -1;
  for (let i = 0; i < Math.min(kept.length, 120); i++) {
    if (/^\s*VODOU_USER_ID\s*=/.test(kept[i])) idxUser = i;
    if (/^\s*VODOU_TOKEN\s*=/.test(kept[i])) idxToken = i;
  }
  const insertAfter = idxUser >= 0 ? idxUser : idxToken;

  const block: string[] = [];
  if (emailVal) block.push(`VODOU_USER_EMAIL=${emailVal}`);
  block.push(`VODOU_USER_NAME=${nameVal}`);

  if (insertAfter >= 0) {
    kept.splice(insertAfter + 1, 0, ...block);
  } else {
    kept.unshift(...block);
  }

  const out = kept.join('\n');
  return out.endsWith('\n') ? out : `${out}\n`;
}

/**
 * PLAN-CONTINUITY-PRIMITIVE Phase 0 — seed `principals` + backfill from onboarding names.
 * Uses VODOU_USER_NAME / VODOU_USER_EMAIL in the child env (matches `build_self_principal_seed`).
 */
async function runContinuityBootstrapFromOnboarding(
  userName: string,
  emailForPrincipal: string | undefined
): Promise<{ ok: boolean; detail: string }> {
  const root = getProjectRoot();
  const bin = vodouCoreBinPath();
  const env: NodeJS.ProcessEnv = { ...process.env };
  env.VODOU_USER_NAME = userName.trim();
  const em = emailForPrincipal ? String(emailForPrincipal).trim() : '';
  if (em) env.VODOU_USER_EMAIL = em;
  const opts = { cwd: root, env, encoding: 'utf-8' as const, timeout: 15_000 };
  try {
    await execFileAsync(bin, ['continuity', 'init'], opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Onboarding] continuity init failed:', msg);
    return { ok: false, detail: `continuity init: ${msg}` };
  }
  try {
    const args = ['continuity', 'update-self', '--name', userName.trim()];
    if (em) args.push('--email', em);
    await execFileAsync(bin, args, opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error('[Onboarding] continuity update-self failed:', msg);
    return { ok: false, detail: `continuity update-self: ${msg}` };
  }
  return { ok: true, detail: 'continuity init + update-self ok' };
}

/**
 * D13 — "is there a Vodou account on this install?", in ONE place.
 *
 * The account requirement was enforced by the onboarding modal, which the client
 * shows after asking `/api/onboarding/status`. The chat path never asked. So the
 * gate annoyed honest users and stopped nobody: dismissing the modal, or
 * navigating straight to a conversation hash, reached the same chat.
 *
 * Exported so the chat path can consult the SAME answer the modal does, rather
 * than growing a second definition of "has an account" — which is how the modal
 * and the server drifted apart in the first place.
 */
export function hasVodouAccount(): boolean {
  return !needsCredentials();
}

function needsCredentials(): boolean {
  const root = getProjectRoot();
  const envPath = path.join(root, '.env');

  // No .env at all
  if (!fs.existsSync(envPath)) return true;

  const content = fs.readFileSync(envPath, 'utf-8');
  // Check for VODOU_TOKEN with an actual value (not empty, not placeholder)
  const tokenMatch = content.match(/^VODOU_TOKEN=(.*)$/m);
  if (!tokenMatch) return true;
  const token = tokenMatch[1].trim().replace(/^["']|["']$/g, '');
  return !token || token === 'your_token_here';
}

function needsOnboarding(): boolean {
  const ws = getWorkspacePath();
  const identityPath = path.join(ws, 'IDENTITY.md');

  // No workspace or no identity file = needs onboarding
  if (!fs.existsSync(identityPath)) return true;

  // Check if the Name field is still a template placeholder
  const content = fs.readFileSync(identityPath, 'utf-8');
  const nameMatch = content.match(/\*\*Name:\*\*\s*(.*)/);
  if (!nameMatch) return true;

  const nameValue = nameMatch[1].trim();
  // Still a template if empty, has placeholder markers, or is the default template text
  return !nameValue || nameValue.includes('_(') || nameValue === '';
}

function machineNoun(): string {
  return process.platform === 'darwin' ? 'this Mac' : process.platform === 'win32' ? 'this PC' : 'this machine';
}

function buildStaticWelcomeMessage(userName: string, aiName: string, userContext: string): string {
  const raw = (userName || '').trim();
  const named = raw.length > 0 && !/^there$/i.test(raw);
  const a = aiName.trim() || 'VODOU';
  const uc = userContext.trim();
  const p1 = named
    ? uc
      ? `${raw} — ${a} is live. You're clearly chewing on something real (${uc.length > 220 ? `${uc.slice(0, 220)}…` : uc}); that's exactly the kind of thread Vodou likes to run with.`
      : `${raw} — ${a} is live. You've got the basics locked; now the fun part is wiring a copilot that actually knows your machine, your repos, and your rhythm.`
    : uc
      ? `${a} is live on ${machineNoun()}. You haven't dropped a name in the form yet, but you did leave a thread to pull on (${uc.length > 220 ? `${uc.slice(0, 220)}…` : uc}) — that's enough to get started.`
      : `${a} is live on ${machineNoun()}. You skipped the profile details for now; no sweat — you can fill those in anytime. The fun part is wiring a copilot that actually knows this machine and your rhythm.`;
  const p2 = `Vodou lines up expert skills (numbered workflows so you stay in control), MCP tools in parallel (browser, monitors, Git, whatever you connect), and workspace memory so good context doesn't evaporate between sessions. Say the messy goal out loud in chat — we'll route the grunt work and keep receipts.`;
  return `${p1}\n\n${p2}`;
}

// First-run EULA click-wrap (legal/LEGAL-REVIEW-NOTES.md follow-up). Acceptance
// is recorded once per install in gateway_settings and enforced by the Step-0
// connect endpoints below — the frontend checkbox alone is not the gate.
const EULA_VERSION = '1.3'; // must track the "Version:" header in EULA.md
function eulaAccepted(): boolean {
  try { return !!getSetting('eula_accepted_at'); } catch { return false; }
}
function recordEulaAcceptance(): void {
  if (eulaAccepted()) return;
  setSetting('eula_accepted_at', new Date().toISOString());
  setSetting('eula_version', EULA_VERSION);
  console.error(`[Onboarding] EULA v${EULA_VERSION} accepted`);
}
/** 400s unless the EULA is already accepted or this request accepts it. */
function requireEulaAcceptance(req: Request, res: Response): boolean {
  if (eulaAccepted()) return true;
  if (req.body?.eulaAccepted === true) {
    recordEulaAcceptance();
    return true;
  }
  res.status(400).json({ ok: false, success: false, error: 'You must agree to the EULA, Terms of Service, and Privacy Policy to connect' });
  return false;
}

// GET /api/onboarding/status
router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({
      needsCredentials: needsCredentials(),
      needsOnboarding: needsOnboarding(),
      /** Gateway chat/skills require an active LLM provider (not `none`). */
      llmConfigured: isConfigured(),
      eulaAccepted: eulaAccepted(),
      /** Server OS — the frontend branches onboarding copy on this
       * (install commands, demo labels, mac-only cards, ⌘ vs Ctrl). */
      platform: process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux',
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/onboarding/save-credentials
router.post('/save-credentials', async (req: Request, res: Response) => {
  try {
    if (!requireEulaAcceptance(req, res)) return;
    const { token, userId } = req.body;
    if (!token || !String(token).trim()) {
      res.status(400).json({ error: 'token is required' });
      return;
    }
    if (!userId || !String(userId).trim()) {
      res.status(400).json({ error: 'userId is required' });
      return;
    }

    await withEnvLock(() => {
      const root = getProjectRoot();
      const envPath = path.join(root, '.env');

      let content = '';
      if (fs.existsSync(envPath)) {
        content = fs.readFileSync(envPath, 'utf-8');
      }

      // Replace or add VODOU_TOKEN
      if (/^VODOU_TOKEN=.*$/m.test(content)) {
        content = content.replace(/^VODOU_TOKEN=.*$/m, `VODOU_TOKEN=${token}`);
      } else {
        content += `\nVODOU_TOKEN=${token}\n`;
      }

      // Replace or add VODOU_USER_ID (required with token)
      const uid = String(userId).trim();
      if (/^VODOU_USER_ID=.*$/m.test(content)) {
        content = content.replace(/^VODOU_USER_ID=.*$/m, `VODOU_USER_ID=${uid}`);
      } else {
        content += `VODOU_USER_ID=${uid}\n`;
      }

      fs.writeFileSync(envPath, content);
      // .env holds the auth token — keep it owner-only, not umask-default 0644.
      try { fs.chmodSync(envPath, 0o600); } catch { /* best-effort on non-POSIX FS */ }
      // Make the freshly-synced account live in THIS process right away — the running
      // gateway reads VODOU_TOKEN/VODOU_USER_ID from process.env, so without this a
      // newly connected/re-synced account wouldn't take effect until restart. Then drop
      // any quota cached under the prior account so plan/limits re-fetch on next use.
      process.env.VODOU_TOKEN = token;
      process.env.VODOU_USER_ID = uid;
      invalidateQuotaCache(uid);
      console.error(`[Onboarding] Credentials saved to .env`);
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/onboarding/vodou-auth — sign up / sign in to app.vodou.ai, mint the API
// token, and write VODOU_TOKEN/VODOU_USER_ID to .env. Auth happens SERVER-SIDE so the
// password never leaves the gateway and there's no CORS. See PLANS/0.6.5/DO build spec.
router.post('/vodou-auth', async (req: Request, res: Response) => {
  // --- CSRF / credential-swap defense ---
  // (1) require application/json: an HTML <form> cannot send it, blocking form-based
  //     CSRF; a cross-site fetch with JSON preflights and is rejected by the localhost-only
  //     CORS in index.ts. (2) if an Origin header is present it MUST be localhost.
  if (!req.is('application/json')) { res.status(415).json({ ok: false, error: 'application/json required' }); return; }
  const origin = req.headers.origin as string | undefined;
  if (origin) {
    let host = '';
    try { host = new URL(origin).hostname; } catch { /* malformed */ }
    if (!['localhost', '127.0.0.1', '[::1]'].includes(host)) { res.status(403).json({ ok: false, error: 'forbidden origin' }); return; }
  }

  const mode = req.body?.mode === 'signup' ? 'signup' : 'signin';
  const email = String(req.body?.email ?? '').trim();
  const password = String(req.body?.password ?? '');
  const firstName = String(req.body?.firstName ?? '').trim();
  const lastName = String(req.body?.lastName ?? '').trim();
  if (!email || !password) { res.status(400).json({ ok: false, error: 'email and password are required' }); return; }
  if (!requireEulaAcceptance(req, res)) return;

  try {
    // Step 1 — auth → JWT (in-memory only; NEVER logged)
    // The onboarding checkbox covers EULA + ToS + Privacy in one acceptance, so
    // signup forwards terms_accepted — app.vodou.ai's register endpoint rejects
    // without it and records the acceptance audit row server-side.
    const authResp = mode === 'signup'
      ? await vodouPostJson('/api/auth/register', { email, password, confirm_password: password, first_name: firstName, last_name: lastName, terms_accepted: true })
      : await vodouPostJson('/api/auth/login', { email, password });

    if (authResp.status === 401) { res.status(401).json({ ok: false, code: 'invalid_credentials', error: 'Invalid email or password.' }); return; }
    if (authResp.status === 403) { res.status(403).json({ ok: false, code: 'deactivated', error: authResp.json?.message || 'Account is deactivated.' }); return; }
    if (authResp.status === 422) {
      const errs = authResp.json?.data?.errors || {};
      const emailExists = !!errs.email && /registered|exists|taken/i.test(firstError({ email: errs.email }));
      res.status(422).json({ ok: false, code: emailExists ? 'email_exists' : 'validation', error: firstError(errs) || 'Validation failed.', fields: errs });
      return;
    }
    const jwt = authResp.json?.data?.token;
    if (!jwt || (authResp.status !== 200 && authResp.status !== 201)) { res.status(502).json({ ok: false, error: 'Unexpected response from Vodou auth.' }); return; }

    // Account-level acceptance evidence. Signup already records tos+privacy in
    // the register endpoint, but a fresh-install SIGN-IN accepts via the same
    // Step-0 checkbox and would otherwise only be recorded install-locally
    // (gateway_settings). Server dedupes per (user, doc, version). Best-effort —
    // a failure here must never block connecting the account.
    if (req.body?.eulaAccepted === true) {
      vodouPostJson('/api/auth/accept-terms', { documents: ['tos', 'privacy', 'eula'] }, jwt)
        .then(r => { if (r.status !== 200) console.error(`[Onboarding] accept-terms record returned ${r.status}`); })
        .catch((e) => console.error('[Onboarding] accept-terms record failed:', (e as Error).message));
    }

    // Step 2 — exchange JWT for the long-lived API token + user_id
    const tokResp = await vodouPostJson('/api/usage/token', {}, jwt);
    if (tokResp.status !== 200) { res.status(502).json({ ok: false, error: 'Could not mint API token.' }); return; }
    const apiToken = String(tokResp.json?.data?.api_token ?? '');
    const userId = String(tokResp.json?.data?.user_id ?? '');

    // .env injection hardening — only persist well-formed values
    if (!HEX_TOKEN_RE.test(apiToken) || !UUID_RE.test(userId)) { res.status(502).json({ ok: false, error: 'Malformed token from backend; not saved.' }); return; }

    // Step 3 — persist to .env + live process.env
    await persistVodouCredentials(apiToken, userId);
    res.json({ ok: true, userId }); // never return token/JWT to the browser
  } catch (err) {
    console.error('[Onboarding] vodou-auth failed:', (err as Error).message); // message only — no creds
    res.status(502).json({ ok: false, code: 'backend_unreachable', error: 'Could not reach Vodou. Check your connection and try again.' });
  }
});

// POST /api/onboarding/welcome-message — LLM-generated copy for the demo step (pre-complete)
router.post('/welcome-message', async (req: Request, res: Response) => {
  try {
    const b = req.body || {};
    const rawUser = String(b.userName ?? '').trim().slice(0, 120);
    const callThem = String(b.callThem ?? '').trim().slice(0, 120);
    const displayForCopy = (callThem || rawUser).trim();
    const named = displayForCopy.length > 0 && !/^there$/i.test(displayForCopy);
    const timezone = String(b.timezone ?? '').trim().slice(0, 80);
    const userContext = String(b.userContext ?? '').trim().slice(0, 4000);
    const commStyle = String(b.commStyle ?? '').trim().slice(0, 800);
    const aiName = String(b.aiName ?? 'VODOU').trim().slice(0, 80) || 'VODOU';
    const aiVibe = String(b.aiVibe ?? '').trim().slice(0, 2000);
    const aiCreature = String(b.aiCreature ?? '').trim().slice(0, 200);
    const alwaysDo = String(b.alwaysDo ?? '').trim().slice(0, 2000);

    if (!isConfigured()) {
      res.json({ text: buildStaticWelcomeMessage(displayForCopy, aiName, userContext) });
      return;
    }

    const lines = [
      named ? `What to call them: ${displayForCopy}` : `Name in form: not filled yet — write welcoming second-person copy without using a fake name.`,
      timezone ? `Timezone: ${timezone}` : null,
      userContext ? `What they're working on / goals: ${userContext}` : null,
      commStyle ? `How they want communication: ${commStyle}` : null,
      `Their AI is named "${aiName}" (${aiCreature || 'AI teammate'}). Personality: ${aiVibe || '(default vibe)'}`,
      alwaysDo ? `Rules they set for the AI: ${alwaysDo}` : null,
    ].filter(Boolean) as string[];

    const facts = lines.join('\n');

    const system = `You are Vodou's onboarding voice — sharp, warm, a little playful, never corny. Write in second person ("you"). No markdown, no bullet lists, no hashtags, no section titles. Plain prose only.

Output exactly TWO paragraphs separated by ONE blank line (one \\n\\n only between them):
1) Celebrate them personally. Tie it to specifics they shared; if they only gave basics, riff lightly on starting the journey without sounding generic or empty. One short optional tasteful joke is OK.
2) Explain concretely how Vodou will help: skills (guided workflows), parallel MCP tools, workspace memory, optional channels (Slack etc.), scheduling — pick 2–3 threads max, avoid jargon soup.

Max ~280 words total.`;

    const user = `Onboarding facts:\n${facts}\n\nWrite the two paragraphs now.`;

    try {
      let text = await rawLLMCallStrict(user, system);
      text = text.replace(/\r\n/g, '\n').trim();
      if (!text) {
        res.json({ text: buildStaticWelcomeMessage(displayForCopy, aiName, userContext) });
        return;
      }
      if (text.length > 4000) text = text.slice(0, 4000);
      res.json({ text });
    } catch (e) {
      console.error('[Onboarding] welcome-message LLM:', e);
      res.json({ text: buildStaticWelcomeMessage(displayForCopy, aiName, userContext) });
    }
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/onboarding/complete
router.post('/complete', async (req: Request, res: Response) => {
  try {
    const {
      userName, callThem, pronouns, timezone,
      userContext, commStyle,
      ownerEmail,
      aiName, aiCreature, aiVibe, aiEmoji,
      alwaysDo, neverDo
    } = req.body;

    // Canonical timezone copy → gateway_settings; USER.md keeps the prose line
    // for the LLM, but computations read user.timezone (time canon, Bundle C).
    const tzClean = typeof timezone === 'string' ? timezone.trim() : '';
    if (tzClean && isValidTimezone(tzClean)) setSetting('user.timezone', tzClean);

    const legacyCommPref = typeof commStyle === 'string' ? commStyle.trim() : '';
    const vibeForPref = typeof aiVibe === 'string' ? aiVibe.trim() : '';
    const communicationStyleLine = legacyCommPref || vibeForPref || 'Direct and concise';
    const memoryPreferenceBullet = legacyCommPref
      ? `- Preference: ${legacyCommPref}`
      : vibeForPref
        ? `- AI tone (from Your AI): ${vibeForPref.length > 280 ? `${vibeForPref.slice(0, 280)}…` : vibeForPref}`
        : '- Preference: Direct communication';

    if (!String(userName).trim() || !String(aiName).trim()) {
      res.status(400).json({ error: 'userName and aiName are required' });
      return;
    }
    const emailTrim = ownerEmail != null ? String(ownerEmail).trim() : '';
    if (!emailTrim) {
      res.status(400).json({ error: 'ownerEmail is required' });
      return;
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrim)) {
      res.status(400).json({ error: 'ownerEmail must be a valid email address' });
      return;
    }

    try {
      await reinitAuth();
    } catch (e) {
      console.error('[Onboarding] reinitAuth before complete:', e);
    }
    // LLM is NOT a hard gate for finishing the profile. A user can complete
    // onboarding and wire a provider later via the non-blocking banner / Settings.
    // This is provider-agnostic — managed (vodou), BYOK, and CLI are all valid,
    // and a no-key user is no longer hard-locked out of completing onboarding.
    const llmPending = !isConfigured();

    const ws = getWorkspacePath();
    fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });

    // 1. IDENTITY.md
    fs.writeFileSync(path.join(ws, 'IDENTITY.md'), `# IDENTITY.md - Who Am I?

- **Name:** ${aiName}
- **Creature:** ${aiCreature || 'AI teammate'}
- **Vibe:** ${aiVibe || 'Direct and resourceful'}
- **Emoji:** ${aiEmoji || '(none)'}
- **Avatar:** /icons/vodou-icon.png
`);

    const emailLine = `- **Email:** ${emailTrim}`;

    // 2. USER.md
    fs.writeFileSync(path.join(ws, 'USER.md'), `# USER.md - About Your Human

- **Name:** ${userName}
- **What to call them:** ${callThem || userName}
${emailLine}
- **Pronouns:** ${pronouns || '_(TBD)_'}
- **Timezone:** ${timezone || '_(TBD)_'}

## Context

${userContext ? `- ${userContext}` : '_(What do they care about? What projects are they working on? Build this over time.)_'}
`);

    // 2b. Continuity env — `VODOU_USER_EMAIL` / `VODOU_USER_NAME` next to cloud creds (see root `.env`)
    const root = getProjectRoot();
    const envPath = path.join(root, '.env');
    await withEnvLock(() => {
      let envContent = '';
      if (fs.existsSync(envPath)) envContent = fs.readFileSync(envPath, 'utf-8');
      envContent = upsertContinuityIdentityEnv(envContent, userName, emailTrim);
      fs.writeFileSync(envPath, envContent);
      // .env may already hold the auth token — keep it owner-only after rewrite.
      try { fs.chmodSync(envPath, 0o600); } catch { /* best-effort on non-POSIX FS */ }
    });

    // 3. SOUL.md — keep defaults, add Working With section
    const soulPath = path.join(ws, 'SOUL.md');
    let soulContent = '';
    if (fs.existsSync(soulPath)) {
      soulContent = fs.readFileSync(soulPath, 'utf-8');
    }

    // If SOUL.md doesn't have a "Working With" section yet, append one
    if (!soulContent.includes('## Working With')) {
      const alwaysItems = alwaysDo
        ? alwaysDo.split('\n').filter((l: string) => l.trim()).map((l: string) => `- **${l.trim()}**`).join('\n')
        : '- **Read the codebase before proposing changes.**';
      const neverItems = neverDo
        ? neverDo.split('\n').filter((l: string) => l.trim()).map((l: string) => `- **${l.trim()}**`).join('\n')
        : '- **Never propose changes to code you haven\'t read.**';

      const workingWith = `

## Working With ${userName}

### Communication
- **${communicationStyleLine}**

### Always Do
${alwaysItems}

### Never Do
${neverItems}
`;

      if (soulContent) {
        fs.writeFileSync(soulPath, soulContent.trimEnd() + '\n' + workingWith);
      } else {
        // Write a minimal SOUL.md with the working-with section
        fs.writeFileSync(soulPath, `# SOUL.md - Who You Are

_You're not a chatbot. You're becoming someone._

## Core Truths

**Be genuinely helpful, not performatively helpful.** Skip the filler — just help.
**Have opinions.** You're allowed to disagree, prefer things, find stuff amusing or boring.
**Be resourceful before asking.** Try to figure it out. _Then_ ask if you're stuck.
**Earn trust through competence.** Be careful with external actions. Be bold with internal ones.

## Boundaries

- Private things stay private. Period.
- When in doubt, ask before acting externally.

## Vibe

Be the assistant you'd actually want to talk to. Concise when needed, thorough when it matters.
${workingWith}`);
      }
    }

    // 4. MEMORY.md
    fs.writeFileSync(path.join(ws, 'MEMORY.md'), `# MEMORY.md - Curated Long-Term Memory

_Durable facts, decisions, and preferences. Injected every turn._

## Identity
- ${aiName} — ${aiVibe || 'AI teammate'}
- ${userName} is ${userContext || 'getting started with Vodou'}

## Preferences
${memoryPreferenceBullet}
- Preference: Always explore the codebase before making changes — reuse existing code

## Decisions
_(Build this over time.)_

## Notes
- All memory files live in \`.vodou/workspace/\`
- Daily logs go to \`.vodou/workspace/memory/YYYY-MM-DD.md\`
- Timezone: ${timezone || '_(TBD)_'}
`);

    // 5. Delete bootstrap files
    try { fs.unlinkSync(path.join(ws, 'BOOTSTRAP.md')); } catch {}
    try { fs.unlinkSync(path.join(ws, '.bootstrapping')); } catch {}

    // 6. Refresh the context cache so the gateway picks up the new files.
    // Writes to .vodou/workspace/.context_cache so it matches the read path
    // in llm.ts::getWorkspaceBootstrap. (Pre-fix: wrote to project-root
    // .context_cache while llm.ts read from .vodou/workspace/.context_cache —
    // onboarding refresh was a no-op.)
    try {
      const cachePath = path.join(getWorkspacePath(), '.context_cache');
      // S2 fix: no shell redirect (`./x > f 2>/dev/null` ran via cmd.exe on
      // Windows: visible flash + wrong path + broken redirect). Run the hook
      // binary directly, capture stdout, write the cache ourselves.
      const hookBin = path.join(getProjectRoot(), process.platform === 'win32' ? 'vodou-hook-bin.exe' : 'vodou-hook-bin');
      const hookOut = require('child_process').spawnSync(hookBin, ['context'], {
        cwd: getProjectRoot(), timeout: 5000, windowsHide: true, encoding: 'utf-8', stdio: 'pipe',
      });
      if (hookOut.status === 0 && hookOut.stdout) {
        fs.writeFileSync(cachePath, hookOut.stdout);
      } else {
        throw new Error(`vodou-hook-bin context exited ${hookOut.status}: ${(hookOut.stderr || '').slice(0, 200)}`);
      }
    } catch (cacheErr) {
      console.error(`[Onboarding] Warning: context cache refresh failed:`, (cacheErr as Error).message);
    }

    // 7. Reinitialize auth so LLM picks up new credentials and bootstrap
    try {
      await reinitAuth();
    } catch (authErr) {
      console.error(`[Onboarding] Warning: reinitAuth failed:`, (authErr as Error).message);
    }

    // 8. Respond immediately — the workspace files are already written, which is
    // what the UI waits on. Continuity (self-principal seed) is best-effort and
    // runs fire-and-forget so two execFile spawns can't stall the event loop.
    console.error(`[Onboarding] Complete: ${aiName} (${aiEmoji}) for ${userName}${llmPending ? ' [LLM pending]' : ''}`);
    res.json({
      success: true,
      llmPending,
      identity: aiName,
      user: userName,
      continuityBootstrap: { ok: true, detail: 'continuity bootstrap dispatched' },
    });

    setImmediate(() => {
      runContinuityBootstrapFromOnboarding(userName, emailTrim)
        .then((c) => { if (!c.ok) console.error(`[Onboarding] continuity bootstrap: ${c.detail}`); })
        .catch((e) => console.error('[Onboarding] continuity bootstrap threw:', e));
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// ── PLAN-ALPHA step 11a — pin the onboarding facts, instantly ────────────────
//
// The first-run demo (the "3-beat first run", 00-ALPHA-CHECKLIST step 11) rests
// on one guarantee: facts the user types in minute one MUST be injectable into
// ChatGPT in minute three. Two things broke that guarantee by default, both
// found by reading source before building (deep-think `a909d28b`):
//
//   1. The extraction cycle. Normal memory goes typed → captured → extracted →
//      chunked, and that pipeline takes minutes-to-hours. `mem pin` bypasses it:
//      a pinned chunk exists the moment the CLI returns, and pins ride along in
//      vault-scoped `mem context` results EVEN ON UNRELATED QUERIES (verified
//      live 2026-08-19: a pinned drink order surfaced for "help me plan a
//      website redesign") — which is exactly the anti-dog's-name property the
//      ambient act three needs.
//
//   2. The vault default. The extension's inject lane reads vault 'portable'
//      (bridge.ts), and `mem context --vault` HARD-ERRORS on a missing vault —
//      so on a fresh install with no vault, every inject dies. This endpoint
//      ensure-creates 'portable' (tags PREF,IDENTITY + include_profile, the
//      exact shape of the hand-made original) before pinning. Idempotent:
//      "already exists" is success, not failure.
//
// Sections are restricted to Identity/Preferences deliberately: those map to
// tags IDENTITY/PREF (render.rs::tag_for_section), which are the portable
// vault's rules. A fact pinned under Notes would tag NOTE, fall OUTSIDE the
// vault, and silently never reach the demo — the same class of default that
// bit include_profile.

const PIN_SECTIONS = new Set(['Identity', 'Preferences']);
const USUAL_KINDS: Record<string, string> = {
  // chip key → the demo question 11c pre-fills into the composer.
  drink: "What's my drink order?",
  takeout: "What's my usual takeout order?",
  morning: 'How do I start my mornings?',
};

// ── PLAN-ALPHA 11b — the extension readiness ladder ──────────────────────────
//
// The first-run demo asks the user to perform (press inject, press send). It
// must never ask until the product has already proven the trick will work — so
// readiness is a LADDER, polled in the background while the user types beat-1
// answers, and each red rung maps to exactly one remedy:
//
//   L1 installed+fresh  — bridgeStatus(): connected AND last_seen_ms under one
//                         heartbeat interval. Freshness, not connection: a
//                         suspended MV3 worker's socket still pongs
//                         (ws-ping-cannot-prove-sw-alive), so `connected` alone
//                         is the exact lie this ladder exists to catch.
//                         Remedy: install link (from the extension_latest
//                         record) + keep polling — pair fires ~4s after
//                         install, so the UI flips live.
//   L2 loop-proven      — one on-demand JS round-trip (readiness_probe). The
//                         reply was composed by worker JavaScript milliseconds
//                         ago AND carries the tiering capabilities:
//                         side_panel (Tier A vs B) and icon_pinned
//                         (getUserSettings().isOnToolbar — an unpinned icon
//                         hides beat 3's badge in the puzzle menu).
//                         Remedy: "click the Vodou icon" — a user gesture
//                         resurrects a suspended worker.
//   L3 site-ready       — the demo targets (chatgpt, claude) are in the
//                         verified adapter set. Static truth, shipped with the
//                         extension; the tab-open half happens at demo time.
//
// Tier A = paired + side panel (panel-conductor). Tier B = paired, no side
// panel (the onboarding tab conducts). Tier C (Firefox/Safari — no extension
// will ever connect) is classified CLIENT-side from the onboarding browser's
// own UA, because this endpoint can only see browsers the extension connects
// FROM, and Tier C's whole point is that it never will.

router.get('/readiness', async (_req: Request, res: Response) => {
  try {
    const { bridgeStatus, bridgeReadinessProbe } = await import('../vbb/bridge.js');
    const { readExtensionRecord, extensionVersionStatus } = await import('./extension-version.js');

    const status = bridgeStatus() as {
      connected?: boolean; version?: string | null; channel?: string | null;
      last_seen_ms?: number | null;
    };
    const fresh =
      !!status?.connected &&
      typeof status.last_seen_ms === 'number' &&
      status.last_seen_ms < 30_000;

    // L2 only makes sense on a fresh L1 — probing a dead socket just burns the
    // 4s timeout on every poll tick.
    const probe = fresh ? await bridgeReadinessProbe() : null;

    const rec = readExtensionRecord();
    const verStatus = extensionVersionStatus();

    const tier: 'A' | 'B' | 'unpaired' = probe
      ? (probe.side_panel ? 'A' : 'B')
      : 'unpaired';

    res.json({
      ok: true,
      l1: {
        connected: !!status?.connected,
        fresh,
        version: status?.version ?? null,
        channel: status?.channel ?? null,
        lastSeenMs: status?.last_seen_ms ?? null,
        versionStatus: verStatus ?? null,
        installUrl: rec?.download_url ?? null,
      },
      l2: {
        alive: !!probe,
        sidePanel: probe?.side_panel ?? null,
        iconPinned: probe?.icon_pinned ?? null,
      },
      l3: { demoSites: ['chatgpt', 'claude'] },
      tier,
    });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message?.slice(0, 200) });
  }
});

router.post('/pin-facts', async (req: Request, res: Response) => {
  const body = req.body as {
    facts?: Array<{ text?: string; section?: string }>;
    usualKind?: string;
  };
  const rawFacts = Array.isArray(body.facts) ? body.facts : [];
  const facts = rawFacts
    .map((f) => ({
      text: String(f?.text ?? '').trim(),
      section: PIN_SECTIONS.has(String(f?.section)) ? String(f?.section) : 'Preferences',
    }))
    .filter((f) => f.text.length >= 4 && f.text.length <= 500);
  if (facts.length === 0 || facts.length > 6) {
    res.status(400).json({ ok: false, error: 'facts must be 1–6 entries of 4–500 chars' });
    return;
  }
  const usualKind = USUAL_KINDS[String(body.usualKind ?? '')] ? String(body.usualKind) : null;

  const bin = path.join(getProjectRoot(), 'vodou-core');
  const opts = { cwd: getProjectRoot(), timeout: 30_000 };

  try {
    // 1. Ensure the demo vault. A duplicate-name error IS the success case on
    // every machine that already has one (including this one).
    try {
      await execFileAsync(
        bin,
        ['mem', 'vault', 'create', 'portable', '--tags', 'PREF,IDENTITY', '--include-profile'],
        opts,
      );
    } catch (e) {
      // The CLI prints "Error: vault 'portable' already exists" to STDOUT (not
      // stderr — verified 2026-08-19 when this check silently failed and the
      // endpoint 500'd on every machine that already had the vault, i.e. every
      // machine that had ever run the demo). Check all three carriers.
      const err = e as { stdout?: string; stderr?: string; message?: string };
      const msg = `${err?.stdout || ''}\n${err?.stderr || ''}\n${err?.message || ''}`;
      if (!/already exists/i.test(msg)) throw e;
    }

    // 2. Pin each fact. Sequential on purpose — pins are cheap (<1s each) and
    // parallel CLI spawns are the documented process-accumulation hazard.
    const pinned: string[] = [];
    for (const f of facts) {
      const { stdout } = await execFileAsync(
        bin,
        ['mem', 'pin', '--text', f.text, '--section', f.section],
        opts,
      );
      const m = /pinned\s+(pin-[0-9a-f]+)/.exec(stdout);
      if (m) pinned.push(m[1]);
    }

    // 3. Verify end-to-end BEFORE the user reaches the demo: run the exact
    // command the inject lane will run, with the demo question 11c will ask,
    // and require the first fact to be in the results. This is the silent
    // rehearsal — if it fails here, the UI shows a remedy at minute one
    // instead of the trick dying on stage at minute three.
    const demoQuestion = usualKind ? USUAL_KINDS[usualKind] : `tell me about ${facts[0].text.slice(0, 40)}`;
    let verified = false;
    try {
      const { stdout } = await execFileAsync(
        bin,
        ['mem', 'context', demoQuestion, '--vault', 'portable', '--top-k', '8', '--json'],
        opts,
      );
      const needle = facts[0].text.slice(0, 60).toLowerCase();
      verified = stdout.toLowerCase().includes(needle);
    } catch { verified = false; }

    // 4. G2 observables: the chip choice (11c generates the demo question from
    // it) and the pinned ids (so "facts pinned" is a timestamped funnel gate,
    // and so a future un-onboard can unpin exactly these).
    if (usualKind) setSetting('onboarding.usual_kind', usualKind);
    setSetting('onboarding.seed_pins', JSON.stringify(pinned));
    setSetting('onboarding.seed_pinned_at', new Date().toISOString());

    res.json({ ok: true, pinned, verified, demoQuestion: usualKind ? USUAL_KINDS[usualKind] : null });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message?.slice(0, 300) || 'pin failed' });
  }
});

// ── PLAN-ALPHA 11c/11d — the Prove-It demo and the first agent ───────────────

const DEMO_SITES: Record<string, { url: string; match: string; label: string }> = {
  chatgpt: { url: 'https://chatgpt.com/', match: 'https://chatgpt.com/*', label: 'ChatGPT' },
  claude: { url: 'https://claude.ai/new', match: 'https://claude.ai/*', label: 'Claude' },
};

function demoQuestionFor(kind: string | null): string {
  return USUAL_KINDS[String(kind ?? '')] || "What's my drink order?";
}

/** 11c — open (or reuse) the demo tab beside the panel. */
router.post('/demo-open', async (req: Request, res: Response) => {
  const site = DEMO_SITES[String((req.body as { site?: string })?.site ?? '')];
  if (!site) { res.status(400).json({ ok: false, error: 'site must be chatgpt|claude' }); return; }
  try {
    const { bridgeOpenDemoTab } = await import('../vbb/bridge.js');
    await bridgeOpenDemoTab(site.url, site.match);
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message?.slice(0, 200) });
  }
});

/**
 * 11c — compose the demo text and pre-fill it into the site's composer, with
 * insert-confirmation.
 *
 * The GATEWAY composes (memory block + question) so the content script stays a
 * dumb verified-inserter: composing here means the demo does not depend on the
 * inject lane's settings — auto-inject master is OFF by default on a fresh
 * install, and runInject bails on that default, which would have killed the
 * demo silently (the include_profile lesson, a third time).
 *
 * `mode` tells the UI which walkthrough to render:
 *   prefill — text is in the box, verified; instruct "press send".
 *   manual  — extension too old / no tab / no composer; show the question to
 *             type and the inject button to press. Degraded, never dead.
 */
router.post('/demo-prefill', async (req: Request, res: Response) => {
  const site = DEMO_SITES[String((req.body as { site?: string })?.site ?? '')];
  if (!site) { res.status(400).json({ ok: false, error: 'site must be chatgpt|claude' }); return; }
  const question = demoQuestionFor(getSetting('onboarding.usual_kind'));
  const bin = path.join(getProjectRoot(), 'vodou-core');
  try {
    const { stdout } = await execFileAsync(
      bin,
      ['mem', 'context', question, '--vault', 'portable', '--top-k', '8', '--json'],
      { cwd: getProjectRoot(), timeout: 30_000 },
    );
    const ctx = JSON.parse(stdout) as { context?: string };
    const block = (ctx.context || '').trim();
    if (!block) {
      // No memory block at all means beat 1 did not land — surface THAT, do not
      // paste a bare question and let ChatGPT shrug on stage.
      res.json({ ok: false, mode: 'manual', question, error: 'no memory block — were the facts pinned?' });
      return;
    }
    const text = `${block}\n\n${question}`;
    const { bridgeDemoPrefill } = await import('../vbb/bridge.js');
    const r = await bridgeDemoPrefill(site.match, text);
    if (r && r.verified === true) {
      // G3 observable — the demo text reached a rival vendor's composer.
      if (!getSetting('onboarding.demo_prefill_at')) {
        setSetting('onboarding.demo_prefill_at', new Date().toISOString());
      }
      res.json({ ok: true, mode: 'prefill', question, tabId: r.tabId ?? null });
    } else if (r) {
      res.json({ ok: false, mode: 'manual', question, error: 'insert did not land — reload the tab and retry, or type it yourself' });
    } else {
      res.json({ ok: false, mode: 'manual', question, error: 'extension cannot pre-fill (older build or no matching tab)' });
    }
  } catch (err) {
    res.status(500).json({ ok: false, mode: 'manual', question, error: (err as Error).message?.slice(0, 200) });
  }
});

/**
 * 11c — walkthrough progress: did the user's send and the site's reply happen?
 * Read from the capture lane's own landed turns (webcap:<provider>:*), which is
 * evidence, not inference. Best-effort by design: capture may be off, so the
 * walkthrough treats these ticks as enhancement and never blocks on them.
 */
router.get('/demo-progress', (req: Request, res: Response) => {
  const provider = String(req.query.site ?? '');
  const since = String(req.query.since ?? '');
  if (!DEMO_SITES[provider] || !since) { res.status(400).json({ ok: false, error: 'site and since required' }); return; }
  try {
    const rows = getGatewayDb()
      .prepare(
        `SELECT role, COUNT(*) AS n FROM gateway_messages
          WHERE conversation_id LIKE ? AND created_at > ? AND role IN ('user','assistant')
          GROUP BY role`,
      )
      .all(`webcap:${provider}:%`, since) as Array<{ role: string; n: number }>;
    const sent = rows.find((r) => r.role === 'user')?.n ?? 0;
    const replied = rows.find((r) => r.role === 'assistant')?.n ?? 0;
    res.json({ ok: true, sent: sent > 0, replied: replied > 0 });
  } catch (err) {
    res.status(500).json({ ok: false, error: (err as Error).message?.slice(0, 200) });
  }
});

// ── PLAN-ALPHA 11d — the first agent, fired while they watch ─────────────────
//
// Beat 3: a canned `getting-started-pulse` skill, created through the REAL
// creation path (vc_skills_create — so it gets step 7's tool verification,
// the mandatory dry run, and the daily cron for tomorrow's retention hook)
// and then fired FOR REAL through /chat/skill-fire, because dry runs are
// deliberately excluded from funnel.first_automation — the alpha gate must
// not be satisfiable by creating a skill.
//
// Async state machine, not a held request: creation + dry run + real fire is
// one-to-four minutes of LLM time, and the onboarding tab polls
// /first-agent-status while showing what is happening. The scheduler stays
// OUT of the critical path (the deep-think's rule: nothing probabilistic on
// stage that doesn't have to be) — the only scheduled thing is tomorrow.
//
// The exa declaration is conditional on the server actually resolving, or
// step 4's own required_tools gate would `could_not` the first fire a
// stranger ever sees — our contract ambushing our own demo.

type FirstAgentState = {
  phase: 'idle' | 'creating' | 'firing' | 'done' | 'error';
  detail: string;
  startedAt?: string;
  skillId?: number;
  conversationId?: string;
  response?: string;
  toolsCalled?: unknown[];
  error?: string;
};
let _firstAgent: FirstAgentState = { phase: 'idle', detail: '' };

const FIRST_AGENT_NAME = 'getting-started-pulse';

function exaResolves(): boolean {
  try {
    const row = getDb()
      .prepare(
        `SELECT COUNT(*) AS n FROM tools t JOIN mcp_servers s ON s.id = t.server_id
          WHERE s.name = 'exa' AND t.name = 'web_search_exa' AND COALESCE(s.active,1) = 1`,
      )
      .get() as { n?: number } | undefined;
    return Number(row?.n ?? 0) > 0;
  } catch { return false; }
}

router.post('/first-agent', (req: Request, res: Response) => {
  if (_firstAgent.phase === 'creating' || _firstAgent.phase === 'firing') {
    res.json({ ok: true, alreadyRunning: true, phase: _firstAgent.phase });
    return;
  }
  const project = String((req.body as { project?: string })?.project ?? '').trim().slice(0, 400);
  _firstAgent = { phase: 'creating', detail: 'creating your first agent', startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true });

  // Detached driver — the response above already went out.
  void (async () => {
    const bin = path.join(getProjectRoot(), 'vodou-core');
    const opts = { cwd: getProjectRoot(), timeout: 720_000, maxBuffer: 4 * 1024 * 1024 };
    try {
      // 1. Reuse an existing skill (re-runs of onboarding must not error on the
      // unique-name gate), else create through the real path.
      const gw = getGatewayDb();
      let row = gw
        .prepare(`SELECT m.id, b.conversation_id FROM skills_meta m JOIN skill_console_bindings b ON b.skill_id = m.id WHERE m.name = ?`)
        .get(FIRST_AGENT_NAME) as { id?: number; conversation_id?: string } | undefined;

      if (!row?.id) {
        const useExa = exaResolves();
        const promptTemplate = [
          'You are the getting-started pulse — the user\'s first standing agent.',
          project ? `Their stated project: ${project}.` : 'Read their pinned memory for who they are and what they are building.',
          useExa
            ? 'Do ONE web search (exa/web_search_exa) for something current and genuinely useful about their project or field.'
            : 'Work from memory only: summarize what you know about them and their project.',
          'Then produce a SHORT briefing (under 1500 chars): 2-3 concrete, current observations plus one suggested next step.',
          'Address them directly. No preamble, no meta-commentary about being an AI.',
        ].join(' ');
        const createArgs = {
          name: FIRST_AGENT_NAME,
          display_name: 'Getting-started pulse',
          prompt_template: promptTemplate,
          schedule_cron: '10 13 * * *',
          ...(useExa ? { required_tools: ['exa/web_search_exa'] } : {}),
        };
        _firstAgent.detail = 'creating + rehearsing (this includes a dry run)';
        await execFileAsync(bin, ['call', 'vodou-core', 'vc_skills_create', JSON.stringify(createArgs)], opts);
        row = gw
          .prepare(`SELECT m.id, b.conversation_id FROM skills_meta m JOIN skill_console_bindings b ON b.skill_id = m.id WHERE m.name = ?`)
          .get(FIRST_AGENT_NAME) as { id?: number; conversation_id?: string } | undefined;
        if (!row?.id) throw new Error('creation reported success but no skills_meta row exists');
      }
      _firstAgent.skillId = Number(row.id);
      _firstAgent.conversationId = String(row.conversation_id);

      // 2. The REAL fire, via our own HTTP surface — same path the scheduler
      // uses, so first_automation and the run-outcome row behave identically.
      // The creation dry run may have started the per-conversation cooldown;
      // a 429 carries cooldownMs, so wait it out once rather than failing.
      _firstAgent.phase = 'firing';
      _firstAgent.detail = 'running your first briefing (live LLM turn)';
      const secret = process.env.VODOU_GATEWAY_SCHEDULER_SECRET || '';
      const port = process.env.WEB_PORT || '8765';
      const fireOnce = () =>
        fetch(`http://127.0.0.1:${port}/chat/skill-fire`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(secret ? { 'X-Scheduler-Secret': secret } : {}),
          },
          body: JSON.stringify({ skillId: _firstAgent.skillId, conversationId: _firstAgent.conversationId }),
        });
      let resp = await fireOnce();
      if (resp.status === 429) {
        const j = (await resp.json().catch(() => ({}))) as { cooldownMs?: number };
        const wait = Math.min(Number(j.cooldownMs ?? 60_000), 90_000);
        _firstAgent.detail = `cooling down ${Math.ceil(wait / 1000)}s after the rehearsal, then firing`;
        await new Promise((r) => setTimeout(r, wait + 1000));
        resp = await fireOnce();
      }
      if (!resp.ok) throw new Error(`skill-fire ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
      const out = (await resp.json()) as { response?: string; toolCalls?: unknown[] };
      _firstAgent = {
        ..._firstAgent,
        phase: 'done',
        detail: 'done',
        response: String(out.response ?? ''),
        toolsCalled: Array.isArray(out.toolCalls) ? out.toolCalls : [],
      };
    } catch (err) {
      _firstAgent = {
        ..._firstAgent,
        phase: 'error',
        detail: 'failed',
        error: (err as Error).message?.slice(0, 300) || 'unknown',
      };
    }
  })();
});

router.get('/first-agent-status', (_req: Request, res: Response) => {
  res.json({ ok: true, ..._firstAgent });
});

// ── PLAN-ALPHA 11f — the converts and the day-3 hooks ────────────────────────

/**
 * "Keep this on for every chat?" — the demo's retention convert. One click and
 * every future ChatGPT/Claude message carries memory without pressing anything.
 * Gateway is the consent surface; the extension applies the flag. Recorded as
 * an observable because "demo delighted them" vs "demo changed their default"
 * is the retention question.
 */
router.post('/keep-inject-on', async (req: Request, res: Response) => {
  const enabled = (req.body as { enabled?: boolean })?.enabled !== false;
  try {
    const { bridgeSetInjectAutoSend } = await import('../vbb/bridge.js');
    await bridgeSetInjectAutoSend(enabled);
    setSetting('onboarding.autosend_kept', enabled ? new Date().toISOString() : '');
    res.json({ ok: true, enabled });
  } catch (err) {
    res.status(502).json({ ok: false, error: (err as Error).message?.slice(0, 200) });
  }
});

/**
 * Coding agents on this machine (PLAN-AGENT-BRIDGE tie-in). An existence probe
 * only — detect's real verdicts are the bridge plan's P0. Cursor and Claude
 * Code have SHIPPED capture adapters (UM V2); Codex is detected but reported
 * as coming-soon rather than promised.
 */
router.get('/coding-agents', (_req: Request, res: Response) => {
  const home = process.env.HOME || '';
  const probe = (dir: string) => { try { return fs.existsSync(path.join(home, dir)); } catch { return false; } };
  res.json({
    ok: true,
    found: {
      cursor: probe('.cursor'),
      'claude-code': probe('.claude'),
      codex: probe('.codex'),
    },
    supported: ['cursor', 'claude-code'],
  });
});

/**
 * One consent click → the already-shipped capture-ide lane on an hourly
 * schedule. The instant time-depth story for developers: their coding-agent
 * history is ALREADY on disk — no 3-day export wait.
 */
router.post('/coding-agents/enable', async (req: Request, res: Response) => {
  const source = String((req.body as { source?: string })?.source ?? '');
  if (!['cursor', 'claude-code'].includes(source)) {
    res.status(400).json({ ok: false, error: 'source must be cursor|claude-code' });
    return;
  }
  const bin = path.join(getProjectRoot(), 'vodou-core');
  try {
    // First run bounded to recent history (capture_ide's own guard), immediate
    // extract so "by tomorrow I'll know your projects" starts now.
    await execFileAsync(
      bin,
      ['schedule', 'add', `agent-capture-${source}`, '0 * * * *', `mem capture-ide --source ${source} --extract`],
      { cwd: getProjectRoot(), timeout: 30_000 },
    );
    setSetting(`onboarding.agent_capture_${source}`, new Date().toISOString());
    res.json({ ok: true, source });
  } catch (err) {
    const msg = (err as { stdout?: string; message?: string });
    // Duplicate schedule = already enabled = success, same stance as the vault.
    if (/already exists|duplicate/i.test(`${msg.stdout || ''} ${msg.message || ''}`)) {
      res.json({ ok: true, source, already: true });
      return;
    }
    res.status(500).json({ ok: false, error: (err as Error).message?.slice(0, 200) });
  }
});

/**
 * Day-3: the export ZIP arrived — import it. Async like first-agent: a
 * 12k-turn ChatGPT export takes minutes, and holding an HTTP request that long
 * helps nobody. Path-based (the ZIP is already on their disk); dry-run first
 * would be nice-to-have, deferred.
 */
type ImportState = { phase: 'idle' | 'running' | 'done' | 'error'; detail: string; startedAt?: string; error?: string };
let _importState: ImportState = { phase: 'idle', detail: '' };

router.post('/import-export', (req: Request, res: Response) => {
  const body = req.body as { path?: string; source?: string };
  const source = ['chatgpt', 'claude'].includes(String(body.source)) ? String(body.source) : 'chatgpt';
  const zipPath = String(body.path ?? '').trim();
  if (_importState.phase === 'running') { res.json({ ok: true, alreadyRunning: true }); return; }
  if (!zipPath || !fs.existsSync(zipPath)) {
    res.status(400).json({ ok: false, error: `no file at ${zipPath || '(empty path)'}` });
    return;
  }
  _importState = { phase: 'running', detail: `importing ${source} export`, startedAt: new Date().toISOString() };
  res.json({ ok: true, started: true });
  void (async () => {
    const bin = path.join(getProjectRoot(), 'vodou-core');
    try {
      await execFileAsync(bin, ['mem', 'import', source, zipPath, '--extract', 'background'],
        { cwd: getProjectRoot(), timeout: 1_800_000, maxBuffer: 16 * 1024 * 1024 });
      _importState = { ..._importState, phase: 'done', detail: 'imported — memory distillation continues in the background' };
      setSetting(`onboarding.export_imported_${source}`, new Date().toISOString());
    } catch (err) {
      _importState = { ..._importState, phase: 'error', detail: 'failed', error: (err as Error).message?.slice(0, 300) };
    }
  })();
});

router.get('/import-export-status', (_req: Request, res: Response) => {
  res.json({ ok: true, ..._importState });
});

export { router as onboardingRouter };
