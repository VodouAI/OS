# resources - Server Resources Discovery

Show all available resources (data sources) for a specific MCP server, including files, APIs, databases, and other read-only data sources that can be accessed by AI agents.

## Syntax

```bash
vodou-core resources <NAME>
```

## Parameters

| Parameter | Required | Description |
|-----------|----------|-------------|
| `<NAME>` | Yes | Server name (from `list` command) |

## Examples

```bash
# Show resources for MCP advisor (has log files)
vodou-core resources mcpadvisor

# Show resources for data server
vodou-core resources data-server

# Show resources for documentation server
vodou-core resources docs-server
```

## Output Examples

### Log File Resources (mcpadvisor)
```
📄 Resources for mcpadvisor:
  - file:///var/log/system.log
    Name: Log: system.log
    Description: Log file from /var/log
    Type: text/plain

  - file:///var/log/install.log
    Name: Log: install.log
    Description: Log file from /var/log
    Type: text/plain

  - file:///var/log/wifi.log
    Name: Log: wifi.log
    Description: Log file from /var/log
    Type: text/plain

  - file:///tmp/adobegc.log
    Name: Log: adobegc.log
    Description: Log file from /tmp
    Type: text/plain

  - file:///tmp/oobelib.log
    Name: Log: oobelib.log
    Description: Log file from /tmp
    Type: text/plain
```

### API and Database Resources
```
📄 Resources for api-server:
  - https://api.weather.gov/stations
    Name: Weather Stations API
    Description: NOAA weather station data
    Type: application/json

  - postgresql://localhost:5432/analytics
    Name: Analytics Database
    Description: Historical analytics data
    Type: application/sql

  - file:///etc/config/app.conf
    Name: Application Configuration
    Description: Main application settings
    Type: text/plain
```

### Documentation Resources
```
📄 Resources for docs-server:
  - file:///docs/api/README.md
    Name: API Documentation
    Description: Complete API reference
    Type: text/markdown

  - https://github.com/company/repo/wiki
    Name: Project Wiki
    Description: Project documentation wiki
    Type: text/html

  - file:///specs/technical-spec.pdf
    Name: Technical Specification
    Description: Detailed technical requirements
    Type: application/pdf
```

### No Resources Available
```
No resources found for server: mcp-monitor
Try connecting first: vodou-core connect mcp-monitor <command> <args...>
```

## Resource Types

### File Resources (`file://`)
Local files that can be read by AI agents:

**Log Files:**
- System logs: `/var/log/system.log`, `/var/log/install.log`
- Application logs: `/tmp/app.log`, `/var/log/myapp.log`
- Error logs: `/var/log/errors.log`, `/tmp/debug.log`

**Configuration Files:**
- App configs: `/etc/myapp/config.conf`, `./config/settings.json`
- System configs: `/etc/hosts`, `/etc/nginx/nginx.conf`
- User configs: `~/.bashrc`, `~/.gitconfig`

**Documentation Files:**
- README files: `./README.md`, `./docs/README.md`
- Technical docs: `./docs/api.md`, `./ARCHITECTURE.md`
- Specifications: `./specs/*.pdf`, `./requirements/*.txt`

**Data Files:**
- CSV data: `./data/metrics.csv`, `./exports/report.csv`
- JSON data: `./data/config.json`, `./cache/results.json`
- XML data: `./data/feed.xml`, `./config/settings.xml`

### HTTP/HTTPS Resources (`https://`)
Web APIs and online data sources:

**Public APIs:**
- Weather: `https://api.weather.gov/`, `https://api.openweathermap.org/`
- GitHub: `https://api.github.com/repos/user/repo`
- Documentation: `https://docs.example.com/api`

**Internal APIs:**
- Company APIs: `https://internal-api.company.com/`
- Monitoring: `https://metrics.internal.com/api`
- Databases: `https://database-api.internal.com/`

