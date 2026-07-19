#!/usr/bin/env node
/**
 * Landscape 16:9 PDF, one page per .slide
 * Default: ../../vodou-pitch-deck2.html → ../../vodou-pitch-deck2.pdf
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.join(__dirname, '..');
const productRoot = path.resolve(gatewayRoot, '..', '..');
const htmlFile = path.resolve(process.argv[2] || path.join(productRoot, 'vodou-pitch-deck2.html'));
const pdfFile = path.resolve(process.argv[3] || path.join(productRoot, 'vodou-pitch-deck2.pdf'));
const fileUrl = 'file://' + htmlFile;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1920, height: 1080, deviceScaleFactor: 1 });

await page.goto(fileUrl, { waitUntil: 'load', timeout: 120000 });

await page.addStyleTag({
  content: `
    @page { size: 1920px 1080px; margin: 0; }
    html, body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    .slide {
      width: 1920px !important;
      min-height: 1080px !important;
      height: 1080px !important;
      max-height: 1080px !important;
      page-break-after: always !important;
      page-break-inside: avoid !important;
      break-inside: avoid !important;
      box-sizing: border-box !important;
      overflow: hidden !important;
    }
    .slide:last-of-type { page-break-after: auto !important; }
  `,
});

await page.emulateMediaType('print');

await page.pdf({
  path: pdfFile,
  width: '1920px',
  height: '1080px',
  printBackground: true,
  preferCSSPageSize: true,
  margin: { top: 0, right: 0, bottom: 0, left: 0 },
});

await browser.close();
console.error('Wrote', pdfFile);
