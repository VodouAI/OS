#!/usr/bin/env node
/**
 * Mean brightness of a PNG, from a path or a URL.
 *
 * Evidence tool for "is the figure light where it landed?". The origin and the
 * copy dev.to re-hosts are two records of one image, and the interesting bug is
 * when they disagree: Forem's media proxy caches by source URL, so a redrawn
 * figure at an unchanged URL can be stale on dev.to while correct on the site.
 *
 *   node scripts/blog/png-brightness.mjs <path-or-url> [...]
 */
import sharp from '../../blog-site/node_modules/sharp/dist/index.mjs';

for (const arg of process.argv.slice(2)) {
  try {
    const buf = /^https?:/.test(arg)
      ? Buffer.from(await (await fetch(arg, { headers: { 'User-Agent': 'vodou-blog/1.0' } })).arrayBuffer())
      : (await import('fs')).readFileSync(arg);
    const img = sharp(buf);
    const [{ mean }, meta] = await Promise.all([img.stats().then((s) => s.channels[0]), img.metadata()]);
    const verdict = mean >= 200 ? 'LIGHT' : mean <= 80 ? 'DARK ' : 'mixed';
    console.log(`${verdict}  mean ${mean.toFixed(0).padStart(3)}  ${meta.width}x${meta.height} ${meta.format}  ${arg}`);
  } catch (e) {
    console.log(`ERROR                                   ${arg}  ${e.message}`);
  }
}
