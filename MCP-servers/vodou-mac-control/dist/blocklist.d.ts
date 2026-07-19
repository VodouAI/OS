/**
 * App blocklist — prevents automation of sensitive apps.
 * Default: Terminal, System Settings, Keychain.
 * Override via blocklist.json next to the server.
 */
/**
 * Check if an app is blocked. Case-insensitive prefix match.
 * Returns the matched blocklist entry or null if allowed.
 */
export declare function isBlocked(appName: string): string | null;
//# sourceMappingURL=blocklist.d.ts.map