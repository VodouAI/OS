/**
 * P3 — one answer to "where is the gateway listening", for the TypeScript side.
 *
 * `src/gateway_url.rs` did this for the engine, and its docstring records why:
 * there were four answers and they disagreed, so an install whose gateway moved
 * off 8765 had components looking for it on two or three ports at once — and one
 * user's OAuth reconnect could never complete, because the link he was told to
 * click was on a port his gateway did not own.
 *
 * The gateway itself had the same disease and no cure: `WEB_PORT || '8765'` and
 * `GATEWAY_BASE_URL || http://localhost:${WEB_PORT || '8765'}` written out across
 * a dozen files, every one a chance to disagree with `index.ts:192` — which is
 * the only one that matters, because it is the line that BINDS.
 *
 * This mirrors the Rust module deliberately rather than inventing a second idea:
 * same precedence, same default, same reason.
 *
 * NOT covered here, because they genuinely cannot be:
 *   - the three browser-extension builds — they run in a page and cannot read
 *     repo config; each carries its own default by necessity
 *   - `install.sh` / `install-prebuilt.sh` / the release scripts — they run
 *     before an install exists
 *   - `.env.example` — it IS the source a user copies from
 */
/** The default the whole product agrees on. Matches `DEFAULT_WEB_PORT` in Rust. */
export const DEFAULT_WEB_PORT = 8765;
/**
 * The port this gateway listens on.
 *
 * `index.ts` binds with exactly this, so every other caller asking the same
 * question gets the same answer by construction rather than by everyone
 * remembering to write `|| '8765'`.
 */
export function gatewayPort() {
    const raw = process.env.WEB_PORT;
    const n = raw ? parseInt(raw, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : DEFAULT_WEB_PORT;
}
/**
 * The base URL to reach this gateway.
 *
 * `GATEWAY_BASE_URL` wins when set — it is how a caller reaches a gateway that
 * is not on this host at all — and otherwise the port above is used. Returned
 * without a trailing slash, because half the call sites appended a path and half
 * did not.
 */
export function gatewayBaseUrl() {
    const explicit = process.env.GATEWAY_BASE_URL;
    if (explicit && explicit.trim())
        return explicit.trim().replace(/\/$/, '');
    return `http://localhost:${gatewayPort()}`;
}
