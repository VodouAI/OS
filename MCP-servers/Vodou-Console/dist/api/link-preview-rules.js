/**
 * What a link preview card is allowed to say, decided in one place.
 *
 * The chat draws a card under a reply for the links in it. Two ways that went
 * wrong (2026-09-15): some sites answer a server fetch with a stub page, so
 * Reddit threads all previewed as `title: "Reddit"`, and nothing stopped a card
 * that only repeats the site name from being drawn. A reply listing 15 threads
 * showed three identical "Reddit · www.reddit.com" cards.
 */
/**
 * The oEmbed endpoint to ask instead of the HTML page, for sites whose page is
 * a stub to a server fetch. Reddit's oEmbed answers only for a thread
 * (`/comments/`); a subreddit URL is a 400 there, so it is not routed.
 */
export function oembedEndpointFor(u) {
    const host = u.hostname.toLowerCase();
    if ((host === 'reddit.com' || host.endsWith('.reddit.com')) && u.pathname.includes('/comments/')) {
        return 'https://www.reddit.com/oembed?url=' + encodeURIComponent(u.href);
    }
    return null;
}
/** Build a card from an oEmbed response; null when it carries no title. */
export function previewFromOembed(json, u) {
    if (!json || typeof json !== 'object')
        return null;
    const j = json;
    const title = typeof j.title === 'string' ? j.title.trim() : '';
    if (!title)
        return null;
    const author = typeof j.author_name === 'string' ? j.author_name.trim() : '';
    const sub = u.pathname.match(/^\/r\/([^/]+)/)?.[1] || '';
    const description = [sub && 'r/' + sub, author && 'u/' + author].filter(Boolean).join(' · ');
    return {
        domain: u.hostname,
        title: title.substring(0, 200),
        description: description.substring(0, 300),
        favicon: `${u.protocol}//${u.hostname}/favicon.ico`,
        image: '',
        generic: false,
    };
}
/**
 * A card that says nothing beyond the site's name: no description, no image,
 * and a title that is the hostname or its first label ("Reddit" for
 * www.reddit.com). An empty title is generic too.
 */
export function isGenericPreview(p) {
    const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
    const title = norm(p.title || '');
    if (!title)
        return true;
    if (p.description || p.image)
        return false;
    const host = (p.domain || '').toLowerCase().replace(/^www\./, '');
    const label = host.split('.')[0] || '';
    return title === norm(p.domain || '') || title === norm(host) || title === norm(label);
}
