---
name: oauth-authentication
description: Complete guide to OAuth authentication for any remote MCP server in Vodou - walk users through the full OAuth flow from setup to connection
version: 1.0.0
kind: workflow
required_tools: []
trigger_phrases:
  - "oauth authentication"
  - "oauth setup"
  - "authenticate mcp server"
  - "oauth flow"
  - "setup oauth"
  - "oauth guide"
  - "remote server authentication"
  - "oauth mcp server"
  - "authenticate remote server"
  - "oauth configuration"
  - "--"
stopping_points: required
actions: none
imported_from:
  source: hand-written
---

# OAuth Authentication for Remote MCP Servers 🔐

## ⚠️ **CRITICAL: AI Agent Instructions**

**This skill guides users through OAuth authentication for ANY remote MCP server. You MUST:**

1. **Ask questions first** - Understand which server they want to authenticate with
2. **Present options at stopping points** - Never assume, always ask
3. **Give users control** - Let them decide OAuth configuration details
4. **Use progressive disclosure** - Start with overview, go deep on demand
5. **Reference Vodou's OAuth capabilities** - Use actual Vodou commands that work

**User control is MANDATORY. Never auto-configure without user approval.**

---

## 📖 **Overview: OAuth Authentication in Vodou**

**Vodou supports OAuth 2.0 authentication** for remote MCP servers that require authentication. This skill walks you through the complete OAuth flow for any remote MCP server, from initial setup to successful connection.

**Key Benefits:**
- ✅ **Universal Support**: Works with any OAuth 2.0 provider (Figma, GitHub, Google, custom, etc.)
- ✅ **Automatic Flow**: Vodou handles browser redirect, code exchange, and token storage
- ✅ **Secure Storage**: Tokens stored securely in Vodou's database
- ✅ **Auto-Discovery**: Vodou can discover OAuth endpoints automatically
- ✅ **Token Management**: Automatic token refresh and renewal

**Figma note:** The gateway **Apps → Figma** card uses **local stdio** (bundled `node MCP-servers/figma-developer-mcp/node_modules/figma-developer-mcp/dist/bin.js`, personal access token as **`FIGMA_API_KEY`** in `.env`). You do **not** need this OAuth skill for that path. The examples below apply only if you connect **Figma’s remote HTTP MCP** (`https://mcp.figma.com/mcp`) or another OAuth-backed URL yourself.

**What This Skill Covers:**
- Understanding OAuth in Vodou
- Prerequisites and setup
- Step-by-step OAuth configuration
- Running the OAuth flow
- Connecting to authenticated servers
- Troubleshooting common issues

---

## 🛑 **STOPPING POINT 1: Which Server Do You Want to Authenticate?**

Before we start, I need to know which remote MCP server you want to authenticate with.

**Please tell me:**

1. **Server Name**: What do you want to call this server in Vodou? (e.g., "figma", "github", "my-custom-server")
2. **Server URL**: What's the MCP server endpoint URL? (e.g., `https://mcp.figma.com/mcp`)
3. **OAuth Provider**: What OAuth provider does this server use?
   - **A)** Figma
   - **B)** GitHub
   - **C)** Google
   - **D)** Custom/Other
   - **E)** I don't know - help me discover it

4. **Do you have OAuth credentials?**
   - **Yes** - I have Client ID and Client Secret
   - **No** - I need to create an OAuth app first
   - **Not sure** - Help me figure this out

**Once you provide this information, I'll guide you through the appropriate OAuth setup path.**

**Would you like to:**
- **A)** Provide the information now and I'll create a custom setup guide
- **B)** See examples for common providers (Figma, GitHub, etc.) first
- **C)** Use Vodou's OAuth discovery to automatically find endpoints
- **D)** Start with a template and customize it

**Your choice? (A, B, C, or D)**

---

## Prerequisites

Before starting OAuth authentication, ensure you have:

- ✅ **Vodou installed and working** - Verify with `./do "hello"`
- ✅ **Server URL** - The remote MCP server endpoint (e.g., `https://mcp.example.com/mcp`)
- ✅ **OAuth App** (usually required) - Client ID and Client Secret from the OAuth provider
- ✅ **Redirect URI configured** - Must match in OAuth app settings (default: `http://localhost:8080/callback`)
- ✅ **Browser access** - Vodou will open a browser for authorization

