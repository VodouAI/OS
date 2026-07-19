/**
 * SSRF egress guard.
 *
 * The gateway binds to 127.0.0.1 but has NO per-request auth, and the lens /
 * link-preview fetch paths take URLs that the LLM (driven by prompt-injected
 * web content) or a drive-by CSRF page can control. Without validation those
 * become Server-Side Request Forgery: an attacker points a fetch at
 * `http://169.254.169.254/…` (cloud metadata), `http://127.0.0.1:8765/…`
 * (internal API), `http://192.168.x.x/…` (LAN), or `file://`/`gopher://`.
 *
 * `assertEgressAllowed(url)` enforces:
 *   1. scheme allowlist (http/https only)
 *   2. no userinfo / non-standard host shapes
 *   3. DNS-resolve the host and reject if ANY resolved address is
 *      loopback / private (RFC1918) / link-local / CGNAT / ULA / multicast /
 *      reserved, or the cloud-metadata addresses.
 *
 * Call it before the FIRST fetch AND on EVERY redirect target — a public host
 * that 302-redirects to a private IP is the classic bypass.
 *
 * Escape hatch: VODOU_ALLOW_PRIVATE_EGRESS=1 disables the IP-range checks (for
 * legit localhost lenses in dev). Scheme allowlist still applies. Default OFF.
 *
 * Residual risk: DNS rebinding (TOCTOU between this lookup and undici's own
 * resolve at connect time). Bounded by re-validating each redirect hop; full
 * mitigation (pin the validated IP via a custom undici dispatcher) is a
 * follow-on. The realistic attacker here uses a literal private IP / metadata
 * host, which this blocks outright.
 */
import dns from 'dns';
import net from 'net';
export class SsrfBlockedError extends Error {
    code = 'SSRF_BLOCKED';
    constructor(message) {
        super(message);
        this.name = 'SsrfBlockedError';
    }
}
function allowPrivate() {
    return process.env.VODOU_ALLOW_PRIVATE_EGRESS === '1';
}
/** Parse a dotted-quad IPv4 string to a 32-bit unsigned int, or null. */
function ipv4ToInt(ip) {
    const m = ip.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (!m)
        return null;
    let n = 0;
    for (let i = 1; i <= 4; i++) {
        const o = Number(m[i]);
        if (o > 255)
            return null;
        n = (n << 8) | o;
    }
    return n >>> 0;
}
// [networkBaseInt, prefixBits] — blocked IPv4 ranges.
const BLOCKED_V4 = [
    [ipv4ToInt('0.0.0.0'), 8], // "this" network
    [ipv4ToInt('10.0.0.0'), 8], // RFC1918
    [ipv4ToInt('100.64.0.0'), 10], // CGNAT
    [ipv4ToInt('127.0.0.0'), 8], // loopback
    [ipv4ToInt('169.254.0.0'), 16], // link-local (incl. 169.254.169.254 metadata)
    [ipv4ToInt('172.16.0.0'), 12], // RFC1918
    [ipv4ToInt('192.0.0.0'), 24], // IETF protocol assignments
    [ipv4ToInt('192.168.0.0'), 16], // RFC1918
    [ipv4ToInt('198.18.0.0'), 15], // benchmarking
    [ipv4ToInt('224.0.0.0'), 4], // multicast
    [ipv4ToInt('240.0.0.0'), 4], // reserved (incl. 255.255.255.255)
];
function isBlockedV4Int(n) {
    for (const [base, bits] of BLOCKED_V4) {
        const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
        if ((n & mask) === (base & mask))
            return true;
    }
    return false;
}
function isBlockedV4(ip) {
    const n = ipv4ToInt(ip);
    if (n === null)
        return true; // unparseable → treat as unsafe
    return isBlockedV4Int(n);
}
function isBlockedV6(addrRaw) {
    const addr = addrRaw.toLowerCase().split('%')[0]; // strip zone id
    // IPv4-mapped / -compatible (::ffff:a.b.c.d, ::a.b.c.d) → check the embedded v4.
    const mapped = addr.match(/(?:^|:)((?:\d{1,3}\.){3}\d{1,3})$/);
    if (mapped)
        return isBlockedV4(mapped[1]);
    // Hex form of an IPv4-mapped address (new URL() normalizes ::ffff:127.0.0.1
    // to ::ffff:7f00:1) → reconstruct the embedded v4 and check it.
    const hexMapped = addr.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
    if (hexMapped) {
        const n = ((parseInt(hexMapped[1], 16) << 16) | parseInt(hexMapped[2], 16)) >>> 0;
        return isBlockedV4Int(n);
    }
    if (addr === '::' || addr === '::1')
        return true; // unspecified / loopback
    if (addr.startsWith('fe8') || addr.startsWith('fe9') ||
        addr.startsWith('fea') || addr.startsWith('feb'))
        return true; // fe80::/10 link-local
    if (addr.startsWith('fc') || addr.startsWith('fd'))
        return true; // fc00::/7 ULA
    if (addr.startsWith('fec') || addr.startsWith('fed') ||
        addr.startsWith('fee') || addr.startsWith('fef'))
        return true; // fec0::/10 site-local (deprecated)
    if (addr.startsWith('ff'))
        return true; // ff00::/8 multicast
    return false;
}
function isBlockedAddress(address, family) {
    return family === 4 ? isBlockedV4(address) : isBlockedV6(address);
}
/**
 * Throws SsrfBlockedError if `urlString` is not a safe public http(s) target.
 * Resolves DNS; rejects if any resolved address is in a blocked range.
 */
export async function assertEgressAllowed(urlString) {
    let url;
    try {
        url = new URL(urlString);
    }
    catch {
        throw new SsrfBlockedError(`invalid URL: ${urlString}`);
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new SsrfBlockedError(`scheme not allowed: ${url.protocol} (only http/https)`);
    }
    if (url.username || url.password) {
        throw new SsrfBlockedError('URL userinfo (user:pass@) not allowed');
    }
    const host = url.hostname.replace(/^\[|\]$/g, ''); // strip [] from IPv6 literal
    if (!host)
        throw new SsrfBlockedError('empty host');
    if (allowPrivate())
        return; // dev escape hatch — scheme already validated
    // Explicit name blocks (don't trust the resolver to map these).
    const lowerHost = host.toLowerCase();
    if (lowerHost === 'localhost' || lowerHost.endsWith('.localhost') ||
        lowerHost === 'metadata.google.internal') {
        throw new SsrfBlockedError(`host not allowed: ${host}`);
    }
    // IP literal — check directly, no DNS.
    const literalFamily = net.isIP(host);
    if (literalFamily) {
        if (isBlockedAddress(host, literalFamily)) {
            throw new SsrfBlockedError(`destination IP not allowed: ${host}`);
        }
        return;
    }
    // Hostname — resolve and check every answer.
    let results;
    try {
        results = await dns.promises.lookup(host, { all: true });
    }
    catch (err) {
        throw new SsrfBlockedError(`DNS resolution failed for ${host}: ${err?.message || err}`);
    }
    if (!results.length)
        throw new SsrfBlockedError(`no DNS records for ${host}`);
    for (const r of results) {
        if (isBlockedAddress(r.address, r.family)) {
            throw new SsrfBlockedError(`${host} resolves to a disallowed address (${r.address})`);
        }
    }
}
