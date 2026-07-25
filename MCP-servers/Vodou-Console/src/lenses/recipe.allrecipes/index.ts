/**
 * recipe.allrecipes — recipe ingredients/steps/time from allrecipes.com pages.
 *
 * The motive: when a user asks about a recipe URL, show just the
 * ingredients + steps + total time. No ads, no related-content, no
 * cookie banners. The 4KB the user wanted, not the 400KB the site shipped.
 *
 * Extraction selectors below are written defensively — allrecipes has
 * redesigned twice in 2 years. extractionHealth() flags when fields
 * come back empty so the management UI can warn "selectors stale."
 */

import type { LensModule, RenderModel } from '../types.js';

export const card: LensModule = {
  manifest: {
    type: 'recipe.allrecipes',
    version: 1,
    motive: 'Show recipe ingredients, steps, and total time — without ads or site chrome.',
    url_patterns: ['*.allrecipes.com/recipe/**', 'allrecipes.com/recipe/**'],
    ttl_seconds: 86400, // 24h — recipes rarely change
    requires: {
      network_domains: ['allrecipes.com'],
      runs_js: false,
      paths: ['cheerio'],
      cookie_scope: 'ephemeral',
    },
    icon: '🍳',
    category: 'food',
    author: '@vodou',
    license: 'Apache-2.0',
    extracts: ['title', 'image', 'total_time', 'servings', 'ingredients', 'steps'],
  },

  validate(_payload: any, sourceUrl?: string): boolean {
    if (!sourceUrl) return false;
    try {
      const u = new URL(sourceUrl);
      return u.hostname.endsWith('allrecipes.com') && u.pathname.includes('/recipe/');
    } catch {
      return false;
    }
  },

  async fetch(payload: any, sourceUrl: string, ctx): Promise<RenderModel> {
    const { body } = await ctx.fetchStatic(sourceUrl);
    const $ = ctx.cheerio(body);

    // Detect allrecipes 404 page early — the LLM sometimes hallucinates
    // recipe IDs (e.g. "potato salad → /recipe/14838/potato-salad/" is a
    // 404 in current allrecipes). Without this guard the card silently
    // renders empty ingredient/step lists with "some fields missing",
    // which looks like a scraper bug rather than a hallucinated URL.
    const is404 =
      $('html').attr('id') === '404Template_1-0' ||
      ($('html').attr('class') || '').includes('404Template') ||
      /page not found|404/i.test($('title').text());
    if (is404) {
      return {
        title: 'Recipe not found',
        total_time: '',
        servings: '',
        image: '',
        ingredients: [],
        steps: [],
        source_url: sourceUrl,
        error: 'allrecipes.com returned a 404 for this URL — the recipe ID likely doesn\'t exist. Ask the user to paste an actual recipe URL, or use the web-search tool first to find a real one.',
      } as any;
    }

    // Defensive selectors — try current (2026) + older (2022-2024) markup
    const title =
      $('h1.article-heading').first().text().trim() ||
      $('h1.headline').first().text().trim() ||
      $('h1').first().text().trim() ||
      $('meta[property="og:title"]').attr('content') ||
      '';

    // Total Time — current markup uses dl-style mm-recipes-details__label/value
    let total_time = '';
    $('div.mm-recipes-details__label').each((_: any, el: any) => {
      const label = $(el).text().trim().toLowerCase();
      if (label.includes('total time')) {
        total_time = $(el).next('.mm-recipes-details__value').text().trim();
      }
    });
    if (!total_time) {
      total_time =
        $('div.recipe-meta-item:contains("Total Time") div.recipe-meta-item-body').first().text().trim() ||
        $('[class*="totalTime"]').first().text().trim() ||
        $('[class*="total-time"]').first().text().trim() ||
        '';
    }

    // Servings — current markup
    let servings = String(payload?.servings || '');
    if (!servings) {
      $('div.mm-recipes-details__label').each((_: any, el: any) => {
        const label = $(el).text().trim().toLowerCase();
        if (label.includes('servings')) {
          servings = $(el).next('.mm-recipes-details__value').text().trim();
        }
      });
    }
    if (!servings) {
      servings =
        $('div.recipe-meta-item:contains("Servings") div.recipe-meta-item-body').first().text().trim() ||
        $('[class*="recipeYield"]').first().text().trim() ||
        '';
    }

    const ingredients: string[] = [];
    // Current: mm-recipes-structured-ingredients__list-item; older: [class*=ingredients] li
    $('.mm-recipes-structured-ingredients__list-item, [class*="ingredients"] li, ul.ingredients-section li').each((_: any, el: any) => {
      const t = $(el).text().replace(/\s+/g, ' ').trim();
      if (t) ingredients.push(t);
    });

    const steps: string[] = [];
    // Current: .mm-recipes-steps__content ol li ; older: [class*=instructions] li
    $('.mm-recipes-steps__content ol > li, [class*="instructions"] li, ol.recipe-instructions li').each((_: any, el: any) => {
      const t = $(el).find('p').first().text().trim() || $(el).text().replace(/\s+/g, ' ').trim();
      if (t) steps.push(t);
    });

    const image =
      $('meta[property="og:image"]').attr('content') ||
      $('img.recipe-image').attr('src') ||
      '';

    return {
      title,
      total_time,
      servings: String(servings || ''),
      image,
      ingredients,
      steps,
      source_domain: 'allrecipes.com',
    };
  },

  extractionHealth(model: RenderModel) {
    const missing: string[] = [];
    if (!model.title) missing.push('title');
    if (!model.ingredients || model.ingredients.length === 0) missing.push('ingredients');
    if (!model.steps || model.steps.length === 0) missing.push('steps');
    return { ok: missing.length === 0, missing };
  },
};
