const _children = new Map();
let _handlersInstalled = false;
/**
 * Register a freshly-spawned child.
 *
 * Self-unregistering: the `exit` listener removes it, so a child that ends
 * normally leaves no entry behind and a recycled PID cannot be killed by
 * mistake — the hazard `unregister` exists for on the Rust side.
 */
export function registerChild(child, label) {
    installExitHandlers();
    const pid = child.pid;
    if (typeof pid !== 'number')
        return child; // spawn failed; nothing to track
    _children.set(pid, { child, label, at: Date.now() });
    child.once('exit', () => { _children.delete(pid); });
    child.once('error', () => { _children.delete(pid); });
    return child;
}
export function unregisterChild(pid) {
    if (typeof pid === 'number')
        _children.delete(pid);
}
/** What are we running, and for how long. The question nothing could answer. */
export function activeChildren() {
    const now = Date.now();
    return [..._children.entries()].map(([pid, t]) => ({ pid, label: t.label, ageMs: now - t.at }));
}
/**
 * Kill every registered child. SIGTERM, then SIGKILL for survivors.
 *
 * Returns how many were signalled, so a caller can log it rather than guess.
 *
 * The delay is NOT awaited on the `exit` path: Node's `exit` handler is
 * synchronous-only, and anything asynchronous there is silently dropped. So the
 * escalation is scheduled and only actually runs when we were called with time
 * to spare (SIGINT/SIGTERM). On a hard exit the SIGTERM has still gone out,
 * which is the part that matters.
 */
export function killAllChildren(graceMs = 200) {
    const snapshot = [...(_children.values())];
    if (!snapshot.length)
        return 0;
    for (const { child } of snapshot) {
        try {
            child.kill('SIGTERM');
        }
        catch { /* already gone */ }
    }
    const escalate = () => {
        for (const { child } of snapshot) {
            try {
                if (child.exitCode === null && child.signalCode === null)
                    child.kill('SIGKILL');
            }
            catch { /* already gone */ }
        }
    };
    if (graceMs > 0)
        setTimeout(escalate, graceMs).unref?.();
    else
        escalate();
    return snapshot.length;
}
/**
 * Installed once, on first registration rather than at import: a module that
 * attaches process-wide signal handlers merely by being imported is a surprise,
 * and this one is imported by tests.
 */
function installExitHandlers() {
    if (_handlersInstalled)
        return;
    _handlersInstalled = true;
    process.on('exit', () => { killAllChildren(0); });
    for (const sig of ['SIGINT', 'SIGTERM']) {
        process.on(sig, () => {
            const n = killAllChildren();
            if (n)
                console.error(`[child-registry] ${sig}: signalled ${n} child process(es)`);
            // Re-raise so the default disposition still applies — swallowing the
            // signal here would make the gateway unkillable by ordinary means.
            process.removeAllListeners(sig);
            process.kill(process.pid, sig);
        });
    }
}
/** Test seam: drop all tracking without signalling anything. */
export function __resetChildRegistryForTest() {
    _children.clear();
}
