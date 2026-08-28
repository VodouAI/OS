/**
 * PLAN-MEMORY-ON-EVERY-PAGE P4 — per-site mode for page memory.
 *
 *   off      — Vodou does not look at this site: no page-match, no icon mark,
 *              no typing suggestions, no notes/links/stamps FROM it. Chosen by
 *              default for sensitive hosts (banks, health portals, tax, auth).
 *   suggest  — read the page identity and SHOW what memory has (panel tiers,
 *              icon, typing suggestions), but do not COLLECT from it: notes,
 *              📎 links and page stamps are refused for this host.
 *   collect  — suggest + collect. The default for everything else.
 *
 * Resolution: user override (setting `memory.page.sites`, a host→mode map)
 * > sensitive default (off) > global default (setting `memory.page.default_mode`,
 * 'collect'). Hosts are bare (no www.), lowercase; a rule on `example.com`
 * covers `sub.example.com` unless the subdomain has its own rule.
 *
 * The gateway is the authority: page-match/probe/note/link all consult this,
 * so the extension can only ever ask, never bypass.
 */
import { getSetting, setSetting } from './db.js';
export const SITE_MODES = ['off', 'suggest', 'collect'];
const SITES_KEY = 'memory.page.sites';
const DEFAULT_KEY = 'memory.page.default_mode';
/** Hosts where "look at the page I'm on" is a bad default. Substring/regex on
 *  the bare host. Deliberately broad; a user can override any of them. */
export const SENSITIVE_HOST_PATTERNS = [
    /(^|\.)(chase|wellsfargo|bankofamerica|citi|citibank|capitalone|usbank|pnc|truist|ally|discover|amex|americanexpress|schwab|fidelity|vanguard|robinhood|etrade|tdameritrade|coinbase|kraken|binance|paypal|venmo|cashapp|zelle|wise|sofi|chime)\.(com|net|org|co\.uk|ca)$/i,
    /(^|\.)(bank|banking|credit\s*union|creditunion|cu)\.[a-z.]+$/i,
    /(^|[.-])(bank|banking|creditunion)[.-]/i,
    /(^|\.)(mychart|kaiserpermanente|healthcare\.gov|medicare\.gov|cvs|walgreens|optum|unitedhealthcare|anthem|aetna|cigna|humana|bcbs|labcorp|questdiagnostics|zocdoc|goodrx|patientportal|followmyhealth|athenahealth|nextmd)\b/i,
    /(^|\.)(irs\.gov|ssa\.gov|turbotax|hrblock|taxact|intuit\.com|freetaxusa|studentaid\.gov|uscis\.gov|dmv\.[a-z.]+|login\.gov|id\.me)$/i,
    /^(login|accounts?|auth|sso|signin|sign-in|id|identity|secure|myaccount|passport|oauth)\./i,
    /(^|\.)(1password|lastpass|bitwarden|dashlane|keeper|nordpass|passbolt)\.(com|io|net|eu)$/i,
];
export function normalizeHost(h) {
    return String(h || '').trim().toLowerCase().replace(/^www\./, '').replace(/\.$/, '');
}
export function isSensitiveHost(host) {
    const h = normalizeHost(host);
    if (!h)
        return false;
    return SENSITIVE_HOST_PATTERNS.some((re) => re.test(h));
}
function readMap() {
    try {
        const raw = getSetting(SITES_KEY);
        if (!raw)
            return {};
        const obj = JSON.parse(raw);
        const out = {};
        if (obj && typeof obj === 'object') {
            for (const [k, v] of Object.entries(obj)) {
                const host = normalizeHost(k);
                if (host && SITE_MODES.includes(v))
                    out[host] = v;
            }
        }
        return out;
    }
    catch {
        return {};
    }
}
function writeMap(map) {
    setSetting(SITES_KEY, JSON.stringify(map));
}
export function defaultMode() {
    try {
        const v = getSetting(DEFAULT_KEY);
        return SITE_MODES.includes(v) ? v : 'collect';
    }
    catch {
        return 'collect';
    }
}
/** Resolve the mode for a host. Pure lookup; safe to call per request. */
export function getSiteMode(hostIn) {
    const host = normalizeHost(hostIn);
    const map = readMap();
    // Exact host, then each parent domain (a.b.example.com → b.example.com → example.com).
    const parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        const cand = parts.slice(i).join('.');
        if (map[cand])
            return { host, mode: map[cand], source: 'user', ruleHost: cand };
    }
    if (isSensitiveHost(host))
        return { host, mode: 'off', source: 'sensitive' };
    return { host, mode: defaultMode(), source: 'default' };
}
/** Set (or clear with null) the user rule for a host. Returns the resolved verdict. */
export function setSiteMode(hostIn, mode) {
    const host = normalizeHost(hostIn);
    if (!host || !/^[a-z0-9.-]+$/.test(host) || !host.includes('.'))
        throw new Error('not a host');
    const map = readMap();
    if (mode === null)
        delete map[host];
    else if (SITE_MODES.includes(mode))
        map[host] = mode;
    else
        throw new Error('mode must be off | suggest | collect');
    writeMap(map);
    return getSiteMode(host);
}
export function listSiteModes() {
    return Object.entries(readMap()).map(([host, mode]) => ({ host, mode })).sort((a, b) => a.host.localeCompare(b.host));
}
