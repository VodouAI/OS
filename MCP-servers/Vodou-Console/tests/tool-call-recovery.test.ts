import { describe, it, expect } from 'vitest';
import { recoverToolCallsFromContent, repairToolArgs } from '../src/tool-call-recovery.js';

const KNOWN = ['vodou_core_call', 'write_file', 'read_file'];

describe('recoverToolCallsFromContent — real recoveries', () => {
  it('Qwen/vLLM <tool_call> XML leak', () => {
    const c = '<tool_call>\n{"name": "vodou_core_call", "arguments": {"server":"mcp-monitor","tool":"get_cpu_usage"}}\n</tool_call>';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r).toHaveLength(1);
    expect(r[0].function.name).toBe('vodou_core_call');
    expect(JSON.parse(r[0].function.arguments)).toEqual({ server: 'mcp-monitor', tool: 'get_cpu_usage' });
  });

  it('DeepSeek whole-content JSON call', () => {
    const c = '{"name":"write_file","arguments":{"path":"a.txt","content":"hi"}}';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r).toHaveLength(1);
    expect(r[0].function.name).toBe('write_file');
  });

  it('OpenAI-ish nested {function:{name,arguments}} shape', () => {
    const c = '{"function":{"name":"read_file","arguments":{"path":"x"}}}';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r).toHaveLength(1);
    expect(r[0].function.name).toBe('read_file');
  });

  it('parameters/args alias keys', () => {
    const c = '{"name":"read_file","parameters":{"path":"y"}}';
    const r = recoverToolCallsFromContent(c, undefined, KNOWN);
    expect(r).toHaveLength(1);
    expect(JSON.parse(r[0].function.arguments)).toEqual({ path: 'y' });
  });

  it('multiple <tool_call> tags → multiple calls with distinct ids', () => {
    const c = '<tool_call>{"name":"write_file","arguments":{"path":"1"}}</tool_call>\n<tool_call>{"name":"read_file","arguments":{"path":"2"}}</tool_call>';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r).toHaveLength(2);
    expect(new Set(r.map((x) => x.id)).size).toBe(2);
  });

  it('top-level array of calls', () => {
    const c = '[{"name":"write_file","arguments":{"path":"1"}},{"name":"read_file","arguments":{"path":"2"}}]';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r.map((x) => x.function.name)).toEqual(['write_file', 'read_file']);
  });

  it('fenced ```json call block', () => {
    const c = 'Sure:\n```json\n{"name":"read_file","arguments":{"path":"z"}}\n```';
    const r = recoverToolCallsFromContent(c, 'stop', KNOWN);
    expect(r).toHaveLength(1);
    expect(r[0].function.name).toBe('read_file');
  });
});

describe('recoverToolCallsFromContent — false-positive guards (the gate)', () => {
  it('unknown tool name is NEVER recovered', () => {
    const c = '{"name":"rm_rf_everything","arguments":{"path":"/"}}';
    expect(recoverToolCallsFromContent(c, 'stop', KNOWN)).toEqual([]);
  });

  it('normal prose mentioning a tool name is not a call', () => {
    expect(recoverToolCallsFromContent('You can use write_file to save the report.', 'stop', KNOWN)).toEqual([]);
  });

  it('a JSON code sample that is not a call (no name key) is ignored', () => {
    expect(recoverToolCallsFromContent('```json\n{"foo": 1, "bar": 2}\n```', 'stop', KNOWN)).toEqual([]);
  });

  it('a JSON object naming an unknown key shape is ignored', () => {
    expect(recoverToolCallsFromContent('{"result": "ok", "value": 42}', 'stop', KNOWN)).toEqual([]);
  });

  it('truncated response (finish_reason=length) is skipped', () => {
    const c = '{"name":"write_file","arguments":{"path":"a"';
    expect(recoverToolCallsFromContent(c, 'length', KNOWN)).toEqual([]);
  });

  it('empty content / empty known-list → []', () => {
    expect(recoverToolCallsFromContent('', 'stop', KNOWN)).toEqual([]);
    expect(recoverToolCallsFromContent('{"name":"write_file","arguments":{}}', 'stop', [])).toEqual([]);
  });
});

describe('repairToolArgs', () => {
  const schema = { type: 'object', properties: { path: { type: 'string' }, items: { type: 'array' }, opts: { type: 'object' }, note: { type: 'string' } }, required: ['path'] };

  it('passes valid JSON through', () => {
    expect(repairToolArgs('{"path":"a.txt"}', schema)).toEqual({ path: 'a.txt' });
  });

  it('accepts an already-parsed object', () => {
    expect(repairToolArgs({ path: 'a.txt' } as any, schema)).toEqual({ path: 'a.txt' });
  });

  it('repairs trailing-comma JSON', () => {
    expect(repairToolArgs('{"path":"a.txt",}', schema)).toEqual({ path: 'a.txt' });
  });

  it('repairs markdown-fenced JSON', () => {
    expect(repairToolArgs('```json\n{"path":"a.txt"}\n```', schema)).toEqual({ path: 'a.txt' });
  });

  it('coerces a stringified array for an array-typed field', () => {
    expect(repairToolArgs('{"path":"a","items":"[1,2,3]"}', schema)).toEqual({ path: 'a', items: [1, 2, 3] });
  });

  it('drops empty OPTIONAL fields but keeps required', () => {
    const r = repairToolArgs('{"path":"a","note":"","opts":{}}', schema);
    expect(r).toEqual({ path: 'a' }); // note "" and opts {} dropped (optional + empty)
  });

  it('keeps a required field even if empty', () => {
    expect(repairToolArgs('{"path":""}', schema)).toEqual({ path: '' });
  });

  it('irrecoverable garbage → {}', () => {
    expect(repairToolArgs('not json at all <<<', schema)).toEqual({});
    expect(repairToolArgs(undefined, schema)).toEqual({});
    expect(repairToolArgs(null, schema)).toEqual({});
  });

  it('no schema → parsed object unchanged', () => {
    expect(repairToolArgs('{"anything":1,"x":"y"}')).toEqual({ anything: 1, x: 'y' });
  });
});
