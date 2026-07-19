# auto-approve - Configure Auto-Approval Rules

Configure specific auto-approval rules for server operations, providing fine-grained control over which operations are automatically approved.

## Syntax

```bash
vodou-core auto-approve <server-name> [OPTIONS]
```

## Description

The `auto-approve` command provides granular control over automatic approvals, allowing you to specify exactly which operation types should be auto-approved regardless of the global approval policy. This enables fine-tuned security policies that balance automation with oversight.

Auto-approval rules:
- **Override global policy** - Auto-approve specific operations even with strict policy
- **Granular control** - Operation-type-specific automation
- **Security balance** - Automate safe operations, require approval for risky ones
- **Workflow optimization** - Reduce approval fatigue for routine operations

## Arguments

- `<server-name>` - Name of the server to configure auto-approval for

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--operations <ops>` | Comma-separated list of operations to auto-approve | `--operations read_operations,sampling` |
| `--enable` | Enable auto-approval for specified operations | `--enable` |
| `--disable` | Disable auto-approval for specified operations | `--disable` |

## Operation Types

### Safe Operations (Generally Safe to Auto-Approve)
- **`read_operations`** - File reading, directory listing
- **`sampling`** - Performance monitoring, data collection
- **`list_operations`** - Directory and resource listing
- **`status_operations`** - Server status and health checks

### Potentially Risky Operations (Consider Manual Approval)
- **`file_write`** - File creation and modification
- **`file_delete`** - File and directory deletion
- **`elicitation`** - User input requests
- **`network`** - External network requests
- **`analysis`** - Data analysis operations

## Examples

### Enable Auto-Approval for Safe Operations

#### Auto-Approve Read Operations
```bash
# Enable auto-approval for file reading
vodou-core auto-approve dev-fs --operations read_operations --enable

# Enable for multiple safe operations
vodou-core auto-approve project-server --operations read_operations,list_operations,sampling --enable

# Auto-approve only status checks
vodou-core auto-approve monitor-server --operations status_operations --enable
```

#### Auto-Approve Development Operations
```bash
# Development server - auto-approve safe operations
vodou-core auto-approve dev-fs \
  --operations read_operations,list_operations,sampling,status_operations \
  --enable

# Auto-approve common development operations
vodou-core auto-approve workspace-server \
  --operations read_operations,sampling \
  --enable
```

### Disable Auto-Approval for Risky Operations

#### Disable Risky Operations
```bash
# Ensure file writes require approval
vodou-core auto-approve prod-fs --operations file_write --disable

# Disable auto-approval for all risky operations
vodou-core auto-approve secure-server \
  --operations file_write,file_delete,network \
  --disable

# Require approval for user input requests
vodou-core auto-approve api-server --operations elicitation --disable
```

### View Current Auto-Approval Configuration
```bash
# Show current auto-approval rules
vodou-core auto-approve my-server

# Check production server auto-approvals
vodou-core auto-approve prod-fs
```

## Example Output

### Enabling Auto-Approval
```bash
$ vodou-core auto-approve dev-fs --operations read_operations,sampling --enable
🔓 Configuring auto-approval for server 'dev-fs'...

✅ Auto-approval enabled for operations:
  📖 read_operations (file reading, directory listing)
  📊 sampling (performance monitoring, data collection)

📋 Updated Auto-Approval Rules:
  ✅ Auto-approved operations:
    - read_operations (file reading)
    - sampling (data collection)
    - list_operations (directory listing) [existing]
    
  ❓ Manual approval still required:
    - file_write (file modifications)
    - file_delete (file removal)
    - elicitation (user input)
    - network (external requests)

💡 These rules override the global approval policy for specified operations
💡 Use 'vodou-core approvals dev-fs' to see approval history
```

### Disabling Auto-Approval
```bash
$ vodou-core auto-approve prod-server --operations file_write,network --disable
🔒 Configuring auto-approval for server 'prod-server'...

✅ Auto-approval disabled for operations:
  📝 file_write (file modifications)
  🌐 network (external requests)

📋 Updated Auto-Approval Rules:
  ❓ Manual approval now required:
    - file_write (file modifications) [UPDATED]
    - network (external requests) [UPDATED]
    - file_delete (file removal) [existing]
    - elicitation (user input) [existing]
    
  ✅ Auto-approved operations:
    - read_operations (file reading)
    - sampling (data collection)

🔒 Enhanced security: Sensitive operations now require manual approval
```

### Viewing Current Configuration
```bash
$ vodou-core auto-approve workspace-server
🔓 Auto-Approval Configuration for server 'workspace-server':

📋 Current Rules:
  Server: workspace-server
  Global Policy: relaxed
  Custom Rules: 4 operations configured
  
✅ Auto-Approved Operations:
  📖 read_operations
     - File reading (read_file, get_file_content)
     - Directory listing (list_directory, scan_directory)
     
  📊 sampling  
     - Performance monitoring (cpu_stats, memory_stats)
     - Data collection (collect_metrics, monitor_performance)
     
  📋 list_operations
     - Resource listing (list_resources, enumerate_items)
     - Status queries (list_status, show_items)

❓ Manual Approval Required:
  📝 file_write (file modifications)
  🗑️ file_delete (file removal)
  👤 elicitation (user input requests)
  🌐 network (external API calls)

📊 Recent Activity (Last 7 days):
  Auto-approved: 45 operations (78%)
  Manual approvals: 13 operations (22%)
```

## Error Handling

### Server Not Found
```bash
$ vodou-core auto-approve nonexistent-server --operations read_operations --enable
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Invalid Operation Type
```bash
$ vodou-core auto-approve dev-fs --operations invalid_operation --enable
❌ Error: Unknown operation type 'invalid_operation'
💡 Valid operations: read_operations, file_write, file_delete, sampling, elicitation, network, analysis, list_operations, status_operations
💡 Use comma-separated list for multiple operations
```

