import { describe, it, expect } from 'vitest';
import { spliceMemorySection, bootstrapForProject } from '../memory-render.js';
// PLAN-DYNAMIC-MEMORY-MD W15 — must mirror vodou-hook/src/main.rs splice_memory_section.
describe('spliceMemorySection', () => {
    const ctx = '## Context\n\n### MEMORY.md\n# old\n- stale bullet\n\n### HEARTBEAT.md\nbeat\n\n### How to execute\nsteps\n\n### Presence\n- Directory: /x\n\n';
    it('replaces only the MEMORY.md section, up to the next ### file header', () => {
        const out = spliceMemorySection(ctx, '# MEMORY.md — rendered from memory.db\n## Identity\n- Chad');
        expect(out).toContain('### MEMORY.md\n# MEMORY.md — rendered from memory.db\n## Identity\n- Chad\n\n### HEARTBEAT.md\nbeat');
        expect(out).not.toContain('stale bullet');
        expect(out).toContain('### How to execute\nsteps');
        expect(out).toContain('### Presence');
    });
    it('inserts a section after ## Context when none exists', () => {
        const out = spliceMemorySection('## Context\n\n### AGENTS.md\nx\n\n', '- r');
        expect(out.startsWith('## Context\n\n### MEMORY.md\n- r\n\n### AGENTS.md')).toBe(true);
    });
    it('prepends when there is no Context header at all', () => {
        expect(spliceMemorySection('plain', '- r')).toBe('### MEMORY.md\n- r\n\nplain');
    });
});
describe('bootstrapForProject', () => {
    it('returns the global bootstrap untouched for Default / no project / empty bootstrap', async () => {
        expect(await bootstrapForProject('G', undefined)).toBe('G');
        expect(await bootstrapForProject('G', 'proj_default')).toBe('G');
        expect(await bootstrapForProject('', 'proj_x')).toBe('');
    });
});
