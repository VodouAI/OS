#!/usr/bin/env node
/**
 * Vodou Gmail MCP — Stdio Launcher
 *
 * Reads saved tokens, refreshes if expired, then launches
 * gmail-mcp in stdio mode with a valid access token.
 *
 * This is what vodou-core calls to start the server.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TOKENS_PATH = path.join(__dirname, 'tokens.json');
const GMAIL_MCP_BIN = path.join(__dirname, 'node_modules', 'gmail-mcp', 'dist', 'main.js');

async function refreshAccessToken(tokenData) {
  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: tokenData.client_id,
      client_secret: tokenData.client_secret,
      refresh_token: tokenData.refresh_token,
      grant_type: 'refresh_token',
    }).toString(),
  });

  const data = await response.json();
  if (data.error) {
    throw new Error(`Token refresh failed: ${data.error} — ${data.error_description}`);
  }

  // Update saved tokens
  tokenData.access_token = data.access_token;
  tokenData.expiry_date = Date.now() + (data.expires_in * 1000);
  if (data.refresh_token) {
    tokenData.refresh_token = data.refresh_token;
  }
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));

  return tokenData.access_token;
}

async function main() {
  if (!fs.existsSync(TOKENS_PATH)) {
    console.error('gmail-mcp: No tokens found. Run `node auth.js` first to authenticate.');
    process.exit(1);
  }

  const tokenData = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8'));

  // Check if token is expired (with 5-minute buffer)
  let accessToken = tokenData.access_token;
  const isExpired = Date.now() > (tokenData.expiry_date - 300000);

  if (isExpired) {
    console.error('gmail-mcp: Refreshing expired access token...');
    try {
      accessToken = await refreshAccessToken(tokenData);
      console.error('gmail-mcp: Token refreshed successfully');
    } catch (err) {
      console.error(`gmail-mcp: ${err.message}`);
      console.error('gmail-mcp: Re-run `node auth.js` to re-authenticate.');
      process.exit(1);
    }
  }

  // Launch gmail-mcp in stdio mode
  const child = spawn('node', [GMAIL_MCP_BIN], {
    env: {
      ...process.env,
      GOOGLE_ACCESS_TOKEN: accessToken,
      MCP_TRANSPORT: 'stdio',
    },
    stdio: ['inherit', 'inherit', 'inherit'],
  });

  child.on('exit', (code) => process.exit(code || 0));
  child.on('error', (err) => {
    console.error(`gmail-mcp: Failed to start: ${err.message}`);
    process.exit(1);
  });

  // Forward signals
  process.on('SIGINT', () => child.kill('SIGINT'));
  process.on('SIGTERM', () => child.kill('SIGTERM'));
}

main().catch((err) => {
  console.error(`gmail-mcp: ${err.message}`);
  process.exit(1);
});