### Missing Action
```bash
$ vodou-core auto-approve dev-fs --operations read_operations
❌ Error: Must specify --enable or --disable
💡 Use --enable to allow auto-approval
💡 Use --disable to require manual approval
```

### Conflicting Options
```bash
$ vodou-core auto-approve dev-fs --operations read_operations --enable --disable
❌ Error: Cannot specify both --enable and --disable
💡 Use --enable to allow auto-approval
💡 Use --disable to require manual approval
```

## Advanced Configuration Examples

### Development Environment Setup
```bash
#!/bin/bash
# setup-dev-auto-approvals.sh

# Development filesystem server - auto-approve safe operations
vodou-core auto-approve dev-fs \
  --operations read_operations,list_operations,sampling \
  --enable

# Development API server - auto-approve read and monitoring
vodou-core auto-approve dev-api \
  --operations read_operations,sampling,status_operations \
  --enable

echo "Development auto-approval rules configured"
```

### Production Security Hardening
```bash
#!/bin/bash
# production-security-hardening.sh

# Production servers - disable auto-approval for risky operations
PROD_SERVERS="prod-fs prod-api prod-data"

for server in $PROD_SERVERS; do
    echo "Hardening auto-approval rules for $server..."
    
    # Disable all risky operations
    vodou-core auto-approve $server \
      --operations file_write,file_delete,network,elicitation \
      --disable
done

echo "Production security hardening complete"
```

### Progressive Trust Model
```bash
#!/bin/bash
# progressive-trust.sh - Gradually increase auto-approvals

SERVER="new-development-server"

# Phase 1: Only safe read operations
vodou-core auto-approve $SERVER \
  --operations read_operations \
  --enable

echo "Phase 1: Basic read operations auto-approved"
echo "Monitor for 1 week before Phase 2"

# Phase 2 (run after 1 week): Add monitoring
# vodou-core auto-approve $SERVER \
#   --operations read_operations,sampling,list_operations \
#   --enable

# Phase 3 (run after 2 weeks): Add status operations  
# vodou-core auto-approve $SERVER \
#   --operations read_operations,sampling,list_operations,status_operations \
#   --enable
```

## Security Considerations

### Safe vs. Risky Operations

#### Generally Safe to Auto-Approve:
- **`read_operations`** - Only reads data, doesn't modify system
- **`list_operations`** - Only lists information, no changes
- **`sampling`** - Only collects metrics, no system changes
- **`status_operations`** - Only queries status, no modifications

#### Requires Careful Consideration:
- **`file_write`** - Can modify or create files
- **`file_delete`** - Can permanently remove data
- **`network`** - Can access external systems
- **`elicitation`** - Can request sensitive user input
- **`analysis`** - May process sensitive data

### Best Practices

#### Start Conservative
```bash
# Begin with minimal auto-approvals
vodou-core auto-approve new-server --operations read_operations --enable

# Gradually add more as trust increases
vodou-core auto-approve trusted-server \
  --operations read_operations,sampling,list_operations \
  --enable
```

#### Environment-Specific Rules
```bash
# Development: More permissive
vodou-core auto-approve dev-server \
  --operations read_operations,sampling,list_operations,status_operations \
  --enable

# Production: Minimal auto-approval
vodou-core auto-approve prod-server \
  --operations read_operations \
  --enable
```

#### Regular Review
```bash
# Review auto-approval effectiveness
vodou-core approvals server-name  # Check approval history
vodou-core auto-approve server-name  # Review current rules

# Adjust based on usage patterns
```

## Integration with Approval Policies

### Policy Override Behavior
Auto-approval rules **override** global approval policies:

```bash
# Even with strict policy...
vodou-core approval-policy server --policy strict

# ...auto-approved operations don't require approval
vodou-core auto-approve server --operations read_operations --enable

# Result: read_operations auto-approved, everything else requires approval
```

### Combined Configuration
```bash
# Comprehensive server security setup:

# 1. Set global policy
vodou-core approval-policy secure-server --policy strict

# 2. Configure specific auto-approvals
vodou-core auto-approve secure-server \
  --operations read_operations,sampling \
  --enable

# 3. Verify configuration
vodou-core approval-policy secure-server
vodou-core auto-approve secure-server
```

## Monitoring Auto-Approval Effectiveness

### Review Approval Patterns
```bash
# Check how often auto-approvals are used
vodou-core approvals dev-server | grep "Auto-approved"

# Review manual approval frequency
vodou-core approvals dev-server | grep -v "Auto-approved"

# Analyze approval types
vodou-core approvals dev-server | grep -E "(read_operations|sampling|file_write)"
```

### Optimization Based on Usage
```bash
# If many manual approvals for safe operations, consider auto-approving:
vodou-core approvals server | grep "APPROVED.*read_operations" | wc -l
# If count is high, consider:
vodou-core auto-approve server --operations read_operations --enable

# If auto-approved operations are frequently problematic, disable:
vodou-core auto-approve server --operations risky_operation --disable
```

## Related Commands

- [`approval-policy`](approval-policy.md) - Set global approval policies (auto-approve overrides these)
- [`approvals`](approvals.md) - View approval history showing auto-approved vs manual
- [`connect`](connect.md) - Set initial auto-approval with `--auto-approve`
- [`call-tool`](call-tool.md) - Operations that may be auto-approved

## See Also

- [User Approval System](../security.md#auto-approval-rules) - How auto-approval works
- [Security Best Practices](../security.md#operation-classification) - Safe vs. risky operations
- [Troubleshooting](../troubleshooting.md#approval-issues) - Auto-approval configuration issues