**Common OAuth Providers:**
- **Figma**: https://www.figma.com/developers/apps
- **GitHub**: https://github.com/settings/developers
- **Google**: https://console.cloud.google.com/apis/credentials
- **Custom**: Check your provider's developer documentation

---

## Core Workflow

### Step 1: Connect to Server (Discover OAuth Requirements)

First, attempt to connect to the server. Vodou will automatically detect if OAuth is required.

```bash
# Connect to the remote server
./do connect <server-name> http --url <server-url>
```

**What happens:**
- Vodou attempts to connect to the server
- If OAuth is required, Vodou detects it automatically
- Vodou discovers OAuth endpoints (authorization, token, PRM)
- Vodou shows you what's needed

**Example:**
```bash
./do connect figma-test http --url https://mcp.figma.com/mcp
```

**Expected output:**
```
❌ Authentication required for figma-test
🔍 OAuth configuration discovered
   WWW-Authenticate: Bearer error="invalid_token"...
   PRM URL: https://mcp.figma.com/.well-known/oauth-protected-resource
```

### 🛑 **STOPPING POINT 2: OAuth Discovery Results**

After connecting, Vodou will show you what it discovered. **Review the OAuth information:**

**Questions to answer:**
1. **Did Vodou discover OAuth endpoints?** (Yes/No)
2. **Do you see a PRM (Protected Resource Metadata) URL?** (Yes/No)
3. **What authentication type is required?** (OAuth 2.0, Bearer Token, etc.)

**Options:**
- **A)** Vodou discovered everything automatically - proceed with configuration
- **B)** Vodou discovered some info - I'll provide missing details
- **C)** Vodou didn't discover anything - I'll provide all OAuth details manually
- **D)** I need help understanding what Vodou discovered

**Your choice? (A, B, C, or D)**

### Step 2: Discover Available OAuth Scopes (Optional)

If you want to see what scopes are available from the OAuth provider:

```bash
# Discover available scopes
./do credentials <server-name> discover-scopes
```

**Or with custom discovery URL:**
```bash
./do credentials <server-name> discover-scopes --discovery-url <provider-base-url>
```

**Example:**
```bash
./do credentials figma-test discover-scopes --discovery-url https://www.figma.com
```

**What this does:**
- Fetches OAuth discovery metadata from the provider
- Shows available scopes you can request
- Helps you choose the right permissions

**Example output:**
```
🔍 Discovering OAuth scopes from: https://www.figma.com
✅ Available scopes:
   - file_read
   - file_content:read
   - current_user:read
   
💡 Use: oi credentials figma-test o-auth --scope "file_read"
```

### 🛑 **STOPPING POINT 3: OAuth Scope Selection**

**Which scopes do you need?**

**Common scope patterns:**
- **Read-only**: `read`, `file_read`, `read:user`
- **Read-write**: `read write`, `file_read file_write`
- **Full access**: `*`, `all`, `full_access`

**Options:**
- **A)** Use minimal scopes (read-only) - recommended for security
- **B)** Use specific scopes I know I need
- **C)** Use all available scopes - maximum access
- **D)** I'm not sure - show me what each scope does

**Your choice? (A, B, C, or D)**

### Step 3: Configure OAuth Settings

Configure OAuth in Vodou with the required endpoints and credentials.

```bash
# Configure OAuth for the server
./do credentials <server-name> o-auth \
  --auth-endpoint "<authorization-endpoint>" \
  --token-endpoint "<token-endpoint>" \
  --client-id "<your-client-id>" \
  --client-secret "<your-client-secret>" \
  --redirect-uri "http://localhost:8080/callback" \
  --scope "<requested-scopes>" \
  --provider "<provider-name>"
```

**Common OAuth Endpoints:**

**Figma:**
- Authorization: `https://www.figma.com/oauth`
- Token: `https://www.figma.com/api/oauth/token`
- Scopes: `file_read`, `file_content:read`

