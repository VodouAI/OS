# approval-policy - Configure Approval Policies

Configure user approval policies for server operations.

## Syntax

```bash
vodou-core approval-policy <server-name> [OPTIONS]
```

## Description

The `approval-policy` command configures how Brain Trust 4 handles approval requests from servers. Different policies provide different levels of automation vs. manual control, allowing you to balance security with usability.

Approval policies control:
- **Operation approval** - Which operations require manual user approval
- **Security posture** - Level of human oversight for server actions
- **Development workflow** - Automation level appropriate for environment
- **Risk management** - Balance between security and productivity

## Arguments

- `<server-name>` - Name of the server to configure approval policy for

## Options

| Option | Description | Values |
|--------|-------------|---------|
| `--policy <policy>` | Set approval policy | `strict`, `relaxed`, `auto` |
| `--operations <ops>` | Apply policy to specific operation types | `sampling,file_read,file_write` |

## Approval Policies

### Strict Policy (`strict`)
- **All operations require manual approval**
- **Highest security** - Maximum human oversight
- **Best for**: Production servers, sensitive data, compliance environments
- **User interaction**: Every operation prompts for approval

### Relaxed Policy (`relaxed`)  
- **Safe operations auto-approved, sensitive operations require approval**
- **Balanced security** - Automated safety with human oversight for risk
- **Best for**: Development servers, trusted environments, daily usage
- **User interaction**: Only potentially risky operations prompt for approval

### Auto Policy (`auto`)
- **All operations automatically approved**
- **Lowest security** - No human oversight
- **Best for**: Development environments, testing, automation
- **User interaction**: No approval prompts (fully automated)

## Examples

### Set Server-Wide Policies

#### Configure Strict Policy (Production)
```bash
# Production server - require approval for everything
vodou-core approval-policy prod-server --policy strict

# High-security filesystem server
vodou-core approval-policy secure-fs --policy strict

# Compliance-required server
vodou-core approval-policy audit-server --policy strict
```

#### Configure Relaxed Policy (Development)
```bash
# Development server - balance security and usability
vodou-core approval-policy dev-server --policy relaxed

# Daily-use filesystem server
vodou-core approval-policy project-fs --policy relaxed

# Standard development workflow
vodou-core approval-policy workspace-server --policy relaxed
```

#### Configure Auto Policy (Testing)
```bash
# Testing environment - full automation
vodou-core approval-policy test-server --policy auto

# CI/CD automation server
vodou-core approval-policy build-server --policy auto

# Development sandbox
vodou-core approval-policy sandbox-fs --policy auto
```

### Configure Operation-Specific Policies
```bash
# Apply strict policy only to file write operations
vodou-core approval-policy dev-fs --policy strict --operations file_write

# Require approval for sampling and analysis
vodou-core approval-policy ml-server --policy strict --operations sampling,analysis

# Auto-approve only read operations
vodou-core approval-policy data-server --policy auto --operations file_read,list_operations
```

### View Current Policy
```bash
# Check current approval policy
vodou-core approval-policy my-server

# Review policy for production server
vodou-core approval-policy prod-fs
```

## Example Output

### Setting Server Policy
```bash
$ vodou-core approval-policy dev-server --policy relaxed
🔐 Updating approval policy for server 'dev-server'...

✅ Approval policy updated:
  Server: dev-server
  Policy: relaxed
  
📋 Policy behavior:
  ✅ Auto-approved operations:
    - file_read (file reading)
    - list_operations (directory listing)
    - sampling (performance monitoring)
    
  ❓ Manual approval required:
    - file_write (file modifications)
    - file_delete (file removal)
    - elicitation (user input requests)
    - network (external API calls)

💡 Use 'vodou-core auto-approve dev-server' to customize auto-approval rules
```

### Setting Operation-Specific Policy
```bash
$ vodou-core approval-policy data-fs --policy strict --operations file_write,file_delete
🔐 Updating approval policy for server 'data-fs'...

✅ Operation-specific policy updated:
  Server: data-fs
  Operations: file_write, file_delete
  Policy: strict (manual approval required)
  
📋 Current policy configuration:
  ❓ Manual approval required:
    - file_write (file modifications) [UPDATED]
    - file_delete (file removal) [UPDATED]
    
  ✅ Using previous policy for other operations:
    - file_read (auto-approved)
    - sampling (auto-approved)
    - list_operations (auto-approved)

💡 Changes take effect immediately for new operations
```

### Viewing Current Policy
```bash
$ vodou-core approval-policy prod-server
🔐 Approval Policy for server 'prod-server':

📋 Current Configuration:
  Server: prod-server
  Global Policy: strict
  Applied: 2025-01-12 10:30:15
  
📋 Policy Details:
  ❓ ALL operations require manual approval:
    - sampling (data collection)
    - file_read (file access)
    - file_write (file modifications)
    - file_delete (file removal)
    - elicitation (user input)
    - analysis (data processing)
    - network (external requests)

📊 Recent Activity (Last 24 hours):
  Total requests: 15
  Approved: 12 (80%)
  Denied: 3 (20%)
  Auto-approved: 0 (0%)
```

## Policy Behavior Details

### Strict Policy Behavior
```bash
# With strict policy, ALL operations prompt:
$ vodou-core call-tool read_file --args '{"path":"config.json"}'
🔐 Server requests approval for: file_read
   Details: {"path":"config.json"}
   Approve this operation? (y/N): y
✅ Operation approved

# Even safe operations require approval:
$ vodou-core call-tool list_directory --args '{"path":"/tmp"}'
🔐 Server requests approval for: list_operations
   Details: {"path":"/tmp"}
   Approve this operation? (y/N): y
✅ Operation approved
```

