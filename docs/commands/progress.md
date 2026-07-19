# progress - Monitor Operation Progress

Monitor progress of long-running server operations and track completion status.

## Syntax

```bash
vodou-core progress <server-name> [OPTIONS]
```

## Description

The `progress` command provides real-time monitoring of long-running operations executing on MCP servers. This enables users to track operation status, completion progress, and identify any issues with time-consuming tasks.

Progress tracking monitors:
- **Operation status** - Running, completed, cancelled, or failed operations
- **Completion percentage** - Real-time progress updates from 0% to 100%
- **Status messages** - Descriptive updates about current operation phase
- **Time tracking** - Start times, duration, and estimated completion
- **Operation types** - Sampling, analysis, file processing, network operations

## Arguments

- `<server-name>` - Name of the server to show operation progress for

## Options

| Option | Description | Example |
|--------|-------------|---------|
| `--all` | Show completed and cancelled operations in addition to running ones | `--all` |
| `--operation <id>` | Show details for a specific operation ID | `--operation sampling_abc123` |

## Examples

### View Active Operations
```bash
# Show currently running operations
vodou-core progress ml-server

# Show active operations for filesystem server
vodou-core progress data-fs

# Monitor progress of analysis server
vodou-core progress analytics-server
```

### View All Operations (Including Completed)
```bash
# Show all operations including completed ones
vodou-core progress ml-server --all

# Review complete operation history
vodou-core progress data-processor --all
```

### View Specific Operation Details
```bash
# Get details for specific operation
vodou-core progress ml-server --operation sampling_abc123

# Monitor specific analysis operation
vodou-core progress analytics-server --operation analysis_def456
```

## Example Output

### Active Operations
```bash
$ vodou-core progress ml-server
📊 Operation Progress for server 'ml-server':

🔄 RUNNING OPERATIONS:

[sampling_abc123] 📊 Data Sampling Operation
  Type: sampling
  Progress: 65.2% ████████████░░░░░░░░
  Status: Processing batch 13 of 20
  Started: 2025-01-12 14:20:15 (5 minutes ago)
  Estimated completion: 2 minutes remaining

[analysis_def456] 🧠 Model Analysis
  Type: analysis
  Progress: 23.8% ████░░░░░░░░░░░░░░░░
  Status: Loading training data
  Started: 2025-01-12 14:23:30 (2 minutes ago)
  Estimated completion: 8 minutes remaining

📊 Summary: 2 active operations, average progress: 44.5%
```

### Completed and Failed Operations (--all)
```bash
$ vodou-core progress data-processor --all
📊 Operation Progress for server 'data-processor':

🔄 RUNNING OPERATIONS:

[file_proc_789] 📁 File Processing
  Type: file_processing
  Progress: 45.0% █████████░░░░░░░░░░░
  Status: Processing file 450 of 1000
  Started: 2025-01-12 14:15:00 (10 minutes ago)
  Estimated completion: 12 minutes remaining

✅ COMPLETED OPERATIONS:

[backup_xyz123] 💾 Data Backup Completed
  Type: file_backup
  Progress: 100% ████████████████████
  Status: Backup completed successfully
  Started: 2025-01-12 13:45:00 (40 minutes ago)
  Completed: 2025-01-12 14:10:00 (25 minutes total)

[cleanup_456] 🧹 Temporary File Cleanup Completed
  Type: maintenance
  Progress: 100% ████████████████████
  Status: Cleanup completed, 1.2GB freed
  Started: 2025-01-12 14:05:00 (20 minutes ago)  
  Completed: 2025-01-12 14:07:30 (2.5 minutes total)

❌ FAILED OPERATIONS:

[network_sync_789] 🌐 Network Sync Failed
  Type: network
  Progress: 78.5% ███████████████░░░░░
  Status: Connection timeout to remote server
  Started: 2025-01-12 13:30:00 (55 minutes ago)
  Failed: 2025-01-12 14:00:00 (30 minutes total)
  Error: Remote server unreachable

📊 Summary: 1 running, 2 completed, 1 failed
```

### Specific Operation Details
```bash
$ vodou-core progress ml-server --operation sampling_abc123
📊 Detailed Progress for operation 'sampling_abc123':

🔄 OPERATION DETAILS:
  Operation ID: sampling_abc123
  Server: ml-server
  Type: sampling
  Status: running
  
📈 PROGRESS:
  Current: 72.3% ██████████████░░░░░░
  Phase: Processing batch 15 of 20
  Started: 2025-01-12 14:20:15
  Duration: 6 minutes 23 seconds
  Estimated remaining: 90 seconds
  
📋 STATUS HISTORY:
  [14:20:15] Started: Initializing data sampling
  [14:20:30] 5.0% - Loading configuration
  [14:21:00] 15.0% - Connecting to data source
  [14:21:45] 25.0% - Beginning batch processing
  [14:23:12] 45.0% - Processing batch 9 of 20
  [14:24:30] 65.0% - Processing batch 13 of 20
  [14:26:38] 72.3% - Processing batch 15 of 20

💡 This operation can be cancelled with: vodou-core cancel ml-server --operation sampling_abc123
```

