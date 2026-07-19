import type { DB } from '../db.js';
import { buildSkillChatArgs, type SkillRow } from './skill-console-handler.js';
import { ensureSkillConsoleLayerBWorkflow } from '../workflow-driver.js';

/**
 * Shared by HTTP POST /chat, WebSocket skill path, and POST /chat/skill-fire.
 * When `skillActive`, `ensureSkillConsoleLayerBWorkflow` runs before `buildSkillChatArgs`.
 */
export async function prepareSkillConsoleForLlm(
  db: DB,
  conversationId: string,
  skill: SkillRow,
  skillActive: boolean,
  userMessageForTemplate: string,
  runParamOverrides: Record<string, string>,
  fallbackPrompt: string,
): Promise<{ renderedPrompt: string; preferModel: string | null }> {
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
    return { renderedPrompt: fallbackPrompt, preferModel: null };
  }
  return buildSkillChatArgs(db, conversationId, userMessageForTemplate, skill, runParamOverrides);
}
