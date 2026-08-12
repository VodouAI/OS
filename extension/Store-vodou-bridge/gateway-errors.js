// Turning a failed call to the local Vodou app into something the operator can ACT on.
//
// The Chrome Web Store pushes an extension update to everyone at once; their
// desktop Vodou does not follow. So every feature we add here ships into a
// population where some apps have the matching route and some do not, and the
// raw form of that mismatch is "HTTP 404" — which reads as a broken extension
// rather than an app that needs updating.
//
// This logic started inside background.js as libraryError(), with "the Library"
// written into its message, so the next feature to hit the same wall would have
// had to reinvent it. It is now shared, and the feature name is a parameter.
//
// Loaded BOTH ways, exactly like sites.js: `import './gateway-errors.js'` from the
// module service worker, `<script src="gateway-errors.js">` from sidepanel.html.

globalThis.VodouGatewayError = {
  /**
   * PRECONDITION for treating 404 as "app too old".
   *
   * It only holds for a route that never 404s about its *subject*. The three the
   * extension calls qualify — POST /api/library/{url,text,match} answer 400 for
   * bad input and 500 for a failed ingest, never 404. Sibling routes in the same
   * router do NOT qualify: GET /api/library/:id returns 404 for "no such
   * document", and calling this on that response would tell someone to update a
   * perfectly current app. If you point a new caller at this helper, check the
   * route's own 404s first.
   */
  ROUTE_NEVER_404S_ON_SUBJECT: true,

  /** The message. One wording, so the fix reads the same wherever it surfaces. */
  tooOldFor(feature) {
    return `your Vodou app is too old for ${feature} — update Vodou and try again`;
  },

  /**
   * Is this the "route isn't mounted" shape? 404 is the real one; 501 is included
   * because a gateway that grows an explicit "not implemented" reply should land
   * in the same bucket rather than as a raw status the user has to interpret.
   */
  isMissingRoute(status) {
    return status === 404 || status === 501;
  },

  /**
   * Distinguish "old Vodou" from "not Vodou / not running".
   *
   * A 404 alone does not prove the app is merely old — something else could be
   * sitting on :8765, in which case "update Vodou" sends the user to do a thing
   * that will not help. /health is the cheap discriminator: it has been in the
   * gateway far longer than any route the extension calls (the stop script shells
   * out to it), so an app old enough to lack the feature still answers it.
   *
   * Only runs on the error path, so the extra round trip costs nothing in the
   * normal case. Any failure to reach /health is read as "not reachable" — the
   * conservative direction, since it produces a message about the app not running
   * rather than a false instruction to update.
   */
  async confirmsVodou(base) {
    if (!base) return false;
    try {
      const res = await fetch(base + '/health', { cache: 'no-store' });
      return res.ok;
    } catch (_) {
      return false;
    }
  },

  /**
   * The one entry point. Returns a sentence to show the operator.
   *
   * @param {any}    err     the thrown error (used for its message otherwise)
   * @param {number} status  HTTP status, if the call got that far
   * @param {string} feature human name of the feature, e.g. "the Library"
   * @param {string} base    gateway http base, e.g. "http://127.0.0.1:8765"
   */
  async describe(err, status, feature, base) {
    if (this.isMissingRoute(status)) {
      return (await this.confirmsVodou(base))
        ? this.tooOldFor(feature)
        : `cannot reach Vodou on ${base || 'the local gateway'} — is the app running?`;
    }
    return String(err && err.message ? err.message : err).slice(0, 160);
  },
};
