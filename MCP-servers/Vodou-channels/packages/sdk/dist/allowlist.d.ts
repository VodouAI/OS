export interface AllowlistEntry {
    id: string;
    name?: string;
}
export interface AllowlistConfig {
    mode: 'on' | 'off';
    senders: AllowlistEntry[];
}
export type HandleNormalizer = (raw: string) => string;
export declare function allowlistPathForChannel(projectRoot: string, channel: string): string;
export declare function readAllowlist(path: string): AllowlistConfig;
export declare function isAllowed(config: AllowlistConfig, senderId: string, normalize: HandleNormalizer): boolean;
export declare class AllowlistWatcher {
    private config;
    private watcher;
    private path;
    private normalize;
    constructor(projectRoot: string, channel: string, normalize: HandleNormalizer);
    private reload;
    private startWatch;
    isAllowed(senderId: string): boolean;
    /** Check if ANY of the candidates passes the allowlist. */
    isAnyAllowed(candidates: string[]): boolean;
    /** Return the current AllowlistConfig snapshot. */
    get(): AllowlistConfig;
    /** @deprecated use get() */
    getConfig(): AllowlistConfig;
    destroy(): void;
    /** Alias for destroy() — matches channel teardown convention. */
    dispose(): void;
}
export declare function normalizeImessageHandle(raw: string): string;
export declare function normalizeWhatsappHandle(raw: string): string;
export declare function normalizeSlackHandle(raw: string): string;
export declare function normalizeDiscordHandle(raw: string): string;
export declare function normalizeTelegramHandle(raw: string): string;
export declare function normalizeTeamsHandle(raw: string): string;
export declare function normalizeGoogleChatHandle(raw: string): string;
export declare function normalizeSignalHandle(raw: string): string;
//# sourceMappingURL=allowlist.d.ts.map