**GitHub:**
- Authorization: `https://github.com/login/oauth/authorize`
- Token: `https://github.com/login/oauth/access_token`
- Scopes: `repo`, `read:user`

**Google:**
- Authorization: `https://accounts.google.com/o/oauth2/v2/auth`
- Token: `https://oauth2.googleapis.com/token`
- Scopes: `https://www.googleapis.com/auth/...`

**Example (Figma):**
```bash
./do credentials figma-test o-auth \
  --auth-endpoint "https://www.figma.com/oauth" \
  --token-endpoint "https://www.figma.com/api/oauth/token" \
  --client-id "YOUR_FIGMA_CLIENT_ID" \
  --client-secret "YOUR_FIGMA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8080/callback" \
  --scope "file_read" \
  --provider "figma"
```

**Important Notes:**
- **Redirect URI must match** exactly what's configured in your OAuth app
- **Client Secret is optional** for public clients (PKCE flow)
- **All fields are optional** - you can update them later
- **Provider name** is just for reference (e.g., "figma", "github")

### 🛑 **STOPPING POINT 4: OAuth Configuration Review**

**Before proceeding, let's verify your configuration:**

**Please confirm:**
1. ✅ Authorization endpoint is correct
2. ✅ Token endpoint is correct
3. ✅ Client ID is set
4. ✅ Client Secret is set (if required)
5. ✅ Redirect URI matches your OAuth app settings
6. ✅ Scopes are appropriate for your needs

**Options:**
- **A)** Everything looks correct - proceed to OAuth flow
- **B)** I need to update some settings
- **C)** I'm not sure if this is correct - help me verify
- **D)** I want to test the configuration first

**Your choice? (A, B, C, or D)**

### Step 4: Run OAuth Flow

Trigger the OAuth authentication flow. Vodou will handle everything automatically.

```bash
# Start OAuth flow
./do credentials <server-name> auth
```

**What happens:**
1. Vodou opens your browser to the authorization page
2. You log in to the OAuth provider (if not already logged in)
3. You authorize the OAuth app
4. Provider redirects back to Vodou's callback server (`http://localhost:8080/callback`)
5. Vodou receives the authorization code
6. Vodou exchanges the code for an access token
7. Token is stored securely in Vodou's database

**Example:**
```bash
./do credentials figma-test auth
```

**Expected output:**
```
🔐 Starting OAuth flow...
🌐 Opening browser for authorization...
   URL: https://www.figma.com/oauth?client_id=...&redirect_uri=...
✅ Authorization code received
🔄 Making token request to: https://www.figma.com/api/oauth/token
✅ OAuth token obtained. Reconnecting...
✅ OAuth authentication completed for server 'figma-test'
```

**Note**: If browser doesn't open automatically, Vodou will print the URL - open it manually.

### 🛑 **STOPPING POINT 5: OAuth Flow Status**

**After running the OAuth flow, check the status:**

**Questions:**
1. **Did the browser open?** (Yes/No)
2. **Did you authorize the app?** (Yes/No)
3. **Did Vodou receive the token?** (Check output for "✅ OAuth token obtained")

**If successful:**
- **A)** OAuth completed successfully - proceed to connect
- **B)** I see an error - help me troubleshoot
- **C)** Browser didn't open - I'll open the URL manually
- **D)** I need to verify the token was stored

**Your choice? (A, B, C, or D)**

### Step 5: Verify OAuth Token

Check that the OAuth token was stored correctly:

```bash
# List credentials for the server
./do credentials <server-name> list
```

**Example:**
```bash
./do credentials figma-test list
```

**Expected output:**
```
Credentials for server 'figma-test':
  • bearer_token: ✅ Available
  • oauth_access_token: ✅ Available
```

### Step 6: Connect to Authenticated Server

Now connect to the server. Vodou will automatically include the OAuth token in requests.

```bash
# Connect to the server (OAuth token will be used automatically)
./do connect <server-name> http --url <server-url>
```

**Example:**
```bash
./do connect figma-test http --url https://mcp.figma.com/mcp
```

