#!/usr/bin/env node
/**
 * Smoke test for §20.1 / §20.2 template expansion (no LLM).
 * Run: node scripts/test-skill-template-expand.mjs (from Vodou-Console dir, after npm run build)
 */
import { DatabaseSync } from 'node:sqlite';
import {
  mergeSkillParams,
  parseRunCommand,
  parseInvokePipeArgs,
  expandSkillPrompt,
  expandInvokeToolAndRecall,
} from '../dist/api/skill-template-expand.js';

const db = new DatabaseSync(':memory:');
db.exec(`
  CREATE TABLE skills_meta (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    prompt_template TEXT NOT NULL,
    is_active INTEGER NOT NULL DEFAULT 1,
    principal_id TEXT NOT NULL,
    parameters_json TEXT,
    param_overrides_json TEXT
  );
`);

db.prepare(
  `INSERT INTO skills_meta (name, display_name, prompt_template, principal_id, parameters_json)
   VALUES ('leaf', 'Leaf', 'Topic: {{param:topic}}. User: {{user_message}}', 'p1',
   ?)`,
).run(JSON.stringify([{ name: 'topic', default: 'DEFAULT' }]));

db.prepare(
  `INSERT INTO skills_meta (name, display_name, prompt_template, principal_id)
   VALUES ('parent', 'Parent', 'Pre: {{invoke_skill:leaf|topic=FromPipe}} Post: {{user_message}}', 'p1')`,
).run();

const merged = mergeSkillParams(
  JSON.stringify([{ name: 'topic', default: 'X' }]),
  JSON.stringify({ topic: 'Y' }),
  { topic: 'Z' },
);
if (merged.topic !== 'Z') throw new Error(`merge order: expected Z got ${merged.topic}`);

const pr = parseRunCommand('/run topic=Acme hello world');
if (pr.overrides.topic !== 'Acme' || pr.rest !== 'hello world') throw new Error(`parseRun: ${JSON.stringify(pr)}`);

const pipe = parseInvokePipeArgs('topic=foo|user_message=bar');
if (pipe.topic !== 'foo' || pipe.user_message !== 'bar') throw new Error('parseInvokePipeArgs');

const out = expandSkillPrompt(db, {
  template: 'P {{invoke_skill:leaf|topic=Inline}} U={{user_message}}',
  conversationId: 'workbench:skill-console:parent',
  userMessage: 'hi',
  history: '',
  principalId: 'p1',
  parametersJson: null,
  paramOverridesJson: null,
  runParamOverrides: {},
  skillId: 2,
});
if (!out.includes('Topic: Inline')) throw new Error(`missing inlined leaf: ${out}`);
if (!out.includes('U=hi')) throw new Error(`user_message lost: ${out}`);

const emptyRecall = async () => ({
  items: [],
  latency_ms: 0,
  fallback_path: null,
  slo_state: 'warm',
});
let sawScript = false;
const scriptOut = await expandInvokeToolAndRecall(
  '{{invoke_script:sm::job|}}',
  { principalId: 'p1', conversationId: 'c1' },
  {
    callTool: async (server, tool, args) => {
      if (server === 'Vodou-script-executor' && tool === 'execute_script') sawScript = true;
      return JSON.stringify(args);
    },
    recall: emptyRecall,
  },
);
if (!sawScript) throw new Error('invoke_script did not route to Vodou-script-executor');
if (!scriptOut.includes('sm') || !scriptOut.includes('job')) throw new Error(`invoke_script expand: ${scriptOut}`);

console.log('skill-template-expand smoke OK');
db.close();
