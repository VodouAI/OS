import net from 'net';
import { promisify } from 'util';
import { execFile } from 'child_process';
const execFileAsync = promisify(execFile);
/**
 * Onboarding API — programmatic workspace bootstrap for fresh installs.
 * Checks if identity is set, writes USER/IDENTITY/SOUL/MEMORY files,
 * deletes BOOTSTRAP.md when done. No AI involvement.
 */

import { Router, Request, Response } from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getProjectRoot, setSetting, getSetting } from '../db.js';
import { migrateNamesToSettings } from './profile.js';
import { reinitAuth } from '../llm.js';

const router = Router();

function getWorkspacePath(): string {
  return path.join(getProjectRoot(), '.vodou', 'workspace');
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
  // PLAN-CONTEXT-THAT-MAINTAINS-ITSELF P11.2 — this parsed IDENTITY.md's Name
  // field to decide whether the wizard had run. IDENTITY.md is no longer
  // written by anything (its values live in gateway_settings), so the honest
  // signal is the settings themselves. The migration runs first so an install
  // that predates this change is not shown the wizard again for a name it
  // already gave.
  migrateNamesToSettings();
  const userName = (getSetting('user.display_name') || '').trim();
  const aiName = (getSetting('ai_name') || '').trim();
  return !userName && !aiName;
}

// GET /api/onboarding/status
/** Tell the engine an interview question was answered elsewhere (the wizard
 *  stored the value with its owner). State only — no pin is made here. */
function tellInterview(key: string, hint?: string): Promise<void> {
  return new Promise((resolve) => {
    let settled = false;
    const done = () => { if (!settled) { settled = true; resolve(); } };
    try {
      const sock = path.join(getProjectRoot(), '.vodou', 'daemon.sock');
      const c = net.createConnection({ path: sock }, () =>
        c.end(JSON.stringify({ cmd: 'interview_mark_answered', payload: { key, hint } }) + '\n'));
      c.setTimeout(5000);
      c.on('end', done); c.on('close', done); c.on('error', done);
      c.on('timeout', () => { try { c.destroy(); } catch { /* noop */ } done(); });
    } catch { done(); }
  });
}

router.get('/status', (_req: Request, res: Response) => {
  try {
    res.json({
      needsCredentials: needsCredentials(),
      needsOnboarding: needsOnboarding(),
    });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

// POST /api/onboarding/save-credentials
router.post('/save-credentials', (req: Request, res: Response) => {
  try {
    const { token, userId } = req.body;
    if (!token) {
      res.status(400).json({ error: 'token is required' });
      return;
    }

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

    // Replace or add VODOU_USER_ID
    if (userId) {
      if (/^VODOU_USER_ID=.*$/m.test(content)) {
        content = content.replace(/^VODOU_USER_ID=.*$/m, `VODOU_USER_ID=${userId}`);
      } else {
        content += `VODOU_USER_ID=${userId}\n`;
      }
    }

    fs.writeFileSync(envPath, content);
    console.error(`[Onboarding] Credentials saved to .env`);
    res.json({ success: true });
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
      aiName, aiCreature, aiVibe, aiEmoji,
      alwaysDo, neverDo
    } = req.body;

    if (!userName || !aiName) {
      res.status(400).json({ error: 'userName and aiName are required' });
      return;
    }

    const ws = getWorkspacePath();
    fs.mkdirSync(path.join(ws, 'memory'), { recursive: true });

    // PLAN-CONTEXT-THAT-MAINTAINS-ITSELF P11.4 (twin of Vodou-Console) — the
    // wizard writes to OWNERS. Names → gateway_settings; facts → pins; MEMORY.md
    // belongs to the daemon and is not written here. Seeds come from templates/.
    setSetting('ai_name', String(aiName || '').trim());
    setSetting('ai_vibe', String(aiVibe || '').trim());
    setSetting('ai_emoji', String(aiEmoji || '').trim());
    setSetting('user.display_name', String(callThem || userName || '').trim());
    if (pronouns) setSetting('user.pronouns', String(pronouns).trim());
    if (timezone) setSetting('user.timezone', String(timezone).trim());
    // The interview must not re-ask what the wizard just collected — the same
    // rule the USER.md migration keeps. The user's name also becomes a proper
    // Identity FACT in their words ("My name is …"), not a bare token.
    {
      const display = String(callThem || userName || '').trim();
      if (display) {
        try { await execFileAsync(path.join(getProjectRoot(), 'vodou-core'), ['mem', 'pin', '--text', `My name is ${display}`, '--section', 'Identity'], { cwd: getProjectRoot(), timeout: 20000 }); }
        catch (e) { console.error('[Onboarding] name pin failed (non-fatal):', (e as Error).message); }
        await tellInterview('a_name');
      }
      if (String(aiName || '').trim()) await tellInterview('a_ai_name');
    }
    {
      const pins: Array<{ text: string; section: string }> = [];
      const ctx = String(userContext || '').trim();
      if (ctx.length >= 4) pins.push({ text: ctx, section: 'Identity' });
      // (ExecDesk's wizard has no communication-style field; nothing to pin for it.)
      for (const raw of String(alwaysDo || '').split('\n')) { const t = raw.trim(); if (t.length >= 4) pins.push({ text: `Always: ${t}`, section: 'Preferences' }); }
      for (const raw of String(neverDo || '').split('\n')) { const t = raw.trim(); if (t.length >= 4) pins.push({ text: `Never: ${t}`, section: 'Preferences' }); }
      for (const f of pins.slice(0, 12)) {
        try { await execFileAsync(path.join(getProjectRoot(), 'vodou-core'), ['mem', 'pin', '--text', f.text, '--section', f.section], { cwd: getProjectRoot(), timeout: 20000 }); }
        catch (e) { console.error('[Onboarding] pin failed (non-fatal):', (e as Error).message); }
      }
    }
    // 3/4. SOUL.md and MEMORY.md are not written here any more (P8 / P11.4).
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
      execSync(`./vodou-hook-bin context > ${JSON.stringify(cachePath)} 2>/dev/null`, {
        cwd: getProjectRoot(), timeout: 5000, stdio: 'pipe'
      });
    } catch (cacheErr) {
      console.error(`[Onboarding] Warning: context cache refresh failed:`, (cacheErr as Error).message);
    }

    // 7. Reinitialize auth so LLM picks up new credentials and bootstrap
    try {
      await reinitAuth();
    } catch (authErr) {
      console.error(`[Onboarding] Warning: reinitAuth failed:`, (authErr as Error).message);
    }

    console.error(`[Onboarding] Complete: ${aiName} (${aiEmoji}) for ${userName}`);
    res.json({ success: true, identity: aiName, user: userName });
  } catch (err) {
    res.status(500).json({ error: (err as Error).message });
  }
});

export { router as onboardingRouter };
