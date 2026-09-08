# Credentials Command

Manage authentication credentials for remote MCP servers.

## Syntax

```bash
vodou-core credentials <server> <command> [options]
```

## Commands

### `add` - Add Credential

Add a new credential for a server.

```bash
vodou-core credentials <server> add [options]
```

#### Options

- `--cred-type <type>` - Credential type: `api_key`, `bearer_token`, `oauth_token`, `env_var` (default: `api_key`)
- `--from-env <var>` - Use environment variable instead of storing value (recommended)
- `--header <name>` - HTTP header name (default: `Authorization` for bearer/oauth, `X-API-Key` for api_key)
- `--format <format>` - Header format template (e.g., `Bearer {token}`, `{key}`)
- `<value>` - Credential value (optional if using `--from-env`)

#### Examples

**API Key (stored in database):**
```bash
vodou-core credentials gusto add --cred-type api_key "sk-xxx" --header "X-API-Key"
```

**API Key (from environment variable - recommended):**
```bash
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"
```

**Bearer Token:**
```bash
vodou-core credentials api-server add --cred-type bearer_token "token-xxx" --header "Authorization" --format "Bearer {token}"
```

**OAuth Token:**
```bash
vodou-core credentials figma add --cred-type oauth_token --from-env "FIGMA_TOKEN" --header "Authorization" --format "Bearer {token}"
```

For **gateway Apps → Figma** (local npm MCP), put `FIGMA_API_KEY=figd_…` in the project `.env` instead; that path does not use `vodou-core credentials` for the PAT.

### `list` - List Credentials

List all credentials for a server.

```bash
vodou-core credentials <server> list
```

#### Output

Shows all configured credentials with:
- Credential type
- Source (database, env, cli)
- Header name
- Header format (if applicable)
- Environment variable name (if using `--from-env`)

#### Example

```bash
$ vodou-core credentials gusto list

Credentials for 'gusto':
  - Type: api_key
    Source: env
    Header: X-API-Key
    Env Var: GUSTO_API_KEY
```

### `remove` - Remove Credential

Remove a credential for a server.

```bash
vodou-core credentials <server> remove --cred-type <type>
```

#### Options

- `--cred-type <type>` - Credential type to remove (required)

#### Examples

```bash
# Remove API key credential
vodou-core credentials gusto remove --cred-type api_key

# Remove bearer token
vodou-core credentials api-server remove --cred-type bearer_token
```

### `test` - Test Credentials

Test if credentials work by attempting to connect to the server.

```bash
vodou-core credentials <server> test
```

#### Example

```bash
$ vodou-core credentials gusto test

Testing credentials for 'gusto'...
✅ Credentials valid - server responded successfully
```

## Credential Types

### `api_key`

Standard API key authentication.

**Default Header**: `X-API-Key`

**Examples**:
```bash
# Stored value
vodou-core credentials gusto add --cred-type api_key "sk-xxx" --header "X-API-Key"

# From environment
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"
```

### `bearer_token`

Bearer token authentication (OAuth 2.0 style).

**Default Header**: `Authorization`

**Default Format**: `Bearer {token}`

**Examples**:
```bash
# Stored value
vodou-core credentials api-server add --cred-type bearer_token "token-xxx" --header "Authorization" --format "Bearer {token}"

# From environment
vodou-core credentials api-server add --cred-type bearer_token --from-env "API_TOKEN" --header "Authorization" --format "Bearer {token}"
```

### `oauth_token`

OAuth access token (same as bearer_token but semantically different).

**Default Header**: `Authorization`

**Default Format**: `Bearer {token}`

**Examples**:
```bash
vodou-core credentials figma add --cred-type oauth_token --from-env "FIGMA_TOKEN" --header "Authorization" --format "Bearer {token}"
```

Use that pattern for a **remote** Figma HTTP MCP connection. The **Apps → Figma** local npm server expects **`FIGMA_API_KEY`** in `.env`, not this credentials row.

## Credential Priority

When connecting to a server, credentials are loaded in this priority order:

1. **Database credentials** (highest - explicit configuration)
2. **Environment variables** (automatic fallback)
3. **CLI flags** (lowest - temporary for testing)

## Security Best Practices

### Use Environment Variables

**Recommended**: Use `--from-env` to store credential references instead of values:

```bash
# ✅ Good: Stores env var name, not value
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# Then in .env file:
GUSTO_API_KEY=sk-xxx
```

**Benefits**:
- Credential value never stored in database
- Single source of truth (`.env` file)
- Easy to rotate credentials
- More secure

### Stored Values

**Less Secure**: Storing values directly in database:

```bash
# ⚠️ Less secure: Value stored in database
vodou-core credentials gusto add --cred-type api_key "sk-xxx" --header "X-API-Key"
```

**Use When**:
- Testing or development
- Temporary credentials
- When environment variables aren't available

### Encryption at rest, and the key that does it

A value stored in the database is encrypted with **AES-256-GCM** before it is
written. Rows look like `enc:v2:<nonce>/<ciphertext>`; a row with no prefix is a
legacy plaintext value and still works.

The key is a random 32-byte **data key** at `.vodou/credential.key`, mode `0600`,
generated on first use.

- **It is unique to your install.** 32 bytes from the OS random source, generated
  on your machine the first time a credential is read or written. It is not derived
  from your account, your machine, or anything shipped in the archive — two installs
  never share one, and no release contains one (the publish gates fail if a
  `credential.key` is ever staged into an archive).
- **Back it up with `vodou-core.db`.** They are one unit. A database restored
  without its key holds credentials nobody can read, and every server has to be
  reconnected.
- **Do not copy it between installs**, and do not commit it — `.vodou/` is
  gitignored for this reason.
- **What it protects:** a copy of the database alone (a `*.db` backup, a synced
  folder). It does *not* protect a copy of the whole install directory, because the
  key is in that directory. If you need that, keep credentials in `.env` with
  `--from-env` and protect the file system instead.

#### It is not your Vodou account token

Through v0.6.28 the key was `SHA-256(VODOU_TOKEN)` — the same cloud account token
that signing in rewrites. Reconnecting your account therefore made every stored
credential permanently unreadable, and the only symptom was integrations quietly
failing to authenticate. If you are upgrading, the migration re-encrypts your
existing credentials onto the new key automatically, using the token you have now.

Anything it cannot re-encrypt — because the token already changed — is **marked**
rather than silently emptied:

```bash
vodou-core credentials <server> test
#   • oauth_refresh_token: 🔑 unreadable — encrypted with the Vodou account token
#     in use when it was saved; that token has since changed
```

The Console's server card shows the same thing as "reconnect required". Reconnecting
the server clears the mark.

#### If the key is exposed

Treat it like any other secret: replace it, then re-enter what it protected.

```bash
rm .vodou/credential.key        # a new one is generated on the next use
```

Every `enc:v2:` credential becomes unreadable at that point and each affected
server must be reconnected — so check what you would lose first (`vodou-core
credentials <server> test` per server). If nothing has been encrypted yet, the
rotation costs nothing.

## Examples

### Complete Workflow

```bash
# 1. Connect to server
vodou-core connect gusto --url https://mcp.api.gusto.com/anthropic

# 2. Add credential from environment variable
vodou-core credentials gusto add --cred-type api_key --from-env "GUSTO_API_KEY" --header "X-API-Key"

# 3. Add to .env file
echo "GUSTO_API_KEY=sk-xxx" >> .env

# 4. Test credentials
vodou-core credentials gusto test

# 5. List credentials
vodou-core credentials gusto list
```

### Multiple Credentials

```bash
# Add multiple credential types for same server
vodou-core credentials api-server add --cred-type api_key --from-env "API_KEY" --header "X-API-Key"
vodou-core credentials api-server add --cred-type bearer_token --from-env "BEARER_TOKEN" --header "Authorization" --format "Bearer {token}"

# Both will be sent in requests (if server requires multiple headers)
```

### Custom Headers

```bash
# Custom header name and format
vodou-core credentials custom-api add --cred-type api_key "key-xxx" --header "X-Custom-Auth" --format "{key}"
```

## Related Commands

- [`connect`](./connect.md) - Connect to MCP servers
- [`list`](./list.md) - List connected servers
- [`status`](./status.md) - Check server status

## Related Documentation

- [Remote Servers Guide](../../docs-DEV/remote-servers.md) (internal) — complete remote server guide
- [CLI Reference](../cli-reference.md) - Full command reference
- [Troubleshooting](../troubleshooting.md) - Common issues









