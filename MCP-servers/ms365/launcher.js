#!/usr/bin/env node
/**
 * Vodou MS 365 MCP — launcher.
 *
 * Pins the token-cache and selected-account file paths inside this directory
 * so they survive package reinstalls AND so the gateway's "Switch account"
 * action can deterministically wipe them.
 *
 * Tokens are obtained via the device-code OAuth flow — run `node auth.js`
 * once before connecting.
 */

const path = require('path');
const { spawn } = require('child_process');

const here = __dirname;
const tokenCachePath = process.env.MS365_MCP_TOKEN_CACHE_PATH
  || path.join(here, '.token-cache.json');
const selectedAccountPath = process.env.MS365_MCP_SELECTED_ACCOUNT_PATH
  || path.join(here, '.selected-account.json');

const serverEntry = path.join(here, 'node_modules', '@softeria', 'ms-365-mcp-server', 'dist', 'index.js');

const child = spawn(process.execPath, [serverEntry, ...process.argv.slice(2)], {
  cwd: here,
  env: {
    ...process.env,
    MS365_MCP_TOKEN_CACHE_PATH: tokenCachePath,
    MS365_MCP_SELECTED_ACCOUNT_PATH: selectedAccountPath,
  },
  stdio: 'inherit',
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
