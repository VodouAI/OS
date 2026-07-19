#!/usr/bin/env node
/**
 * Vodou Gmail MCP — OAuth2 Desktop Authentication
 *
 * Performs the Google OAuth2 "installed app" flow:
 * 1. Opens browser for user consent
 * 2. Receives callback on localhost
 * 3. Exchanges code for tokens
 * 4. Saves refresh_token to tokens.json
 *
 * Usage: node auth.js
 */

const http = require('http');
const https = require('https');
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Polyfill global fetch for Node < 18 — older system Node installs (16.x and
// below) don't have fetch as a global, and Joe's machine surfaces this as
// "Token exchange failed: fetch is not defined". Lightweight https.request
// shim is plenty for the single POST to oauth2.googleapis.com/token.
if (typeof fetch === 'undefined') {
  global.fetch = (url, opts = {}) =>
    new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = https.request(
        {
          method: opts.method || 'GET',
          hostname: u.hostname,
          path: u.pathname + u.search,
          headers: opts.headers || {},
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const body = Buffer.concat(chunks).toString('utf8');
            resolve({
              ok: res.statusCode >= 200 && res.statusCode < 300,
              status: res.statusCode,
              json: async () => JSON.parse(body),
              text: async () => body,
            });
          });
        }
      );
      req.on('error', reject);
      if (opts.body) req.write(opts.body);
      req.end();
    });
}

const CREDS_PATH = path.join(__dirname, 'credentials.json');
const TOKENS_PATH = path.join(__dirname, 'tokens.json');

const SCOPES = [
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.modify',
  'https://www.googleapis.com/auth/gmail.labels',
];

async function main() {
  if (!fs.existsSync(CREDS_PATH)) {
    console.error('ERROR: credentials.json not found. Place your Google OAuth credentials file at:');
    console.error(CREDS_PATH);
    process.exit(1);
  }

  const creds = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf8'));
  const { client_id, client_secret } = creds.installed || creds.web || {};

  if (!client_id || !client_secret) {
    console.error('ERROR: Could not extract client_id/client_secret from credentials.json');
    process.exit(1);
  }

  const PORT = 8976; // random high port for callback
  const REDIRECT_URI = `http://localhost:${PORT}`;

  // Build auth URL
  const params = new URLSearchParams({
    client_id,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`;

  console.log('\n🔮 Vodou Gmail OAuth Setup\n');
  console.log('Opening browser for Google authorization...\n');

  // Start local server to receive callback
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = new URL(req.url, `http://localhost:${PORT}`);
      const code = url.searchParams.get('code');
      const error = url.searchParams.get('error');

      if (error) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(`<html><body><h2>Authorization failed: ${error}</h2><p>You can close this tab.</p></body></html>`);
        console.error(`\nERROR: Authorization denied: ${error}`);
        server.close();
        process.exit(1);
      }

      if (code) {
        // Exchange code for tokens
        try {
          const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id,
              client_secret,
              redirect_uri: REDIRECT_URI,
              grant_type: 'authorization_code',
            }).toString(),
          });

          const tokens = await tokenResponse.json();

          if (tokens.error) {
            throw new Error(`${tokens.error}: ${tokens.error_description}`);
          }

          // Save tokens
          const tokenData = {
            access_token: tokens.access_token,
            refresh_token: tokens.refresh_token,
            token_type: tokens.token_type,
            expiry_date: Date.now() + (tokens.expires_in * 1000),
            client_id,
            client_secret,
          };
          fs.writeFileSync(TOKENS_PATH, JSON.stringify(tokenData, null, 2));

          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<!DOCTYPE html><html><head><meta charset="utf-8"></head><body style="font-family:system-ui;text-align:center;padding:60px">
            <h2 style="color:#2563EB">Gmail authorized for VODOU!</h2>
            <p>You can close this tab and return to your terminal.</p>
          </body></html>`);

          console.log('✅ Authorization successful!');
          console.log(`   Tokens saved to: ${TOKENS_PATH}`);
          console.log('   You can now use Gmail through Vodou.\n');

          server.close();
          resolve();
        } catch (err) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(`<html><body><h2>Token exchange failed</h2><pre>${err.message}</pre></body></html>`);
          console.error(`\nERROR: Token exchange failed: ${err.message}`);
          server.close();
          process.exit(1);
        }
      }
    });

    server.listen(PORT, () => {
      // Open browser
      try {
        execSync(`open "${authUrl}"`);
      } catch {
        console.log('Could not open browser. Open this URL manually:');
        console.log(authUrl);
      }
    });
  });
}

main().catch(console.error);
