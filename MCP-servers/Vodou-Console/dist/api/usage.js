/**
 * Usage API — API cost tracking and token accounting
 */
import { Router } from 'express';
import { getUsageSummary, getGatewayDb } from '../db.js';
export const usageRouter = Router();
// GET /api/usage — aggregated usage summary (by day/provider/model)
usageRouter.get('/', (req, res) => {
    try {
        const days = Math.min(parseInt(req.query.days) || 30, 365);
        const conversationId = req.query.conversation;
        const provider = req.query.provider;
        const summary = getUsageSummary({ days, conversationId, provider });
        // Calculate totals
        let totalInputTokens = 0, totalOutputTokens = 0, totalCostUsd = 0, totalRequests = 0;
        for (const row of summary) {
            totalInputTokens += row.total_input_tokens || 0;
            totalOutputTokens += row.total_output_tokens || 0;
            totalCostUsd += row.total_cost_usd || 0;
            totalRequests += row.requests || 0;
        }
        res.json({
            period: `${days} days`,
            totals: {
                requests: totalRequests,
                inputTokens: totalInputTokens,
                outputTokens: totalOutputTokens,
                totalTokens: totalInputTokens + totalOutputTokens,
                costUsd: Math.round(totalCostUsd * 10000) / 10000,
            },
            daily: summary,
        });
    }
    catch (err) {
        console.error('[Usage API] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
// GET /api/usage/today — quick summary for current day
usageRouter.get('/today', (req, res) => {
    try {
        const db = getGatewayDb();
        const row = db.prepare(`SELECT COUNT(*) as requests,
              SUM(input_tokens) as input_tokens,
              SUM(output_tokens) as output_tokens,
              SUM(cost_usd) as cost_usd,
              AVG(duration_ms) as avg_duration_ms
       FROM gateway_usage
       WHERE date(created_at) = date('now')`).get();
        res.json({
            date: new Date().toISOString().split('T')[0],
            requests: row?.requests || 0,
            inputTokens: row?.input_tokens || 0,
            outputTokens: row?.output_tokens || 0,
            totalTokens: (row?.input_tokens || 0) + (row?.output_tokens || 0),
            costUsd: Math.round((row?.cost_usd || 0) * 10000) / 10000,
            avgDurationMs: Math.round(row?.avg_duration_ms || 0),
        });
    }
    catch (err) {
        console.error('[Usage API] Error:', err.message);
        res.status(500).json({ error: err.message });
    }
});
