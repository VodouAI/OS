const TERMINAL_TYPES = new Set(['done', 'stopped', 'error']);
export function liveTurnTail(buf, now, maxIdleMs) {
    if (buf.length === 0)
        return [];
    let start = 0;
    for (let i = buf.length - 1; i >= 0; i--) {
        if (TERMINAL_TYPES.has(String(buf[i].payload?.type))) {
            start = i + 1;
            break;
        }
    }
    if (start >= buf.length)
        return [];
    const newest = buf[buf.length - 1];
    if (now - newest.ts > maxIdleMs)
        return [];
    return buf.slice(start);
}
