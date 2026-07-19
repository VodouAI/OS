#!/usr/bin/env node
/**
 * Vodou MS 365 MCP — device-code OAuth login.
 *
 * Microsoft uses device-code flow — no localhost callback needed. The
 * underlying server prints a URL + 8-character code; the user opens the URL
 * in any browser, pastes the code, signs in. Tokens cache to this directory.
 *
 * Usage: node auth.js
 */

const path = require('path');
const { spawn } = require('child_process');

const here = __dirname;
const tokenCachePath = path.join(here, '.token-cache.json');
const selectedAccountPath = path.join(here, '.selected-account.json');
const serverEntry = path.join(here, 'node_modules', '@softeria', 'ms-365-mcp-server', 'dist', 'index.js');

console.log('\nVodou MS 365 OAuth Setup\n');
console.log('A URL and short code will print below. Open the URL in any browser,');
console.log('paste the code, and sign in with the Microsoft 365 account you want');
console.log('Vodou to use. Tokens will cache to this directory.\n');

const child = spawn(process.execPath, [serverEntry, '--login'], {
  cwd: here,
  env: {
    ...process.env,
    MS365_MCP_TOKEN_CACHE_PATH: tokenCachePath,
    MS365_MCP_SELECTED_ACCOUNT_PATH: selectedAccountPath,
  },
  stdio: 'inherit',
});

child.on('exit', (code) => {
  if (code === 0) {
    console.log('\nSign-in complete. You can now connect MS 365 from the Vodou Apps page.\n');
  }
  process.exit(code ?? 0);
});
