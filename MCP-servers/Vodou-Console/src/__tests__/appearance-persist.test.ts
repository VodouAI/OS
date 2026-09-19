import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

/**
 * A Console palette pick must reach the shared workspace file.
 *
 * The Bridge panel, Brain and One all read GET /api/appearance, and the only
 * writer is the Console's persistAppearance(). The redesign staged at /next/
 * with that function short-circuited by a bare `return;` ("until cutover") so
 * the staging copy could not repaint the real console — and the cutover shipped
 * it as-is. For ten days every pick stayed in the Console's localStorage and
 * the panel kept wearing the last pick made in the OLD console, which looked
 * exactly like the panel's appearance setting being broken.
 */

const pub = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');
const html = readFileSync(join(pub, 'index.html'), 'utf8');

function persistBody(): string {
  const start = html.indexOf('function persistAppearance(');
  expect(start, 'persistAppearance missing from public/index.html').toBeGreaterThan(-1);
  const open = html.indexOf('{', start);
  let depth = 0;
  for (let i = open; i < html.length; i++) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}' && --depth === 0) return html.slice(open + 1, i);
  }
  throw new Error('unbalanced persistAppearance body');
}

describe('Console appearance persistence', () => {
  it('PUTs to /api/appearance', () => {
    const body = persistBody();
    expect(body).toContain("'/api/appearance'");
    expect(body).toMatch(/method:\s*'PUT'/);
  });

  it('has no early return ahead of the write', () => {
    const body = persistBody();
    const beforeFetch = body.slice(0, body.indexOf('fetch('));
    // Comments may mention the old `return;`; only live code counts.
    const code = beforeFetch.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
    expect(code).not.toMatch(/\breturn\b/);
  });

  it('is called by both setters and on boot', () => {
    const calls = html.match(/persistAppearance\(/g) ?? [];
    // definition + setTheme + setPalette + the boot seed
    expect(calls.length).toBeGreaterThanOrEqual(4);
  });
});