**What happens:**
- Vodou loads the stored OAuth token
- Vodou includes `Authorization: Bearer <token>` header in all requests
- Server validates the token
- Connection succeeds (if token is valid)

**Expected output:**
```
✅ Connected! Discovered:
   🔧 Tools: 5
   📝 Prompts: 0
   📄 Resources: 0
```

### Step 7: Test the Connection

Verify the connection works by listing tools or calling a tool:

```bash
# List available tools
./do tools <server-name>

# Call a tool (if available)
./do call <server-name> <tool-name> '{}'
```

**Example:**
```bash
./do tools figma-test
./do call figma-test get_file_content '{"file_key": "YOUR_FILE_KEY"}'
```

---

## Advanced Usage

### Automatic OAuth Discovery

Vodou can automatically discover OAuth endpoints from the server's PRM (Protected Resource Metadata):

```bash
# Connect first (triggers discovery)
./do connect <server-name> http --url <server-url>

# Vodou automatically discovers:
# - Authorization endpoint
# - Token endpoint
# - Required scopes
# - Client registration endpoint (if available)
```

**When this works:**
- Server supports PRM discovery (RFC 8414)
- Server returns `WWW-Authenticate` header with `resource_metadata` parameter
- Server exposes `/.well-known/oauth-protected-resource` endpoint

### Dynamic Client Registration (DCR)

Some OAuth providers support Dynamic Client Registration. Vodou can automatically register a client:

```bash
# If server supports DCR, Vodou will:
# 1. Register a new OAuth client automatically
# 2. Get Client ID and Client Secret
# 3. Store them securely
# 4. Use them for OAuth flow

# This happens automatically during OAuth discovery
```

**When this works:**
- Server supports OAuth 2.0 Dynamic Client Registration (RFC 7591)
- Server exposes registration endpoint
- No manual OAuth app creation needed

### Manual Token Setup

If you already have an OAuth access token, you can add it directly:

```bash
# Add bearer token directly
./do credentials <server-name> add --cred-type bearer_token --value "<your-token>"
```

**Example:**
```bash
./do credentials figma-test add --cred-type bearer_token --value "figd_abc123..."
```

**When to use:**
- You already have a valid token
- You want to skip the OAuth flow
- You're using a token from another source

### Token Refresh

Vodou automatically handles token refresh if the server supports it:

```bash
# Vodou will automatically:
# 1. Detect when token is expired
# 2. Use refresh token (if available)
# 3. Get new access token
# 4. Update stored credentials
```

**Manual refresh:**
```bash
# Re-run OAuth flow to get fresh token
./do credentials <server-name> auth
```

### Multiple OAuth Configurations

You can configure OAuth for multiple servers:

```bash
# Configure OAuth for different servers
./do credentials figma-test o-auth --auth-endpoint "https://www.figma.com/oauth" ...
./do credentials github-test o-auth --auth-endpoint "https://github.com/login/oauth/authorize" ...
./do credentials google-test o-auth --auth-endpoint "https://accounts.google.com/o/oauth2/v2/auth" ...
```

Each server maintains its own OAuth configuration and tokens.

---

## Examples

### Example 1: Figma remote HTTP MCP (OAuth)

Use this only for **remote** `https://mcp.figma.com/mcp` (or equivalent). Vendor allowlists may block unofficial clients; for design-in-code from Figma without that, prefer **Apps → Figma** + `FIGMA_API_KEY` (see `MCP-servers/figma-developer-mcp/README.md`).

Complete OAuth setup for Figma’s **remote** MCP server:

```bash
# Step 1: Connect (discovers OAuth requirement)
./do connect figma-test http --url https://mcp.figma.com/mcp

# Step 2: Discover scopes (optional)
./do credentials figma-test discover-scopes --discovery-url https://www.figma.com

# Step 3: Configure OAuth
./do credentials figma-test o-auth \
  --auth-endpoint "https://www.figma.com/oauth" \
  --token-endpoint "https://www.figma.com/api/oauth/token" \
  --client-id "YOUR_FIGMA_CLIENT_ID" \
  --client-secret "YOUR_FIGMA_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8080/callback" \
  --scope "file_read" \
  --provider "figma"

# Step 4: Run OAuth flow
./do credentials figma-test auth

# Step 5: Verify token
./do credentials figma-test list

# Step 6: Connect (token used automatically)
./do connect figma-test http --url https://mcp.figma.com/mcp

# Step 7: Test
./do tools figma-test
```

