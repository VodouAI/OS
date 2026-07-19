import { describe, it, expect, vi } from 'vitest';
import {
  splitCommaRespectQuotes,
  parseToolPipeArgs,
  parseRecallTagBody,
  parseFirstInvokeToolTag,
  parseFirstInvokeScriptTag,
  expandInvokeToolAndRecall,
} from '../src/api/skill-template-expand.js';

describe('splitCommaRespectQuotes', () => {
  it('splits simple commas', () => {
    expect(splitCommaRespectQuotes('a=1,b=2')).toEqual(['a=1', 'b=2']);
  });
  it('keeps comma inside quotes', () => {
    expect(splitCommaRespectQuotes('q="a,b",x=1')).toEqual(['q="a,b"', 'x=1']);
  });
});

describe('parseToolPipeArgs', () => {
  it('parses comma-separated pairs', () => {
    expect(parseToolPipeArgs('maxResults=10,q="from:x"')).toEqual({
      maxResults: 10,
      q: 'from:x',
    });
  });
  it('parses JSON', () => {
    expect(parseToolPipeArgs('{"foo":1}')).toEqual({ foo: 1 });
  });
});

describe('parseRecallTagBody', () => {
  it('parses optional k', () => {
    expect(parseRecallTagBody('Acme deals|k=3')).toEqual({
      query: 'Acme deals',
      k: 3,
      scope: 'conversation',
    });
  });
  it('defaults k and scope', () => {
    expect(parseRecallTagBody('hello')).toEqual({ query: 'hello', k: 5, scope: 'conversation' });
  });
  it('parses scope=all', () => {
    expect(parseRecallTagBody('x|scope=all')).toEqual({ query: 'x', k: 5, scope: 'all' });
  });
  it('strips k and scope in either order', () => {
    expect(parseRecallTagBody('q|k=2|scope=all')).toEqual({ query: 'q', k: 2, scope: 'all' });
    expect(parseRecallTagBody('q|scope=all|k=2')).toEqual({ query: 'q', k: 2, scope: 'all' });
  });
});

describe('parseFirstInvokeToolTag', () => {
  it('parses nested JSON pipe', () => {
    const t = 'x {{invoke_tool:srv::t|{"a":{"b":1}} }} y';
    expect(parseFirstInvokeToolTag(t)).toEqual({
      index: 2,
      full: '{{invoke_tool:srv::t|{"a":{"b":1}} }}',
      server: 'srv',
      tool: 't',
      pipe: '{"a":{"b":1}}',
    });
  });
  it('parses empty pipe', () => {
    const t = '{{invoke_tool:m::cpu|}}';
    expect(parseFirstInvokeToolTag(t)).toMatchObject({ server: 'm', tool: 'cpu', pipe: '' });
  });
});

describe('parseFirstInvokeScriptTag', () => {
  it('parses server::script and nested JSON params', () => {
    const t = '{{invoke_script:npm::build|{"verbose":true} }}';
    expect(parseFirstInvokeScriptTag(t)).toEqual({
      index: 0,
      full: '{{invoke_script:npm::build|{"verbose":true} }}',
      server: 'npm',
      script: 'build',
      pipe: '{"verbose":true}',
    });
  });
  it('parses tag without pipe', () => {
    expect(parseFirstInvokeScriptTag('x {{invoke_script:my-srv::lint}} y')).toMatchObject({
      server: 'my-srv',
      script: 'lint',
    });
  });
});

describe('expandInvokeToolAndRecall', () => {
  it('replaces tool and recall in order', async () => {
    const callTool = vi.fn().mockResolvedValueOnce({ x: 1 }).mockResolvedValueOnce({ y: 2 });
    const recall = vi.fn().mockResolvedValue({
      items: [{ content: 'mem1', provenance_scope: 's1' }],
      latency_ms: 1,
      fallback_path: null,
      slo_state: 'warm',
    });
    const t = 'A {{invoke_tool:mon::cpu|}} B {{invoke_recall:q|k=2}} C';
    const out = await expandInvokeToolAndRecall(
      t,
      { principalId: 'p1', conversationId: 'c1' },
      { callTool, recall },
    );
    expect(callTool).toHaveBeenCalledWith('mon', 'cpu', {});
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({
        principal_id: 'p1',
        query: 'q',
        k: 2,
        scope_filter: { conversation_id: 'c1' },
      }),
    );
    expect(out).toContain('"x": 1');
    expect(out).toContain('[1] s1');
    expect(out).toContain('mem1');
    expect(out).toContain(' C');
  });

  it('uses scope=all when requested', async () => {
    const recall = vi.fn().mockResolvedValue({
      items: [],
      latency_ms: 0,
      fallback_path: null,
      slo_state: 'warm',
    });
    await expandInvokeToolAndRecall(
      '{{invoke_recall:q|scope=all}}',
      { principalId: 'p', conversationId: 'c' },
      {
        callTool: async () => ({}),
        recall,
      },
    );
    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ scope_filter: 'all', query: 'q' }),
    );
  });

  it('passes nested JSON args to callTool', async () => {
    const callTool = vi.fn().mockResolvedValue({ ok: true });
    await expandInvokeToolAndRecall(
      '{{invoke_tool:srv::tool|{"x":{"y":2}}}}',
      { principalId: 'p', conversationId: 'c' },
      {
        callTool,
        recall: async () => ({ items: [], latency_ms: 0, fallback_path: null, slo_state: 'warm' }),
      },
    );
    expect(callTool).toHaveBeenCalledWith('srv', 'tool', { x: { y: 2 } });
  });

  it('surfaces tool errors', async () => {
    const out = await expandInvokeToolAndRecall(
      '{{invoke_tool:bad::tool|}}',
      { principalId: 'p', conversationId: 'c' },
      {
        callTool: async () => {
          throw new Error('boom');
        },
        recall: async () => ({ items: [], latency_ms: 0, fallback_path: null, slo_state: 'warm' }),
      },
    );
    expect(out).toContain('[invoke_tool error: boom]');
  });

  it('invoke_script calls Vodou-script-executor execute_script with registry names', async () => {
    const callTool = vi.fn().mockResolvedValueOnce('stdout here');
    const out = await expandInvokeToolAndRecall(
      'A {{invoke_script:pkg::test|x=1}} B',
      { principalId: 'p', conversationId: 'c' },
      {
        callTool,
        recall: async () => ({ items: [], latency_ms: 0, fallback_path: null, slo_state: 'warm' }),
      },
    );
    expect(callTool).toHaveBeenCalledWith('Vodou-script-executor', 'execute_script', {
      server_name: 'pkg',
      script_name: 'test',
      params: { x: 1 },
    });
    expect(out).toContain('stdout here');
    expect(out).toContain(' B');
  });

  it('runs script before recall when script tag is first', async () => {
    const order: string[] = [];
    const callTool = vi.fn(async () => {
      order.push('script');
      return 's-out';
    });
    const recall = vi.fn(async () => {
      order.push('recall');
      return { items: [], latency_ms: 0, fallback_path: null, slo_state: 'warm' };
    });
    await expandInvokeToolAndRecall(
      '{{invoke_script:a::b|}} {{invoke_recall:hello}}',
      { principalId: 'p', conversationId: 'c' },
      { callTool, recall },
    );
    expect(order).toEqual(['script', 'recall']);
  });
});
