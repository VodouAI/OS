/**
 * App blocklist — prevents automation of sensitive apps.
 * Default: Terminal, System Settings, Keychain.
 * Override via blocklist.json next to the server.
 */
import { readFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_BLOCKLIST = [
    'Terminal',
    'iTerm2',
    'iTerm',
    'System Settings',
    'System Preferences',
    'Keychain Access',
];
let blocklist = [...DEFAULT_BLOCKLIST];
// Load overrides from blocklist.json if present
const overridePath = join(__dirname, '..', 'blocklist.json');
if (existsSync(overridePath)) {
    try {
        const data = JSON.parse(readFileSync(overridePath, 'utf-8'));
        if (Array.isArray(data)) {
            blocklist = data;
        }
    }
    catch {
        // Keep defaults
    }
}
/**
 * Check if an app is blocked. Case-insensitive prefix match.
 * Returns the matched blocklist entry or null if allowed.
 */
export function isBlocked(appName) {
    const lower = appName.toLowerCase();
    for (const blocked of blocklist) {
        if (lower.startsWith(blocked.toLowerCase())) {
            return blocked;
        }
    }
    return null;
}
//# sourceMappingURL=blocklist.js.map