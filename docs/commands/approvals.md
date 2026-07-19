# approvals - View Approval History

View approval history and pending approval requests for server operations.

## Syntax

```bash
vodou-core approvals <server-name> [OPTIONS]
```

## Description

The `approvals` command provides visibility into the user approval system, showing historical decisions and any pending approval requests. This is essential for security auditing and understanding server operation patterns.

The approval system tracks:
- **User decisions** - All approval/denial choices with timestamps
- **Operation types** - Categories of operations requiring approval (sampling, file operations, etc.)
- **Auto-approvals** - Operations automatically approved based on configured policies
- **Audit trail** - Complete history for security and compliance review

## Arguments

- `<server-name>` - Name of the server to show approvals for

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--pending` | Show only pending approval requests | `--pending` |
| `--limit <number>` | Limit number of entries shown (default: 50) | `--limit 100` |

## Examples

### View Approval History
```bash
# Show approval history for development server
vodou-core approvals dev-fs

# Show approval history for sampling server
vodou-core approvals ml-server

# Show recent approvals only
vodou-core approvals data-server --limit 20
```

### View Pending Approvals
```bash
# Check for pending approval requests
vodou-core approvals fs-server --pending

# Monitor approval queue
vodou-core approvals api-server --pending --limit 10
```

## Example Output

### Complete Approval History
```bash
$ vodou-core approvals dev-fs
📋 Approval History for server 'dev-fs':

🕒 Recent Approvals (Last 50 entries):

[2025-01-12 14:23:45] ✅ APPROVED - sampling
  Operation: Data sampling request
  Details: {"interval":5000,"types":["file_changes"]}
  Decision: User approved manually
  Comment: "Approved for development monitoring"

[2025-01-12 14:20:33] ✅ APPROVED - file_read  
  Operation: File read operation
  Details: {"path":"/home/user/projects/config.json"}
  Decision: Auto-approved (policy: read_operations)
  Comment: "Auto-approved per policy"

[2025-01-12 14:18:12] ❌ DENIED - file_write
  Operation: File write operation  
  Details: {"path":"/etc/hosts","content":"..."}
  Decision: User denied manually
  Comment: "System file access denied"

[2025-01-12 14:15:01] ✅ APPROVED - sampling
  Operation: Performance sampling
  Details: {"metrics":["cpu","memory"],"duration":600}
  Decision: Auto-approved (policy: sampling)
  Comment: "Auto-approved per policy"

📊 Summary:
  Total requests: 47
  Approved: 42 (89.4%)
  Denied: 5 (10.6%)  
  Auto-approved: 38 (80.9%)
  Manual decisions: 9 (19.1%)
```

### Pending Approvals Only
```bash
$ vodou-core approvals ml-server --pending
📋 Pending Approval Requests for server 'ml-server':

🔄 PENDING REQUESTS:

[2025-01-12 14:25:33] ⏳ PENDING - elicitation
  Operation: User input request
  Details: {"message":"Enter API key for data source","timeout":300}
  Requested: 2 minutes ago
  Status: Waiting for user response

[2025-01-12 14:24:12] ⏳ PENDING - sampling  
  Operation: Model training data sampling
  Details: {"dataset":"training_data","sample_rate":0.1}
  Requested: 3 minutes ago
  Status: Waiting for user approval

📊 Summary: 2 pending requests requiring user action
💡 Use tool operations to respond to pending requests
```

### Server with No Approvals
```bash
$ vodou-core approvals new-server
📋 Approval History for server 'new-server':

🔍 No approval requests found.

💡 This server hasn't requested any user approvals yet.
💡 Approval requests will appear here when the server requires user permission.
```

### Server with Auto-Approve Policy
```bash
$ vodou-core approvals auto-server --limit 10
📋 Approval History for server 'auto-server':

🕒 Recent Approvals (Last 10 entries):

[2025-01-12 14:22:15] ✅ APPROVED - read_file
  Operation: File read operation
  Details: {"path":"/app/data/config.json"}  
  Decision: Auto-approved (policy: auto)
  Comment: "Auto-approved per policy"

[2025-01-12 14:21:45] ✅ APPROVED - sampling
  Operation: Data sampling request
  Details: {"type":"performance","interval":10000}
  Decision: Auto-approved (policy: auto)
  Comment: "Auto-approved per policy"

📊 Summary:
  Total requests: 23
  Approved: 23 (100%)
  Denied: 0 (0%)
  Auto-approved: 23 (100%)
  Manual decisions: 0 (0%)

