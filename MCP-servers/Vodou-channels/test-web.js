#!/usr/bin/env node

/**
 * Quick test script to start the web interface directly
 */

import { WebChannel } from './dist/channels/web.js';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const VODOU_PATH = join(__dirname, '..', '..', 'oi');

const web = new WebChannel();

// Process messages through Vodou
async function processWithOI(query) {
  return new Promise((resolve) => {
    // Quote the path and query to handle spaces
    const quotedPath = `"${VODOU_PATH}"`;
    const quotedQuery = `"${query.replace(/"/g, '\\"')}"`;

    const proc = spawn('sh', ['-c', `${quotedPath} ${quotedQuery}`], {
      cwd: join(__dirname, '..', '..'),
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => { stdout += data.toString(); });
    proc.stderr.on('data', (data) => { stderr += data.toString(); });

    proc.on('close', (code) => {
      resolve(stdout.trim() || stderr.trim() || `Vodou exited with code ${code}`);
    });

    proc.on('error', (err) => {
      resolve(`Error: ${err.message}`);
    });
  });
}

// Set up message handler
web.onMessage(async (message) => {
  console.log(`Received: ${message.content}`);
  const response = await processWithOI(message.content);
  console.log(`Response: ${response.substring(0, 100)}...`);
  return response;
});

// Start web server
await web.connect();

console.log('\n✅ Web interface running at: http://localhost:8766');
console.log('   Open in browser to test Vodou\n');
console.log('Press Ctrl+C to stop\n');

// Keep running
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  await web.disconnect();
  process.exit(0);
});