### Example 2: GitHub OAuth Setup

OAuth setup for a GitHub-based MCP server:

```bash
# Step 1: Connect
./do connect github-mcp http --url https://api.github.com/mcp

# Step 2: Configure OAuth
./do credentials github-mcp o-auth \
  --auth-endpoint "https://github.com/login/oauth/authorize" \
  --token-endpoint "https://github.com/login/oauth/access_token" \
  --client-id "YOUR_GITHUB_CLIENT_ID" \
  --client-secret "YOUR_GITHUB_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8080/callback" \
  --scope "repo read:user" \
  --provider "github"

# Step 3: Run OAuth flow
./do credentials github-mcp auth

# Step 4: Connect and test
./do connect github-mcp http --url https://api.github.com/mcp
./do tools github-mcp
```

### Example 3: Custom OAuth Server

OAuth setup for a custom/private MCP server:

```bash
# Step 1: Connect (discovers OAuth)
./do connect my-custom-server http --url https://mcp.example.com/mcp

# Step 2: Configure OAuth (custom endpoints)
./do credentials my-custom-server o-auth \
  --auth-endpoint "https://auth.example.com/oauth/authorize" \
  --token-endpoint "https://auth.example.com/oauth/token" \
  --client-id "YOUR_CLIENT_ID" \
  --client-secret "YOUR_CLIENT_SECRET" \
  --redirect-uri "http://localhost:8080/callback" \
  --scope "read write" \
  --provider "custom"

# Step 3: Run OAuth flow
./do credentials my-custom-server auth

# Step 4: Connect
./do connect my-custom-server http --url https://mcp.example.com/mcp
```

### Example 4: Using Existing Token

If you already have a token:

```bash
# Add token directly
./do credentials figma-test add --cred-type bearer_token --value "figd_abc123..."

# Connect (token used automatically)
./do connect figma-test http --url https://mcp.figma.com/mcp
```

---

## Best Practices

1. **Use Minimal Scopes**: Request only the scopes you actually need. This follows the principle of least privilege and reduces security risk.

2. **Secure Client Secrets**: Never commit client secrets to version control. Use environment variables or Vodou's secure credential storage.

3. **Match Redirect URIs**: Ensure the redirect URI in Vodou matches exactly what's configured in your OAuth app (case-sensitive, trailing slashes matter).

4. **Test Token Validity**: After OAuth flow, verify the token works by connecting and calling a tool.

5. **Handle Token Expiration**: Vodou automatically refreshes tokens when possible. If refresh fails, re-run the OAuth flow.

6. **Use Descriptive Server Names**: Choose clear server names (e.g., "figma-prod", "github-dev") to avoid confusion.

7. **Document Your Setup**: Keep notes on which OAuth app corresponds to which Vodou server configuration.

---

## Troubleshooting

### OAuth Flow Fails - Browser Doesn't Open

**Problem:** Vodou says it's opening browser but nothing happens.

**Solution:**
```bash
# Vodou will print the authorization URL
# Copy it and open manually in your browser
# Example output:
# 🌐 Opening browser for authorization...
#    URL: https://www.figma.com/oauth?client_id=...&redirect_uri=...
```

**Prevention:** Ensure you have a default browser set on your system.

### OAuth Flow Fails - Invalid Redirect URI

**Problem:** OAuth provider says "Invalid redirect_uri".

**Solution:**
```bash
# Check what redirect URI Vodou is using
./do credentials <server-name> list

# Update redirect URI to match OAuth app settings
./do credentials <server-name> o-auth --redirect-uri "http://localhost:8080/callback"

# Ensure it matches EXACTLY in OAuth app settings (case, trailing slash, etc.)
```

**Prevention:** Always verify redirect URI matches exactly between Vodou and OAuth app settings.

### OAuth Flow Fails - Invalid Client Credentials