### Database Resources
Direct database connections:

**SQL Databases:**
- PostgreSQL: `postgresql://host:port/database`
- MySQL: `mysql://host:port/database`  
- SQLite: `sqlite:///path/to/database.db`

**NoSQL Databases:**
- MongoDB: `mongodb://host:port/database`
- Redis: `redis://host:port/database`

**Note**: Database resources may require authentication handled by the MCP server.

### Other Resource Types
- **Email**: `mailto:` schemes for email access
- **Cloud Storage**: `s3://`, `gcs://` for cloud storage
- **Network**: `tcp://`, `udp://` for network services

## Resource Metadata

Each resource includes:

### Required Information
- **URI** - Unique resource identifier (file path, URL, etc.)

### Optional Information  
- **Name** - Human-readable resource name
- **Description** - What the resource contains or provides
- **MIME Type** - Content type (text/plain, application/json, etc.)

### MIME Type Examples
- **Text files**: `text/plain`, `text/markdown`, `text/html`
- **Data files**: `application/json`, `application/xml`, `text/csv`
- **Documents**: `application/pdf`, `application/msword`
- **Images**: `image/png`, `image/jpeg`, `image/svg+xml`
- **Databases**: `application/sql`, `application/x-sqlite3`

## Resource Discovery Process

Resources are discovered during the `connect` operation:

1. **Connection established** with MCP server
2. **Protocol initialized** following MCP specification  
3. **Resources listed** via `resources/list` MCP method
4. **Metadata extracted** from resource definitions
5. **Database stored** for persistent access
6. **Graceful fallback** if server doesn't support resources

## Use Cases for Resources

### 1. Log Analysis
AI agents can read log files to:
- Analyze error patterns
- Monitor system health
- Debug application issues
- Generate reports

### 2. Documentation Access
AI agents can access documentation to:
- Answer questions about APIs
- Provide implementation guidance
- Explain system architecture
- Generate code examples

### 3. Data Analysis
AI agents can read data files to:
- Analyze trends and patterns
- Generate insights and reports
- Perform data validation
- Create visualizations

### 4. Configuration Management
AI agents can read config files to:
- Understand system setup
- Validate configurations
- Suggest optimizations
- Debug configuration issues

### 5. Real-time Data Access
AI agents can access APIs to:
- Get current status information
- Fetch live data feeds
- Monitor external systems
- Integrate with third-party services

## Resource Access (Conceptual)

**Note**: Brain Trust 4 currently **discovers and lists** resources, but doesn't directly read them. Resource access would typically be handled by:

1. **MCP server tools** that read resources and return content
2. **AI agents** that use MCP servers to access resources
3. **Direct integration** with resource access capabilities (future)

Example workflow:
```bash
# 1. Discover resources
vodou-core resources log-server

# 2. Use server tools to access resources (if available)
vodou-core call log-server read_log_file '{"path": "/var/log/system.log", "lines": 100}'

# 3. Or let AI agents use the server directly for resource access
```

## Error Scenarios

### Server Not Found
```
No resources found for server: unknown-server
Try connecting first: vodou-core connect unknown-server <command> <args...>
```

**Solution**: Check server name with `vodou-core list` or connect the server.

### Server Connected but No Resources
```
No resources found for server: tool-only-server
Try connecting first: vodou-core connect tool-only-server <command> <args...>
```

**Note**: This is normal for many servers. Not all MCP servers provide resources - many provide only tools or prompts.

### Resource Discovery Failed
If resources were expected but not found:
```bash
# Reconnect to refresh capabilities
vodou-core connect resource-server node ./server.js

# Check if server supports resources
vodou-core capabilities resource-server | grep "📄 Resources"
```

## Server Categories by Resources

### Log Aggregation Servers
Provide access to various log files:
- System logs, application logs, error logs
- Centralized logging solutions
- Log analysis and monitoring tools

