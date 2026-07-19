/** Bot Framework REST for TeamsChannel.send (MCP / proactive) — mirrors gateway helper. */
export type TeamsRouting = {
    serviceUrl: string;
    conversationId: string;
};
export declare function decodeTeamsRecipient(recipient: string): TeamsRouting | null;
export declare function getBotFrameworkAccessToken(appId: string, appPassword: string, tenantId?: string): Promise<string | null>;
export declare function sendTeamsActivity(params: {
    token: string;
    routing: TeamsRouting;
    text: string;
    botAppId: string;
}): Promise<string | null>;
export declare function updateTeamsActivity(params: {
    token: string;
    routing: TeamsRouting;
    activityId: string;
    text: string;
    botAppId: string;
}): Promise<boolean>;
//# sourceMappingURL=teams-outbound-rest.d.ts.map