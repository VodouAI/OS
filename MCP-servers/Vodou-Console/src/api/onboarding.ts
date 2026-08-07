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
import { getProjectRoot, getSetting, setSetting } from '../db.js';
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

export { router as onboardingRouter };