💡 Server has 'auto' approval policy - all operations auto-approved
```

## Error Handling

### Server Not Found
```bash
$ vodou-core approvals nonexistent-server
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Database Access Error
```bash
$ vodou-core approvals my-server
❌ Error: Unable to access approval history database
💡 Check database file permissions and try again
💡 Ensure no other instances of vodou-core are running
```

### Invalid Limit
```bash
$ vodou-core approvals dev-fs --limit -5
❌ Error: Limit must be a positive number
💡 Use --limit 10 or --limit 100 for reasonable limits
```

## Understanding Approval Types

### Operation Categories
- **`sampling`** - Data collection and performance monitoring operations
- **`file_read`** - File system read operations (usually auto-approved)
- **`file_write`** - File system write operations (often requires approval)
- **`elicitation`** - User input requests from server
- **`analysis`** - Data analysis and processing operations
- **`network`** - Network requests and API calls

### Decision Types
- **`User approved manually`** - Interactive user approval
- **`User denied manually`** - Interactive user denial  
- **`Auto-approved (policy: X)`** - Automatic approval based on policy
- **`Auto-denied (policy: X)`** - Automatic denial based on policy

### Approval Policies
- **`strict`** - All operations require manual approval
- **`relaxed`** - Safe operations auto-approved, sensitive require approval
- **`auto`** - All operations auto-approved (development only)

## Security and Audit Use Cases

### Security Audit Trail
```bash
# Review all approval decisions for compliance
vodou-core approvals prod-server --limit 1000 > audit-trail.txt

# Check for any denied operations
vodou-core approvals prod-server | grep "DENIED"

# Review manual decisions (non-auto-approved)
vodou-core approvals prod-server | grep -v "Auto-approved"
```

### Monitoring Suspicious Activity
```bash
# Check recent approval activity
vodou-core approvals sensitive-server --limit 20

# Look for unusual patterns
vodou-core approvals file-server | grep -E "(write|delete)"

# Monitor pending requests
vodou-core approvals all-servers --pending
```

### Compliance Reporting
```bash
#!/bin/bash
# generate-compliance-report.sh

echo "=== Approval Activity Report ==="
echo "Generated: $(date)"
echo

for server in $(vodou-core list | awk '{print $2}'); do
    echo "=== Server: $server ==="
    vodou-core approvals $server --limit 100 | grep -E "(APPROVED|DENIED)" | head -10
    echo
done
```

## Integration with Other Commands

### Workflow Example
```bash
# 1. Check pending approvals
vodou-core approvals ml-server --pending

# 2. If pending requests exist, handle them through tool operations
vodou-core call-tool analyze_data --args '{"dataset":"training"}'
# ^^ This might trigger approval request

# 3. Review approval decision
vodou-core approvals ml-server --limit 5
```

### Server Configuration Review
```bash
# 1. Check approval policy
vodou-core approval-policy ml-server

# 2. Review historical approvals
vodou-core approvals ml-server

# 3. Adjust policy if needed
vodou-core approval-policy ml-server --policy relaxed
```

## Approval Entry Details

### Entry Format
Each approval entry contains:
- **Timestamp** - When the request was made
- **Decision** - Approved/Denied/Pending status  
- **Operation Type** - Category of operation
- **Details** - JSON parameters of the operation
- **Decision Source** - Manual vs automatic
- **Comment** - Additional context or reasoning

### Filtering and Analysis
```bash
# Find all file operations
vodou-core approvals fs-server | grep -E "file_(read|write|delete)"

# Check sampling frequency  
vodou-core approvals ml-server | grep "sampling" | head -20

# Review user input requests
vodou-core approvals api-server | grep "elicitation"
```

## Performance and Limits

### Default Behavior
- **Default limit**: 50 most recent entries
- **Sorting**: Most recent first
- **Database query**: Indexed by server_id and timestamp

### Large Datasets
```bash
# For servers with many approvals, use pagination
vodou-core approvals busy-server --limit 100  # First 100
vodou-core approvals busy-server --limit 200  # First 200

# Focus on specific time periods through other tools if needed
```

## Related Commands

- [`approval-policy`](approval-policy.md) - Configure approval policies
- [`auto-approve`](auto-approve.md) - Set up auto-approval rules
- [`progress`](progress.md) - Monitor operation progress (often related to approvals)
- [`call-tool`](call-tool.md) - Operations that may trigger approval requests

## See Also

- [User Approval System](../security.md#user-approvals) - How approvals work
- [Security Best Practices](../security.md#approval-policies) - Policy configuration
- [Troubleshooting](../troubleshooting.md#approval-issues) - Approval system issues