**Problem:** OAuth provider rejects client ID or secret.

**Solution:**
```bash
# Verify client credentials
./do credentials <server-name> list

# Update if incorrect
./do credentials <server-name> o-auth \
  --client-id "<correct-client-id>" \
  --client-secret "<correct-client-secret>"
```

**Prevention:** Double-check client ID and secret from OAuth app settings.

### Connection Fails After OAuth - Token Invalid

**Problem:** OAuth completed but connection still fails with authentication error.

**Solution:**
```bash
# Check if token exists
./do credentials <server-name> list

# Re-run OAuth flow to get fresh token
./do credentials <server-name> auth

# Try connecting again
./do connect <server-name> http --url <server-url>
```

**Prevention:** Verify token immediately after OAuth flow by connecting and testing.

### OAuth Discovery Fails

**Problem:** Vodou can't discover OAuth endpoints automatically.

**Solution:**
```bash
# Provide OAuth endpoints manually
./do credentials <server-name> o-auth \
  --auth-endpoint "<manual-auth-endpoint>" \
  --token-endpoint "<manual-token-endpoint>"

# Check provider documentation for correct endpoints
```

**Prevention:** Have OAuth endpoints ready from provider documentation.

### Token Expired

**Problem:** Connection works initially but fails later with "token expired".

**Solution:**
```bash
# Re-run OAuth flow to get fresh token
./do credentials <server-name> auth

# Vodou will automatically use refresh token if available
# Otherwise, you'll need to re-authorize
```

**Prevention:** Vodou handles token refresh automatically when possible. Ensure refresh tokens are enabled in OAuth app.

### Port 8080 Already in Use

**Problem:** Vodou can't start callback server on port 8080.

**Solution:**
```bash
# Vodou will automatically find another available port
# Or specify custom redirect URI
./do credentials <server-name> o-auth \
  --redirect-uri "http://localhost:8081/callback"

# Update OAuth app settings to match
```

**Prevention:** Ensure port 8080 is available, or use a different port consistently.

---

## Quick Reference

```bash
# Discover OAuth requirements
./do connect <server-name> http --url <server-url>

# Discover available scopes
./do credentials <server-name> discover-scopes

# Configure OAuth
./do credentials <server-name> o-auth \
  --auth-endpoint "<auth-url>" \
  --token-endpoint "<token-url>" \
  --client-id "<client-id>" \
  --client-secret "<client-secret>" \
  --scope "<scopes>"

# Run OAuth flow
./do credentials <server-name> auth

# Verify credentials
./do credentials <server-name> list

# Connect to server
./do connect <server-name> http --url <server-url>

# Test connection
./do tools <server-name>
```

---

## Related Skills

- **hello** - General Vodou help and getting started
- **mastery** - Advanced Vodou techniques and patterns
- **mcp-installer** - Installing and managing MCP servers

---

## Additional Resources

- **Figma local MCP (PAT):** `MCP-servers/figma-developer-mcp/README.md` and `MCP-servers/Vodou-Console/presets/figma.json`
- **OAuth 2.0 Specification**: https://oauth.net/2/
- **MCP OAuth Extension**: https://modelcontextprotocol.io/specification/2025-11-25#oauth
- **RFC 8414** (OAuth 2.0 Authorization Server Metadata): https://tools.ietf.org/html/rfc8414
- **RFC 7591** (OAuth 2.0 Dynamic Client Registration): https://tools.ietf.org/html/rfc7591

---

## 🛑 **STOPPING POINT 6: What Would You Like to Do Next?**

**Choose a path:**
1. **Start OAuth Setup** - Begin configuring OAuth for your server
2. **See Examples** - View complete examples for specific providers
3. **Troubleshoot** - Help with a specific OAuth issue
4. **Advanced Topics** - Learn about DCR, token refresh, etc.
5. **Test Connection** - Verify OAuth setup is working
6. **Update Configuration** - Modify existing OAuth settings
7. **Remove OAuth** - Remove OAuth configuration
8. **Learn More** - Deep dive into OAuth concepts
9. **Exit** - Return to main Vodou help

**Which would you like to explore? (1-9)**