### Documentation Servers
Provide access to project documentation:
- README files, API documentation
- Technical specifications, user guides
- Wiki pages, knowledge bases

### Data Source Servers
Provide access to data repositories:
- CSV files, JSON datasets
- Database exports, analytics data
- Configuration files, cache data

### API Gateway Servers
Provide access to external APIs:
- Public API endpoints
- Internal microservices  
- Third-party integrations

### File System Servers
Provide access to file systems:
- Project directories
- Configuration directories
- Data storage locations

## Integration Examples

### Resource Inventory
```bash
#!/bin/bash
# Create inventory of all available resources

echo "=== MCP Resource Inventory ==="
echo "============================"

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    RESOURCE_COUNT=$(vodou-core resources "$server" 2>/dev/null | grep -c "^  -" || echo "0")
    
    if [ "$RESOURCE_COUNT" -gt 0 ]; then
        echo ""
        echo "📄 $server: $RESOURCE_COUNT resources"
        vodou-core resources "$server" | grep "^  -" | head -3 | sed 's/^  -/  •/'
        if [ "$RESOURCE_COUNT" -gt 3 ]; then
            echo "  ... and $(($RESOURCE_COUNT - 3)) more"
        fi
    fi
done
```

### Resource Type Analysis
```bash
#!/bin/bash
# Analyze resource types across all servers

echo "=== Resource Type Analysis ==="

declare -A resource_types

vodou-core list | grep "^  -" | cut -d: -f1 | sed 's/^  - //' | while read server; do
    vodou-core resources "$server" 2>/dev/null | grep "Type:" | while read line; do
        type=$(echo "$line" | cut -d: -f2 | xargs)
        echo "$type"
    done
done | sort | uniq -c | sort -nr
```

### Resource Accessibility Check
```bash
#!/bin/bash  
# Check which resources are actually accessible

SERVER="$1"
if [ -z "$SERVER" ]; then
    echo "Usage: $0 <server-name>"
    exit 1
fi

vodou-core resources "$SERVER" | grep "^  -" | while read line; do
    uri=$(echo "$line" | cut -d: -f2- | xargs)
    
    case "$uri" in
        file://*)
            filepath=${uri#file://}
            if [ -r "$filepath" ]; then
                echo "✅ $uri (readable)"
            else
                echo "❌ $uri (not readable)"
            fi
            ;;
        https://*)
            if curl -s --head "$uri" >/dev/null 2>&1; then
                echo "✅ $uri (accessible)"
            else
                echo "❌ $uri (not accessible)"
            fi
            ;;
        *)
            echo "❓ $uri (unknown accessibility)"
            ;;
    esac
done
```

## Performance Considerations

### Resource Discovery Performance
- **Discovery during connection** - all resources discovered at once
- **Database storage** - resources cached locally
- **No network calls** - `resources` command uses cached data only
- **Fast queries** - sub-millisecond for typical resource counts

### Large Resource Lists
For servers with many resources (100+ resources):
- **Filtering by type** using `grep`
- **Searching by name** using text search
- **Categorization** by URI scheme

```bash
# Filter by resource type
vodou-core resources big-server | grep "file://"
vodou-core resources big-server | grep "https://"
vodou-core resources big-server | grep "Type: application/json"

# Search by name or description
vodou-core resources big-server | grep -i "config"
vodou-core resources big-server | grep -i "log"
```

## Related Commands

- [`capabilities`](capabilities.md) - High-level server capability overview including resources
- [`connect`](connect.md) - Discover and store resources during connection
- [`list`](list.md) - Find server names to use with resources command
- [`tools`](tools.md) - View server tools (may include resource access tools)

## See Also

- [Examples](../examples.md#resource-discovery) - Resource discovery and analysis examples
- [CLI Reference](../cli-reference.md#resources) - Complete command reference
- [Architecture](../../docs-DEV/architecture.md#resource-discovery) (internal) — how resource discovery works internally