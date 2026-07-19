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









