/**
 * The optional Bridge step of the first hour (PLAN-MVP-CHAT-TO-LOCAL M4):
 * once per install, after a person has chatted a little and has never
 * connected the Vodou Bridge browser extension, the model may offer it in one
 * sentence. Prompt-driven on purpose — the simple chat has no settings page to
 * put a banner on, and a nudge the model can decline to fit in is better than
 * one bolted onto every reply.
 *
 * Registered as the `bridge_offer` lane in lanes.toml (lane canon rule 3).
 */
import { getSetting, setSetting, isRunConversation } from './db.js';
import { getFunnel } from './funnel.js';
import { bridgeStatus } from './vbb/bridge.js';
/** Vodou Bridge on the Chrome Web Store; the item id is permanent across updates. */
export const BRIDGE_STORE_URL = 'https://chromewebstore.google.com/detail/vodou-bridge/ehlanbbiaeelnimkakfffehoahimkjjf';
/** Gateway setting recording when the offer went out. Set = never again on this install. */
export const BRIDGE_OFFERED_KEY = 'onboarding.bridge_offer_at';
/** Not on a first message: the person should have had a useful exchange first. */
export const BRIDGE_OFFER_MIN_USER_MESSAGES = 3;
/** Person turns seen on this install (eligible conversations only). Its own
 *  counter: gateway_messages holds only the assistant side for REST /chat
 *  turns, so counting it read 0 forever and the offer never fired. */
export const BRIDGE_TURNS_KEY = 'onboarding.person_turns';
const liveDeps = {
    offeredAt: () => getSetting(BRIDGE_OFFERED_KEY),
    markOffered: () => setSetting(BRIDGE_OFFERED_KEY, new Date().toISOString()),
    paired: () => !!getFunnel().pair || !!bridgeStatus()?.connected,
    countTurn: () => {
        const n = (Number(getSetting(BRIDGE_TURNS_KEY)) || 0) + 1;
        setSetting(BRIDGE_TURNS_KEY, String(n));
        return n;
    },
};
export const BRIDGE_OFFER_TEXT = '\n\n<instruction>Optional, once: this person has not connected the Vodou Bridge browser extension. ' +
    'Answer their message first. Then, only if it fits naturally, end with ONE short sentence offering it: ' +
    'it lets Vodou remember what they tell ChatGPT or Claude in their browser too, and they can add it here: ' +
    `${BRIDGE_STORE_URL} — Say it plainly, don't repeat it in later replies, and drop it if the moment is wrong ` +
    '(they are upset, busy, or in the middle of a task).</instruction>';
/**
 * The rider to append to this turn's user body, or '' — and when it returns
 * the rider, the offer is recorded, so it goes out at most once per install.
 * `skip` is the caller's "this turn is not a person chatting" (guest turn,
 * numbered-menu reply). Never throws: a nudge must not break a turn.
 */
export function bridgeOfferRider(conversationId, skip, deps = liveDeps) {
    try {
        if (skip || !conversationId)
            return '';
        if (conversationId.startsWith('panel:') || conversationId.startsWith('brainctx:')
            || conversationId === 'vodou-heartbeat' || isRunConversation(conversationId))
            return '';
        if (deps.offeredAt())
            return '';
        if (deps.paired())
            return '';
        if (deps.countTurn() < BRIDGE_OFFER_MIN_USER_MESSAGES)
            return '';
        deps.markOffered();
        return BRIDGE_OFFER_TEXT;
    }
    catch {
        return '';
    }
}
