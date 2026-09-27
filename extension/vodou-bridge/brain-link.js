// Which "brain" does this install actually have?
//
// PLAN-BRIDGE-BRAIN-LINK §3.1. The graph moved into the gateway console at
// `#/memory?tab=map`; the standalone :8767 twin now only runs when the install
// sets VODOU_BRAIN_STANDALONE=1. The panel cannot know which world it is in, so
// the gateway tells it on `server_info`.
//
// The case that needs deciding is an OLD gateway, which sends no flag at all.
// Decided B (2026-08-27) on evidence rather than preference: the guard that
// makes the twin opt-in was ADDED in the same commit that moved the graph into
// the console (99ec6f61) — before it, start-vodou-services.sh started the brain
// web view unconditionally. So a gateway old enough to omit the field is a
// gateway that WAS running :8767, and :8767 is where its graph lives. Option A
// (absent → console route) would send exactly those users to a Memory page with
// no Map tab: nothing 404s, and the link does not do what it says.
//
// Absent is therefore NOT the same as false. `false` is a modern gateway saying
// "no twin here"; absent is an old gateway that predates the question.
globalThis.VodouBrainLink = {
  /**
   * @param {{brain_standalone?: boolean, brain_port?: number|null, gateway_url?: string}|null} st
   *        status as background.js reports it
   * @param {string} fallbackUrl  used when st carries no gateway_url
   * @returns {string} absolute http URL for the panel's `brain` link
   */
  brainLinkFor(st, fallbackUrl) {
    const u = new URL((st && st.gateway_url) || fallbackUrl || 'ws://127.0.0.1:8765/api/vbb');
    const host = u.hostname;                 // never hard-code loopback: the gateway may be tunnelled
    const gwPort = u.port || 8765;
    const standalone = (st && st.brain_standalone === true)
      // Option B: no field + a brain_port → an old gateway, whose twin was always on.
      || (st && st.brain_standalone === undefined && st.brain_port != null);
    return standalone
      ? `http://${host}:${(st && st.brain_port) || 8767}/`
      : `http://${host}:${gwPort}/#/memory?tab=map`;
  },
};