### Relaxed Policy Behavior
```bash
# Safe operations auto-approved:
$ vodou-core call-tool read_file --args '{"path":"config.json"}'
✅ Auto-approved file_read: config.json
{...file content...}

# Risky operations require approval:
$ vodou-core call-tool write_file --args '{"path":"important.txt","content":"new data"}'
🔐 Server requests approval for: file_write
   Details: {"path":"important.txt","content":"new data"}
   Approve this operation? (y/N): y
✅ Operation approved
```

### Auto Policy Behavior
```bash
# All operations auto-approved (no prompts):
$ vodou-core call-tool write_file --args '{"path":"test.txt","content":"data"}'
✅ Auto-approved file_write: test.txt
{...operation result...}

$ vodou-core call-tool delete_file --args '{"path":"old.txt"}'
✅ Auto-approved file_delete: old.txt
{...operation result...}
```

## Error Handling

### Server Not Found
```bash
$ vodou-core approval-policy nonexistent-server --policy strict
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Invalid Policy
```bash
$ vodou-core approval-policy dev-server --policy invalid
❌ Error: Invalid approval policy 'invalid'
💡 Valid policies: strict, relaxed, auto
💡 Use --help to see all options
```

### Invalid Operations
```bash
$ vodou-core approval-policy dev-fs --operations invalid_operation
❌ Error: Unknown operation type 'invalid_operation'
💡 Valid operations: sampling, file_read, file_write, file_delete, elicitation, analysis, network
💡 Use comma-separated list for multiple operations
```

## Environment-Specific Recommendations

### Development Environment
```bash
# Recommended: Relaxed policy for productivity
vodou-core approval-policy dev-fs --policy relaxed
vodou-core approval-policy dev-api --policy relaxed

# Alternative: Auto for rapid development
vodou-core approval-policy sandbox-server --policy auto
```

### Production Environment  
```bash
# Recommended: Strict policy for security
vodou-core approval-policy prod-fs --policy strict
vodou-core approval-policy prod-api --policy strict
vodou-core approval-policy prod-data --policy strict
```

### CI/CD Environment
```bash
# Recommended: Auto policy for automation
vodou-core approval-policy build-server --policy auto
vodou-core approval-policy test-runner --policy auto
vodou-core approval-policy deploy-agent --policy auto
```

## Security Considerations

### Policy Selection Guidelines

#### Use Strict Policy When:
- **Production servers** with sensitive data
- **Compliance requirements** mandate human oversight
- **High-risk operations** like financial or medical data
- **Shared servers** used by multiple users
- **First-time server usage** until trust is established

#### Use Relaxed Policy When:
- **Development servers** with non-sensitive data
- **Personal projects** with trusted code
- **Daily workflow** servers requiring productivity
- **Well-tested servers** with established trust
- **Educational or learning** environments

#### Use Auto Policy When:
- **Testing environments** requiring full automation
- **CI/CD pipelines** with no human oversight
- **Development sandboxes** with disposable data
- **Local development** servers
- **Performance testing** requiring uninterrupted operation

### Security Best Practices

```bash
# Start strict, relax as trust increases
vodou-core approval-policy new-server --policy strict
# ... after testing and validation ...
vodou-core approval-policy new-server --policy relaxed

# Use operation-specific policies for fine control
vodou-core approval-policy mixed-server --policy relaxed --operations file_read,sampling
vodou-core approval-policy mixed-server --policy strict --operations file_write,file_delete

# Regular policy review
vodou-core approval-policy prod-server  # Review current policy
vodou-core approvals prod-server        # Review approval history
```

## Integration Examples

### Development Workflow Setup
```bash
#!/bin/bash
# setup-dev-policies.sh - Configure development environment policies

# Development servers: relaxed for productivity
vodou-core approval-policy dev-fs --policy relaxed
vodou-core approval-policy dev-api --policy relaxed

# Testing servers: auto for automation
vodou-core approval-policy test-fs --policy auto
vodou-core approval-policy mock-api --policy auto

echo "Development approval policies configured"
```

### Production Deployment
```bash
#!/bin/bash
# production-security-setup.sh

# All production servers: strict policy
for server in prod-fs prod-api prod-data; do
    vodou-core approval-policy $server --policy strict
    echo "Configured strict policy for $server"
done

# Verify policies
echo "=== Production Policy Verification ==="
for server in prod-fs prod-api prod-data; do
    echo "Policy for $server:"
    vodou-core approval-policy $server
done
```

### Policy Migration
```bash
#!/bin/bash
# migrate-to-relaxed.sh - Migrate from strict to relaxed after trust period

# Servers that have proven trustworthy
TRUSTED_SERVERS="dev-fs-1 dev-fs-2 workspace-server"

for server in $TRUSTED_SERVERS; do
    echo "Migrating $server from strict to relaxed..."
    vodou-core approval-policy $server --policy relaxed
done
```

## Related Commands

- [`approvals`](approvals.md) - View approval history affected by policies
- [`auto-approve`](auto-approve.md) - Configure specific auto-approval rules
- [`connect`](connect.md) - Set initial approval policy with `--approval-policy`
- [`call-tool`](call-tool.md) - Operations that trigger approval requests

## See Also

- [User Approval System](../security.md#approval-policies) - Detailed policy behavior
- [Security Best Practices](../security.md#policy-recommendations) - Policy selection guide
- [Troubleshooting](../troubleshooting.md#approval-issues) - Policy configuration issues