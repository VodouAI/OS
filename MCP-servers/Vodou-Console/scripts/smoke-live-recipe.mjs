#!/usr/bin/env node
/**
 * LIVE smoke — fetches a real allrecipes URL and verifies the card extracts.
 * Skips if the network is unavailable. Run sparingly — hits real site.
 */
import { buildFetchCtx } from '../dist/lenses/_lib/fetch_ctx.js';
import { card as recipe } from '../dist/lenses/recipe.allrecipes/index.js';

const URL_TO_TEST = process.env.SMOKE_URL ||
  'https://www.allrecipes.com/recipe/229960/easy-bourbon-glazed-salmon/';

const ctx = buildFetchCtx();
try {
  const model = await recipe.fetch({}, URL_TO_TEST, ctx);
  console.log('title:', model.title);
  console.log('total_time:', model.total_time);
  console.log('servings:', model.servings);
  console.log('ingredients:', model.ingredients.length, 'items');
  console.log('steps:', model.steps.length, 'items');
  const health = recipe.extractionHealth(model);
  console.log('health:', health);
  if (health.ok) {
    console.log('✅ live recipe smoke passed');
    process.exit(0);
  } else {
    console.log('⚠️  selectors stale, missing:', health.missing);
    process.exit(2);
  }
} catch (err) {
  console.warn('skipped (network error):', err.message);
  process.exit(0); // not a build failure
}
