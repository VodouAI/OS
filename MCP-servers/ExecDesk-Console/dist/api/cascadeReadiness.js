/**
 * GET /api/cascade/readiness
 *
 * Reads .vodou/phase0/cascade-readiness-*.jsonl for the last N days,
 * computes per-classification counts + cohort splits + decision rule,
 * returns the summary that decides whether to ship the full cascade plan.
 *
 * See PLANS/0.5.46/PHASE-0-INSTRUMENTATION-SPEC.md.
 */
import { Router } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import { getProjectRoot } from '../db.js';
import { CLASSIFICATIONS, SHORT_CIRCUIT_CLASSIFICATIONS } from '../phase0/classifier.js';
export const cascadeReadinessRouter = Router();
function phase0Dir() {
    return path.join(getProjectRoot(), '.vodou', 'phase0');
}
function listJsonlFiles(daysBack) {
    const dir = phase0Dir();
    if (!fs.existsSync(dir))
        return [];
    const files = [];
    const cutoff = Date.now() - daysBack * 86400 * 1000;
    for (const name of fs.readdirSync(dir)) {
        if (!name.startsWith('cascade-readiness-') || !name.endsWith('.jsonl'))
            continue;
        const full = path.join(dir, name);
        try {
            const stat = fs.statSync(full);
            if (stat.mtimeMs >= cutoff)
                files.push(full);
        }
        catch { /* skip */ }
    }
    return files.sort();
}
function readJsonl(file) {
    const out = [];
    try {
        const content = fs.readFileSync(file, 'utf-8');
        for (const line of content.split('\n')) {
            if (!line.trim())
                continue;
            try {
                out.push(JSON.parse(line));
            }
            catch { /* skip bad line */ }
        }
    }
    catch { /* skip bad file */ }
    return out;
}
function percentile(sorted, p) {
    if (!sorted.length)
        return 0;
    const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[idx];
}
function computeUserPotential(records) {
    if (!records.length)
        return 0;
    const hits = records.filter(r => SHORT_CIRCUIT_CLASSIFICATIONS.has(r.phase0_classification)).length;
    return hits / records.length;
}
cascadeReadinessRouter.get('/', (req, res) => {
    try {
        const days = Math.max(1, Math.min(parseInt(req.query.days || '7'), 30));
        const files = listJsonlFiles(days);
        const allRecords = files.flatMap(readJsonl);
        if (!allRecords.length) {
            return res.json({
                observation_window_days: days,
                total_prompts: 0,
                unique_users: 0,
                decision: 'insufficient_data',
                decision_rule_applied: 'need ≥ 50 prompts across ≥ 1 day',
                message: 'No Phase 0 records found. Wait for the observation window or check VODOU_PHASE0_DISABLED.',
                raw_files: files,
            });
        }
        // Counts by classification
        const byClassification = {};
        for (const c of CLASSIFICATIONS)
            byClassification[c] = 0;
        const byScope = {};
        const bySource = {};
        const toolCallDist = { '0': 0, '1': 0, '2': 0, '3-4': 0, '5+': 0 };
        const ttfts = [];
        const totals = [];
        const userRecords = new Map();
        for (const r of allRecords) {
            byClassification[r.phase0_classification] = (byClassification[r.phase0_classification] || 0) + 1;
            const scopeKey = r.scope || 'null';
            byScope[scopeKey] = (byScope[scopeKey] || 0) + 1;
            bySource[r.source] = (bySource[r.source] || 0) + 1;
            if (r.tool_calls_count === 0)
                toolCallDist['0']++;
            else if (r.tool_calls_count === 1)
                toolCallDist['1']++;
            else if (r.tool_calls_count === 2)
                toolCallDist['2']++;
            else if (r.tool_calls_count <= 4)
                toolCallDist['3-4']++;
            else
                toolCallDist['5+']++;
            if (r.ttft_ms != null)
                ttfts.push(r.ttft_ms);
            if (r.total_latency_ms != null)
                totals.push(r.total_latency_ms);
            const list = userRecords.get(r.user_hash) || [];
            list.push(r);
            userRecords.set(r.user_hash, list);
        }
        ttfts.sort((a, b) => a - b);
        totals.sort((a, b) => a - b);
        // Cohort splits — per-user short-circuit potential
        const userPotentials = [];
        for (const [user, recs] of userRecords) {
            userPotentials.push({ user, n: recs.length, potential: computeUserPotential(recs) });
        }
        const heavy = userPotentials.filter(u => u.n >= 50);
        const light = userPotentials.filter(u => u.n < 20);
        const heavyPotential = heavy.length
            ? heavy.reduce((s, u) => s + u.potential, 0) / heavy.length
            : null;
        const lightPotential = light.length
            ? light.reduce((s, u) => s + u.potential, 0) / light.length
            : null;
        userPotentials.sort((a, b) => a.potential - b.potential);
        const medianPotential = userPotentials.length
            ? userPotentials[Math.floor(userPotentials.length / 2)].potential
            : 0;
        // Aggregate short-circuit
        const totalShortCircuit = Array.from(SHORT_CIRCUIT_CLASSIFICATIONS).reduce((sum, c) => sum + (byClassification[c] || 0), 0);
        const overallPotential = allRecords.length ? totalShortCircuit / allRecords.length : 0;
        // Decision rule
        let decision;
        let recommendedPhases;
        if (overallPotential >= 0.25) {
            decision = 'ship_full_plan';
            recommendedPhases = [1, 2, 3, 4, 5, 6];
        }
        else if (overallPotential >= 0.10) {
            decision = 'ship_phases_1_to_3';
            recommendedPhases = [1, 2, 3];
        }
        else {
            decision = 'abandon_cascade';
            recommendedPhases = [];
        }
        // Ineligibility (claude_required + filter-rejected counts)
        const ineligibilityRate = ((byClassification['claude_required'] || 0) + (byClassification['multi_tool_workflow'] || 0))
            / allRecords.length;
        res.json({
            observation_window_days: days,
            first_event_at: Math.min(...allRecords.map(r => r.ts)),
            last_event_at: Math.max(...allRecords.map(r => r.ts)),
            total_prompts: allRecords.length,
            unique_users: userRecords.size,
            decision,
            decision_rule_applied: overallPotential >= 0.25 ? '≥25% short-circuit potential'
                : overallPotential >= 0.10 ? '10–24% short-circuit potential'
                    : '<10% short-circuit potential',
            overall_potential: Math.round(overallPotential * 1000) / 1000,
            median_user_potential: Math.round(medianPotential * 1000) / 1000,
            heavy_user_potential: heavyPotential != null ? Math.round(heavyPotential * 1000) / 1000 : null,
            light_user_potential: lightPotential != null ? Math.round(lightPotential * 1000) / 1000 : null,
            heavy_user_count: heavy.length,
            light_user_count: light.length,
            by_classification: byClassification,
            by_scope: byScope,
            by_source: bySource,
            tool_call_distribution: toolCallDist,
            ineligibility_rate: Math.round(ineligibilityRate * 1000) / 1000,
            latency_p50_ms: percentile(totals, 50),
            latency_p95_ms: percentile(totals, 95),
            latency_p99_ms: percentile(totals, 99),
            ttft_p50_ms: percentile(ttfts, 50),
            ttft_p95_ms: percentile(ttfts, 95),
            recommended_phases: recommendedPhases,
            raw_files: files.map(f => path.relative(getProjectRoot(), f)),
        });
    }
    catch (err) {
        console.error('[cascade-readiness] error:', err);
        res.status(500).json({ error: String(err) });
    }
});
