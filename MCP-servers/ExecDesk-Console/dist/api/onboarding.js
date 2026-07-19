/**
 * Onboarding API — programmatic workspace bootstrap for fresh installs.
 * Checks if identity is set, writes USER/IDENTITY/SOUL/MEMORY files,
 * deletes BOOTSTRAP.md when done. No AI involvement.
 */
import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { getProjectRoot } from '../db.js';
import { reinitAuth } from '../llm.js';
const router = Router();
function getWorkspacePath() {
    return path.join(getProjectRoot(), '.vodou', 'workspace');
}
function needsCredentials() {
    const root = getProjectRoot();
    const envPath = path.join(root, '.env');
    // No .env at all
    if (!fs.existsSync(envPath))
        return true;
    const content = fs.readFileSync(envPath, 'utf-8');
    // Check for VODOU_TOKEN with an actual value (not empty, not placeholder)
    const tokenMatch = content.match(/^VODOU_TOKEN=(.*)$/m);
    if (!tokenMatch)
        return true;
    const token = tokenMatch[1].trim().replace(/^["']|["']$/g, '');
    return !token || token === 'your_token_here';
}
function needsOnboarding() {
    const ws = getWorkspacePath();
    const identityPath = path.join(ws, 'IDENTITY.md');
    // No workspace or no identity file = needs onboarding
    if (!fs.existsSync(identityPath))
        return true;
    // Check if the Name field is still a template placeholder
    const content = fs.readFileSync(identityPath, 'utf-8');
    const nameMatch = content.match(/\*\*Name:\*\*\s*(.*)/);
    if (!nameMatch)
        return true;
    const nameValue = nameMatch[1].trim();
    // Still a template if empty, has placeholder markers, or is the default template text
    return !nameValue || nameValue.includes('_(') || nameValue === '';
}
// GET /api/onboarding/status
router.get('/status', (_req, res) => {
    try {
        res.json({
            needsCredentials: needsCredentials(),
            needsOnboarding: needsOnboarding(),
        });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/onboarding/save-credentials
router.post('/save-credentials', (req, res) => {
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
        }
        else {
            content += `\nVODOU_TOKEN=${token}\n`;
        }
        // Replace or add VODOU_USER_ID
        if (userId) {
            if (/^VODOU_USER_ID=.*$/m.test(content)) {
                content = content.replace(/^VODOU_USER_ID=.*$/m, `VODOU_USER_ID=${userId}`);
            }
            else {
                content += `VODOU_USER_ID=${userId}\n`;
            }
        }
        fs.writeFileSync(envPath, content);
        console.error(`[Onboarding] Credentials saved to .env`);
        res.json({ success: true });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
// POST /api/onboarding/complete
router.post('/complete', async (req, res) => {
    try {
        const { userName, callThem, pronouns, timezone, userContext, commStyle, aiName, aiCreature, aiVibe, aiEmoji, alwaysDo, neverDo } = req.body;
        if (!userName || !aiName) {
            res.status(400).json({ error: 'userName and aiName are required' });
            return;
        }
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
        // 2. USER.md
        fs.writeFileSync(path.join(ws, 'USER.md'), `# USER.md - About Your Human

- **Name:** ${userName}
- **What to call them:** ${callThem || userName}
- **Pronouns:** ${pronouns || '_(TBD)_'}
- **Timezone:** ${timezone || '_(TBD)_'}

## Context

${userContext ? `- ${userContext}` : '_(What do they care about? What projects are they working on? Build this over time.)_'}
`);
        // 3. SOUL.md — keep defaults, add Working With section
        const soulPath = path.join(ws, 'SOUL.md');
        let soulContent = '';
        if (fs.existsSync(soulPath)) {
            soulContent = fs.readFileSync(soulPath, 'utf-8');
        }
        // If SOUL.md doesn't have a "Working With" section yet, append one
        if (!soulContent.includes('## Working With')) {
            const styleNote = commStyle || 'Direct and concise';
            const alwaysItems = alwaysDo
                ? alwaysDo.split('\n').filter((l) => l.trim()).map((l) => `- **${l.trim()}**`).join('\n')
                : '- **Read the codebase before proposing changes.**';
            const neverItems = neverDo
                ? neverDo.split('\n').filter((l) => l.trim()).map((l) => `- **${l.trim()}**`).join('\n')
                : '- **Never propose changes to code you haven\'t read.**';
            const workingWith = `

## Working With ${userName}

### Communication
- **${styleNote}**

### Always Do
${alwaysItems}

### Never Do
${neverItems}
`;
            if (soulContent) {
                fs.writeFileSync(soulPath, soulContent.trimEnd() + '\n' + workingWith);
            }
            else {
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
${commStyle ? `- Preference: ${commStyle}` : '- Preference: Direct communication'}
- Preference: Always explore the codebase before making changes — reuse existing code

## Decisions
_(Build this over time.)_

## Notes
- All memory files live in \`.vodou/workspace/\`
- Daily logs go to \`.vodou/workspace/memory/YYYY-MM-DD.md\`
- Timezone: ${timezone || '_(TBD)_'}
`);
        // 5. Delete bootstrap files
        try {
            fs.unlinkSync(path.join(ws, 'BOOTSTRAP.md'));
        }
        catch { }
        try {
            fs.unlinkSync(path.join(ws, '.bootstrapping'));
        }
        catch { }
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
        }
        catch (cacheErr) {
            console.error(`[Onboarding] Warning: context cache refresh failed:`, cacheErr.message);
        }
        // 7. Reinitialize auth so LLM picks up new credentials and bootstrap
        try {
            await reinitAuth();
        }
        catch (authErr) {
            console.error(`[Onboarding] Warning: reinitAuth failed:`, authErr.message);
        }
        console.error(`[Onboarding] Complete: ${aiName} (${aiEmoji}) for ${userName}`);
        res.json({ success: true, identity: aiName, user: userName });
    }
    catch (err) {
        res.status(500).json({ error: err.message });
    }
});
export { router as onboardingRouter };
