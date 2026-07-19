/**
 * board_assignees — Step-0 orchestrator discovery.
 *
 * Returns the active subagent skills + per-assignee in-flight task counts.
 * Cross-DB JOIN: board.db::tasks ⨝ core.skills_registry.
 *
 * The orchestrator skill calls this first, before any board_create, to avoid
 * the Hermes-class silent-fail-on-unknown-assignee bug.
 */
import { z } from 'zod';
import { getReadDb } from '../db.js';
export const assigneesInputSchema = z.object({});
export async function handleAssignees(_args) {
    const db = getReadDb();
    // skills_registry may not be ATTACHed if core.db was missing at boot;
    // gracefully degrade to "tasks-only" discovery.
    let rows = [];
    try {
        rows = db.prepare(`SELECT s.name,
              s.is_active        AS active,
              json_extract(s.metadata_json, '$.vodou.preferred_model') AS preferred_model,
              json_extract(s.metadata_json, '$.vodou.persona_role')    AS persona_role,
              COALESCE(t.in_flight, 0) AS in_flight
         FROM core.skills_registry s
    LEFT JOIN (
            SELECT assignee, COUNT(*) AS in_flight
              FROM tasks
             WHERE status IN ('ready', 'running', 'pending_approval')
          GROUP BY assignee
         ) t ON t.assignee = s.name
        WHERE s.kind = 'subagent' AND s.is_active = 1
     ORDER BY s.name`).all();
    }
    catch (_e) {
        // Fallback: derive distinct assignees from tasks themselves
        rows = db.prepare(`SELECT assignee AS name,
              1 AS active,
              NULL AS preferred_model,
              NULL AS persona_role,
              COUNT(*) AS in_flight
         FROM tasks
        WHERE assignee IS NOT NULL
          AND status IN ('ready', 'running', 'pending_approval')
     GROUP BY assignee
     ORDER BY assignee`).all();
    }
    const entries = rows.map((r) => ({
        name: r.name,
        active: Boolean(r.active),
        in_flight: r.in_flight ?? 0,
        preferred_model: r.preferred_model ?? null,
        persona_role: r.persona_role ?? null,
    }));
    return {
        content: [{
                type: 'text',
                text: JSON.stringify({ count: entries.length, assignees: entries }, null, 2),
            }],
    };
}
