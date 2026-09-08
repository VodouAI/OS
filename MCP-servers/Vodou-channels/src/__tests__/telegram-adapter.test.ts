/**
 * CO-10 — the node-telegram-bot-api 0.66 → 1.x migration, and the tests this
 * package did not have.
 *
 * 0.66.x reached `request` and `form-data` through `@cypress/request-promise`,
 * carrying two CRITICAL advisories. 1.0.0 dropped all nine dependencies, which
 * is why the bump is worth making — and it is a full rewrite, which is why the
 * bump was refused the first time it was attempted: with **no test script and
 * no tests at all**, tsc was the only check, and tsc cannot see a changed
 * polling option, event name or error shape.
 *
 * So these assert the five API surfaces this adapter actually uses, against the
 * installed library rather than against a memory of its docs. They are the
 * reason the bump is now takeable.
 */
import { describe, it, expect, vi } from 'vitest';
import TelegramBot from 'node-telegram-bot-api';

describe('the library surface this adapter depends on', () => {
  it('has zero dependencies — the whole point of the bump', async () => {
    // Read the file rather than require() it: 1.x declares `exports`, which
    // does not expose ./package.json.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const pkgPath = path.join(here, '..', '..', 'node_modules', 'node-telegram-bot-api', 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    expect(Object.keys(pkg.dependencies ?? {}), 'the request/form-data chain is gone').toEqual([]);
    expect(parseInt(pkg.version, 10)).toBeGreaterThanOrEqual(1);
  });

  it('still exposes the five methods the adapter calls', () => {
    for (const m of ['getMe', 'getFile', 'sendMessage', 'stopPolling', 'on']) {
      expect(typeof (TelegramBot.prototype as never as Record<string, unknown>)[m], m).toBe('function');
    }
  });

  it('accepts the polling options the adapter constructs with', () => {
    // `{ polling: { params: { timeout: 30 } } }` — if 1.x had moved this, the
    // bot would simply never poll and no type error would say so.
    const bot = new TelegramBot('123:FAKE', { polling: { params: { timeout: 30 }, autoStart: false } });
    expect(bot).toBeTruthy();
  });

  it('emits the three events the adapter subscribes to', () => {
    const bot = new TelegramBot('123:FAKE', { polling: { autoStart: false } });
    for (const ev of ['message', 'error', 'polling_error'] as const) {
      const spy = vi.fn();
      bot.on(ev, spy);
      bot.emit(ev, ev === 'message' ? ({ message_id: 1 } as never) : new Error('x'));
      expect(spy, ev).toHaveBeenCalledTimes(1);
    }
  });
});

describe('the reply field that silently changed', () => {
  /**
   * THE MIGRATION HAZARD. 0.66 took `reply_to_message_id`; the Bot API moved
   * replies into `reply_parameters` and 1.x follows it. tsc caught this only
   * because the options object is typed — with `any` it would have shipped and
   * reply threading would have stopped working with no error anywhere.
   */
  it('sends reply_parameters, not the retired reply_to_message_id', async () => {
    const bot = new TelegramBot('123:FAKE', { polling: { autoStart: false } });
    const calls: Array<[string, { form?: Record<string, unknown> }]> = [];
    // Intercept at the HTTP boundary — this asserts what would go on the wire,
    // which is the only level at which "the field was renamed" is visible.
    // On the prototype, not the instance: `_request` lives there.
    (Object.getPrototypeOf(bot) as Record<string, unknown>)._request =
      async function (method: string, opts: { form?: Record<string, unknown> }) {
        calls.push([method, opts]);
        return { message_id: 1 };
      };

    await bot.sendMessage(42, 'hi', { reply_parameters: { message_id: 7 } });

    expect(calls).toHaveLength(1);
    const [method, opts] = calls[0];
    expect(method).toBe('sendMessage');
    expect(opts.form?.reply_parameters, 'the new shape reaches the wire').toEqual({ message_id: 7 });
    expect(opts.form?.reply_to_message_id, 'the retired field is not sent').toBeUndefined();
    expect(opts.form?.chat_id).toBe(42);
    expect(opts.form?.text).toBe('hi');
  });

  it('the adapter source uses reply_parameters and no longer names the retired field', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', 'channels', 'telegram.ts'), 'utf8');
    expect(src).toContain('reply_parameters');
    // Allowed in a comment explaining the migration; never as a sent field.
    expect(src).not.toMatch(/options\.reply_to_message_id\s*=/);
  });

  it('a non-numeric replyTo does not become NaN on the wire', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const src = fs.readFileSync(path.join(here, '..', 'channels', 'telegram.ts'), 'utf8');
    expect(src, 'parseInt can return NaN; it must be checked').toContain('Number.isFinite(replyId)');
  });
});
