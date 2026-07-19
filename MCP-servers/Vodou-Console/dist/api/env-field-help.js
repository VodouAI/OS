/**
 * End-user descriptions for root `.env` keys — loaded from env-descriptions.json (single source).
 * After editing descriptions, run `npm run sync-env-example` at repo root to refresh `.env.example`.
 */
import descriptions from './env-descriptions.json' with { type: 'json' };
export const ENV_FIELD_HELP = descriptions;
const OTHER_BOILERPLATE = 'not documented in the shipped example file';
/** Rich help for UI: curated text only, no vague one-liner fallback. */
export function resolveEnvDescription(key, parsedFromExample) {
    const curated = ENV_FIELD_HELP[key];
    if (curated)
        return curated;
    const compact = parsedFromExample.replace(/\s+/g, ' ').trim();
    if (compact && !compact.includes(OTHER_BOILERPLATE)) {
        return compact.length > 500 ? compact.slice(0, 497) + '…' : compact;
    }
    return (`This entry (${key}) is only in your personal .env—it is not one of the keys listed in the default .env.example. ` +
        `Vodou components only honor names their code reads; this might be for a plugin, a script you added, or a typo. ` +
        `To learn more, search your install directory for the exact name ${key} (for example with ripgrep). ` +
        `After adding or changing variables, restart the gateway and worker so running processes reload .env.`);
}
