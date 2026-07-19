/**
 * Tiny URL glob matcher — no minimatch dependency.
 *
 * Patterns:
 *   *.allrecipes.com/recipe/*    matches recipes on any allrecipes subdomain
 *   github.com/*\/pull/*         matches PR URLs
 *   *                            matches anything (used by web.page fallback)
 *
 * Rules:
 *   - * inside a path segment matches any chars except `/`
 *   - *. at the start matches any host suffix (incl. zero subdomains)
 *   - Trailing /* matches any path
 *   - Scheme is optional in the pattern; both http and https match
 */
export function urlMatch(pattern, url) {
    if (pattern === '*')
        return true;
    let u;
    try {
        u = new URL(url);
    }
    catch {
        return false;
    }
    // Strip scheme from pattern if present
    let p = pattern.replace(/^https?:\/\//, '');
    // Split host and path
    const slashIdx = p.indexOf('/');
    const hostPart = slashIdx === -1 ? p : p.slice(0, slashIdx);
    const pathPart = slashIdx === -1 ? '' : p.slice(slashIdx);
    // Host match (handles *.example.com and example.com)
    if (!hostMatches(hostPart, u.hostname))
        return false;
    // Path match
    const target = u.pathname + u.search;
    if (!pathPart || pathPart === '/')
        return true;
    return globMatch(pathPart, target);
}
function hostMatches(pattern, host) {
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(2);
        return host === suffix || host.endsWith('.' + suffix);
    }
    return host === pattern;
}
function globMatch(pattern, target) {
    // Convert glob to regex. `*` matches any chars except `/`.
    // `**` matches any chars including `/`. Trailing `/*` allows any path.
    const re = new RegExp('^' +
        pattern
            .split('')
            .map((ch, i, arr) => {
            if (ch === '*') {
                // Look ahead for **
                if (arr[i + 1] === '*')
                    return '';
                if (i > 0 && arr[i - 1] === '*')
                    return '.*';
                return '[^/]*';
            }
            if ('.+?^${}()|[]\\'.includes(ch))
                return '\\' + ch;
            return ch;
        })
            .join('') +
        '$');
    return re.test(target);
}
