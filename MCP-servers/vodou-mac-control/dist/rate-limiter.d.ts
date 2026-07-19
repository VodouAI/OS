/**
 * Token-bucket rate limiter for mutation actions.
 * Default: 5 actions/sec, burst 10. traverse/screenshot/check_permission are free.
 */
/**
 * Try to consume a rate limit token.
 * Returns true if allowed, false if rate limited.
 */
export declare function tryConsume(toolName: string): boolean;
//# sourceMappingURL=rate-limiter.d.ts.map