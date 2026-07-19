#!/usr/bin/env node
/**
 * Long-form HTML → PDF (landscape, paginated flow)
 * Usage: node scripts/render-document-pdf.mjs [input.html] [output.pdf]
 */
import puppeteer from 'puppeteer';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const gatewayRoot = path.join(__dirname, '..');
const productRoot = path.resolve(gatewayRoot, '..', '..');
const htmlFile = path.resolve(process.argv[2] || path.join(productRoot, 'oi-moat-analysis.html'));
const pdfFile = path.resolve(process.argv[3] || path.join(productRoot, 'oi-moat-analysis.pdf'));
const fileUrl = 'file://' + htmlFile;

const browser = await puppeteer.launch({ headless: true });
const page = await browser.newPage();
await page.setViewport({ width: 1400, height: 900, deviceScaleFactor: 1 });

await page.goto(fileUrl, { waitUntil: 'load', timeout: 120000 });

await page.addStyleTag({
  content: `
    @page { size: landscape; margin: 12mm; }
    html, body {
      -webkit-print-color-adjust: exact !important;
      print-color-adjust: exact !important;
    }
    section {
      break-inside: avoid;
      page-break-inside: avoid;
    }
  `,
});

await page.emulateMediaType('print');

await page.pdf({
  path: pdfFile,
  landscape: true,
  format: 'Letter',
  printBackground: true,
  margin: { top: '10mm', right: '12mm', bottom: '10mm', left: '12mm' },
});

await browser.close();
console.error('Wrote', pdfFile);
