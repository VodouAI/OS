import { buildSkillChatArgs } from './skill-console-handler.js';
import { ensureSkillConsoleLayerBWorkflow } from '../workflow-driver.js';
/**
 * Shared by HTTP POST /chat, WebSocket skill path, and POST /chat/skill-fire.
 * When `skillActive`, `ensureSkillConsoleLayerBWorkflow` runs before `buildSkillChatArgs`.
 */
export async function prepareSkillConsoleForLlm(db, conversationId, skill, skillActive, userMessageForTemplate, runParamOverrides, fallbackPrompt) {
    if (skillActive) {
        ensureSkillConsoleLayerBWorkflow({
            conversationId,
            skillName: skill.name,
            skillMetaId: skill.id,
            stoppingPointsJson: skill.stopping_points_json ?? null,
            currentPhaseDb: skill.current_phase ?? 0,
        });
    }
    if (!skillActive) {
        return { renderedPrompt: fallbackPrompt, preferModel: null, invokedTools: [] };
    }
    return buildSkillChatArgs(db, conversationId, userMessageForTemplate, skill, runParamOverrides);
}
