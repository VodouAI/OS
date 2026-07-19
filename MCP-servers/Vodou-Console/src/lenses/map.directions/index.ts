/**
 * map.directions — render a Google Maps directions iframe from origin + destination.
 *
 * Uses the public `/maps?...&output=embed` URL — no API key required.
 * No fetch needed; the renderer constructs the iframe URL from the payload.
 *
 * Payload shape:
 *   { origin: "Detroit, MI", destination: "Grand Rapids, MI", mode?: "driving" }
 */

import type { LensModule } from '../types.js';

export const card: LensModule = {
  manifest: {
    type: 'map.directions',
    version: 1,
    motive: 'Show driving/walking/transit directions between two locations as an embedded map.',
    url_patterns: ['*.google.com/maps/**', 'google.com/maps/**', 'maps.google.com/**'],
    ttl_seconds: 86400 * 7,
    requires: { paths: ['cheerio'], cookie_scope: 'ephemeral' },
    icon: '🗺️',
    category: 'maps',
    author: '@vodou',
    license: 'MIT',
    extracts: ['origin', 'destination', 'mode', 'embed_url'],
    payload_required: ['origin', 'destination'],
    payload_example: { origin: 'Detroit, MI', destination: 'Grand Rapids, MI', mode: 'driving' },
  },

  validate(payload: any): boolean {
    return !!(payload?.origin && payload?.destination);
  },

  synthesizeUrl(payload: any): string {
    const o = encodeURIComponent(payload.origin);
    const d = encodeURIComponent(payload.destination);
    const mode = encodeURIComponent(payload.mode || 'driving');
    return `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=${mode}`;
  },

  async fetch(payload: any) {
    const o = encodeURIComponent(payload.origin);
    const d = encodeURIComponent(payload.destination);
    const mode = (payload.mode || 'driving').toLowerCase();
    // Embed URL — no API key, just the public maps page in embed mode.
    const embedUrl = `https://maps.google.com/maps?saddr=${o}&daddr=${d}&dirflg=${
      mode === 'walking' ? 'w' : mode === 'transit' ? 'r' : mode === 'bicycling' ? 'b' : 'd'
    }&output=embed`;
    const openUrl = `https://www.google.com/maps/dir/?api=1&origin=${o}&destination=${d}&travelmode=${mode}`;
    return {
      origin: payload.origin,
      destination: payload.destination,
      mode,
      embed_url: embedUrl,
      open_url: openUrl,
    };
  },
};
