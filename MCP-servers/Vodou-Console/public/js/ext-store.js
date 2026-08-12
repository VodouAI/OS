/**
 * The Chrome Web Store identity for Vodou Bridge — actually one place this time.
 *
 * onboarding.js declared itself "ONE place for the store identity" and by this
 * release the same id was also literal in apps.js, lenses.js and lenses/shell.js,
 * with settings.js about to become the fifth. Four copies is where a store id
 * gets changed in three of them.
 *
 * The item id is permanent across extension updates, so the URL is correct
 * regardless of review state — what is NOT permanent is whether the listing is
 * publicly reachable, which is why LISTING_LIVE is a separate flag.
 *
 * Plain global, loaded early via a <script> tag in index.html, like safe.js.
 */
window.VodouExtStore = {
  ID: 'ehlanbbiaeelnimkakfffehoahimkjjf',

  /** Flipped to true when the listing went public — LIVE since 2026-08-04.
   *  If Google ever takes the listing down, flip this to false so the UI says
   *  "not yet" instead of linking to a 404. */
  LISTING_LIVE: true,

  installUrl() {
    return 'https://chromewebstore.google.com/detail/vodou-bridge/' + this.ID;
  },

  /** The install link as an anchor. `cls` lets each surface keep its own styling. */
  installLink(text, cls) {
    return '<a href="' + this.installUrl() + '" target="_blank" rel="noopener noreferrer"'
      + (cls ? ' class="' + cls + '"' : '') + '>' + (text || 'Get Vodou Bridge from the Chrome Web Store') + '</a>';
  },
};
