/**
 * Generated-types SDK for vodou-core (127.0.0.1:8766).
 *
 * Types come from src/core-api.d.ts, which is auto-generated from the live
 * /openapi.json by `npm run gen:core-api`. Do not edit core-api.d.ts by hand.
 *
 * Two ways to consume:
 *
 *   1. Typed request builder (preferred for new code):
 *        import { core } from './core-sdk.js';
 *        const r = await core.GET('/api/servers');
 *        if (r.error) throw new Error(r.error.error);
 *        const servers = r.data?.data?.servers;
 *
 *   2. Spec-aligned schema types (use anywhere you need a shape):
 *        import type { Schemas } from './core-sdk.js';
 *        function format(s: Schemas['Server']) { … }
 *
 * The hand-written facade in core-client.ts (`VodouCore.X()`) still works and
 * is now backed by the same per-install token loader exported here.
 */
import * as fs from 'fs';
import * as path from 'path';
import createClient from 'openapi-fetch';
const CORE_API_PORT = 8766;
const BASE_URL = `http://127.0.0.1:${CORE_API_PORT}`;
function readToken() {
    const root = process.env.VODOU_PROJECT_PATH || process.cwd();
    const tokenPath = path.join(root, '.vodou', 'console.token');
    try {
        return fs.readFileSync(tokenPath, 'utf-8').trim();
    }
    catch {
        throw new Error(`vodou-core token not found at ${tokenPath}. Start the daemon at least once to provision it.`);
    }
}
/**
 * Typed openapi-fetch client for vodou-core.
 *
 * Bearer token is read lazily from .vodou/console.token on first call so the
 * SDK can be imported before the daemon has provisioned the file.
 */
export const core = createClient({
    baseUrl: BASE_URL,
    headers: { 'Content-Type': 'application/json' },
});
let _tokenAttached = false;
core.use({
    onRequest({ request }) {
        if (!_tokenAttached) {
            // Lazy: only read once. If the token rotates, re-import or call resetAuth().
            try {
                request.headers.set('Authorization', `Bearer ${readToken()}`);
                _tokenAttached = true;
            }
            catch (err) {
                // Surface as 401 from the server side rather than throwing here so
                // callers get a normal error path.
            }
        }
        else {
            // openapi-fetch creates a new Request per call; re-attach.
            try {
                request.headers.set('Authorization', `Bearer ${readToken()}`);
            }
            catch {
                /* fallthrough → server returns 401 */
            }
        }
        return request;
    },
});
/** Force the next call to re-read the token from disk. */
export function resetAuth() {
    _tokenAttached = false;
}