### No Active Operations
```bash
$ vodou-core progress idle-server
📊 Operation Progress for server 'idle-server':

🔍 No active operations found.

💡 Server 'idle-server' has no running operations
💡 Use --all to see completed operations
💡 Operations will appear here when long-running tasks start
```

## Operation Types and Progress

### Common Operation Types
- **`sampling`** - Data collection and monitoring operations
- **`analysis`** - Data analysis and processing tasks
- **`file_processing`** - Bulk file operations (copy, move, transform)
- **`network`** - Network requests and data synchronization
- **`backup`** - Data backup and archival operations
- **`maintenance`** - System cleanup and optimization tasks

### Progress Indicators
- **Percentage** - Numerical completion percentage (0-100%)
- **Progress Bar** - Visual progress bar with filled/empty segments
- **Status Message** - Descriptive text about current operation phase
- **Time Information** - Start time, duration, estimated completion

## Error Handling

### Server Not Found
```bash
$ vodou-core progress nonexistent-server
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Operation Not Found
```bash
$ vodou-core progress ml-server --operation invalid_operation_id
❌ Error: Operation 'invalid_operation_id' not found for server 'ml-server'
💡 Use 'vodou-core progress ml-server' to see all operations
💡 Check operation ID spelling
```

### Database Access Error
```bash
$ vodou-core progress my-server
❌ Error: Unable to access progress tracking database
💡 Check database file permissions and try again
💡 Ensure no other instances of vodou-core are running
```

## Real-Time Monitoring

### Continuous Monitoring
```bash
# Monitor progress with periodic updates
while true; do
    clear
    vodou-core progress ml-server
    sleep 5
done

# Monitor specific operation
watch -n 2 "vodou-core progress data-server --operation file_proc_123"
```

### Progress Notifications
Operations automatically update progress in real-time when:
- **Progress percentage changes** (typically in 5-10% increments)
- **Status messages update** (new phase or milestone reached)
- **Operations complete or fail** (final status update)

## Integration with Approval System

### Progress for Approved Operations
```bash
# 1. Operation requires approval
vodou-core call-tool analyze_large_dataset --args '{"dataset":"training_data"}'
# 🔐 Server requests approval for: analysis
# ❓ Approve this operation? (y/N): y

# 2. Monitor approved operation progress
vodou-core progress analytics-server

# 3. Track completion
vodou-core progress analytics-server --operation analysis_xyz789
```

## Use Cases

### Development Workflow
```bash
# Start long-running operation
vodou-core call-tool process_codebase --args '{"path":"/large/project"}'

# Monitor progress while working on other tasks
vodou-core progress dev-server

# Check completion before next steps
vodou-core progress dev-server --all
```

### Data Processing Pipeline
```bash
# Start data processing job
vodou-core call-tool batch_process --args '{"files":1000,"operation":"transform"}'

# Monitor processing progress
vodou-core progress data-processor

# Verify completion before next pipeline stage
vodou-core progress data-processor --operation batch_proc_123 --all
```

### System Maintenance
```bash
# Start maintenance operation
vodou-core call-tool cleanup_logs --args '{"older_than":"30d","compress":true}'

# Monitor cleanup progress
vodou-core progress maintenance-server

# Verify disk space freed
vodou-core progress maintenance-server --all
```

## Performance Considerations

### Progress Update Frequency
- **Real-time updates** - Progress updates received as servers send them
- **Polling frequency** - Database checked every time command is run
- **History retention** - Completed operations kept for 7 days by default

### Large Operation Monitoring
```bash
# For operations processing thousands of items:
vodou-core progress big-data-server --operation massive_analysis_123

# Progress updates typically show:
# - Overall percentage (23.5%)
# - Current batch/item (Processing item 2,350 of 10,000)  
# - Estimated completion time
```

## Related Commands

- [`cancel`](cancel.md) - Cancel running operations shown in progress
- [`clear-progress`](clear-progress.md) - Clean up completed progress entries
- [`call-tool`](call-tool.md) - Start operations that can be tracked with progress
- [`approvals`](approvals.md) - View approval history for operations with progress tracking

## See Also

- [Operation Monitoring](../monitoring.md#progress-tracking) - How progress tracking works
- [Long-Running Operations](../operations.md#progress-monitoring) - Types of tracked operations
- [Troubleshooting](../troubleshooting.md#progress-issues) - Progress tracking issues