import { describe, it, expect } from 'vitest';
import { bridgeOfferRider, BRIDGE_OFFER_TEXT, BRIDGE_STORE_URL } from '../bridge-offer.js';
// M4's optional Bridge step: offered by the model, once per install, after a
// person has chatted a little, and never once the extension has paired.
function deps(over = {}) {
    // `messages` = person turns BEFORE this one
    const state = { offered: over.offered ?? null, paired: over.paired ?? false, messages: over.messages ?? 2, marks: 0 };
    const d = {
        offeredAt: () => state.offered,
        markOffered: () => { state.marks++; state.offered = 'now'; },
        paired: () => state.paired,
        countTurn: () => ++state.messages,
    };
    return { d, state };
}
describe('bridge offer — once, and only when it helps', () => {
    it('counts turns: nothing on the first two, the offer on the third', () => {
        const { d } = deps({ messages: 0 });
        expect(bridgeOfferRider('c', false, d)).toBe('');
        expect(bridgeOfferRider('c', false, d)).toBe('');
        expect(bridgeOfferRider('c', false, d)).toBe(BRIDGE_OFFER_TEXT);
    });
    it('offers on the third message of an unpaired install, and records it', () => {
        const { d, state } = deps();
        expect(bridgeOfferRider('conv-1', false, d)).toBe(BRIDGE_OFFER_TEXT);
        expect(state.marks).toBe(1);
        expect(BRIDGE_OFFER_TEXT).toContain(BRIDGE_STORE_URL);
    });
    it('never twice on one install', () => {
        const { d } = deps();
        expect(bridgeOfferRider('conv-1', false, d)).not.toBe('');
        expect(bridgeOfferRider('conv-2', false, d)).toBe('');
    });
    it('not before three messages', () => {
        const { d, state } = deps({ messages: 1 });
        expect(bridgeOfferRider('conv-1', false, d)).toBe('');
        expect(state.marks).toBe(0);
    });
    it('never once the extension has paired', () => {
        const { d } = deps({ paired: true, messages: 50 });
        expect(bridgeOfferRider('conv-1', false, d)).toBe('');
    });
    it('never on a guest turn / menu reply, or in panel, brain-context and heartbeat lanes', () => {
        const { d, state } = deps();
        expect(bridgeOfferRider('conv-1', true, d)).toBe('');
        for (const id of ['panel:x', 'brainctx:x', 'vodou-heartbeat', '']) {
            expect(bridgeOfferRider(id, false, d)).toBe('');
        }
        expect(state.marks).toBe(0);
    });
    it('a broken dependency never breaks the turn', () => {
        const d = { offeredAt: () => { throw new Error('db down'); }, markOffered: () => { }, paired: () => false, countTurn: () => 9 };
        expect(bridgeOfferRider('conv-1', false, d)).toBe('');
    });
});
