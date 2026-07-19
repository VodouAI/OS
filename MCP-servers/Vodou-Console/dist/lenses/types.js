/**
 * Cards framework — type definitions.
 * See PLANS/0.5.88/PLAN-LENSES-FRAMEWORK-v4.md + PLAN-LENSES-MVP.md
 *
 * A card is a pluggable visual block the assistant can emit in chat.
 * It binds to one or more URL patterns + a motive, defines how to fetch
 * the data it needs, and how to render that data into a small focused UI.
 *
 * fetch() runs server-side on the gateway (this file's neighborhood).
 * Component() runs client-side in the browser (public/js/lenses/).
 * The render model JSON crosses the wire — source HTML never does.
 */
export {};
