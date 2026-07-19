# cancel - Cancel Running Operations

Cancel running server operations that are currently in progress.

## Syntax

```bash
vodou-core cancel <server-name> --operation <operation-id>
```

## Description

The `cancel` command allows you to terminate long-running operations that are currently executing on MCP servers. This is essential for stopping operations that are taking too long, consuming excessive resources, or are no longer needed.

Cancellation features:
- **Graceful termination** - Allows operations to clean up properly before stopping
- **Immediate stopping** - Terminates operations that don't respond to graceful requests
- **Resource cleanup** - Frees up server resources used by cancelled operations
- **Progress preservation** - Maintains operation history showing cancellation reason

## Arguments

- `<server-name>` - Name of the server running the operation to cancel

## Required Options

| Option | Description | Example |
|--------|-------------|---------|
| `--operation <id>` | Specific operation ID to cancel | `--operation sampling_abc123` |

## Examples

### Cancel Specific Operations

#### Cancel Data Processing Operation
```bash
# Cancel a running sampling operation
vodou-core cancel ml-server --operation sampling_abc123

# Cancel file processing operation
vodou-core cancel data-fs --operation file_proc_456

# Cancel analysis operation
vodou-core cancel analytics-server --operation analysis_def789
```

#### Cancel Different Operation Types
```bash
# Cancel network synchronization
vodou-core cancel sync-server --operation network_sync_123

# Cancel backup operation
vodou-core cancel backup-server --operation backup_xyz456

# Cancel maintenance task
vodou-core cancel maintenance-server --operation cleanup_789
```

### Find and Cancel Operations
```bash
# 1. Find running operations
vodou-core progress ml-server

# 2. Cancel specific operation from the list
vodou-core cancel ml-server --operation sampling_abc123
```

## Example Output

### Successful Cancellation
```bash
$ vodou-core cancel ml-server --operation sampling_abc123
🛑 Cancelling operation 'sampling_abc123' on server 'ml-server'...

📊 Operation Details:
  Operation ID: sampling_abc123
  Type: sampling
  Progress: 45.2% (interrupted)
  Status: Processing batch 9 of 20
  Duration: 3 minutes 45 seconds

⏳ Requesting graceful cancellation...
✅ Operation cancelled successfully

📋 Cancellation Summary:
  Server: ml-server
  Operation: sampling_abc123
  Cancelled at: 2025-01-12 14:25:30
  Reason: User requested cancellation
  Resources freed: 2.3GB memory, 1 CPU core

💡 Use 'vodou-core progress ml-server --all' to see cancelled operation in history
```

### Graceful Cancellation with Cleanup
```bash
$ vodou-core cancel data-processor --operation file_proc_789
🛑 Cancelling operation 'file_proc_789' on server 'data-processor'...

📊 Operation Details:
  Operation ID: file_proc_789
  Type: file_processing
  Progress: 67.8% (2,033 of 3,000 files processed)
  Status: Processing batch 21 of 30

⏳ Requesting graceful cancellation...
🧹 Server performing cleanup...
  - Closing open file handles
  - Saving processed file list
  - Freeing temporary storage

✅ Operation cancelled successfully with cleanup

📋 Results:
  Files processed: 2,033 of 3,000 (67.8% complete)
  Partial results saved to: /tmp/partial_processing_results
  Cleanup completed: All temporary files removed
  Time saved: Estimated 5 minutes remaining work cancelled
```

### Immediate Termination (Non-Responsive Operation)
```bash
$ vodou-core cancel stuck-server --operation stuck_operation_123
🛑 Cancelling operation 'stuck_operation_123' on server 'stuck-server'...

📊 Operation Details:
  Operation ID: stuck_operation_123
  Type: network
  Progress: 23.1% (stalled for 10 minutes)
  Status: Waiting for network response

⏳ Requesting graceful cancellation...
⚠️  Operation not responding to graceful cancellation request
🚨 Performing immediate termination...

✅ Operation forcibly terminated

⚠️  Warning: Immediate termination may have left partial results
📋 Cleanup recommended:
  - Check for temporary files in /tmp/
  - Verify network connections are closed
  - Review server logs for any issues

💡 Consider restarting the server if problems persist
```

### Already Completed Operation
```bash
$ vodou-core cancel ml-server --operation completed_operation_456
❌ Cannot cancel operation 'completed_operation_456': Operation already completed

📊 Operation Status:
  Operation ID: completed_operation_456
  Current Status: completed
  Completed at: 2025-01-12 14:15:30
  Final Progress: 100%

💡 Only running operations can be cancelled
💡 Use 'vodou-core progress ml-server --all' to see operation history
```

## Error Handling

### Server Not Found
```bash
$ vodou-core cancel nonexistent-server --operation some_op_123
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Operation Not Found
```bash
$ vodou-core cancel ml-server --operation invalid_operation_id
❌ Error: Operation 'invalid_operation_id' not found for server 'ml-server'
💡 Use 'vodou-core progress ml-server' to see active operations
💡 Check operation ID spelling
```

### Operation Not Running
```bash
$ vodou-core cancel data-server --operation old_operation_123
❌ Cannot cancel operation 'old_operation_123': Operation not running

📊 Operation Status:
  Current Status: failed
  Failed at: 2025-01-12 13:45:30
  Reason: Network timeout

💡 Only running operations can be cancelled
💡 Failed and completed operations cannot be cancelled
```

### Missing Operation ID
```bash
$ vodou-core cancel ml-server
❌ Error: Missing required option --operation
💡 Specify operation ID: --operation <operation-id>
💡 Use 'vodou-core progress ml-server' to find operation IDs
```

### Server Communication Error
```bash
$ vodou-core cancel ml-server --operation sampling_123
🛑 Cancelling operation 'sampling_123' on server 'ml-server'...

❌ Error: Unable to communicate with server 'ml-server'
💡 Server may be unresponsive or disconnected
💡 Try 'vodou-core reconnect ml-server' first
💡 Check server health with 'vodou-core health-check'
```

## Cancellation Types

### Graceful Cancellation (Preferred)
- **Clean shutdown** - Operation stops at safe checkpoint
- **Resource cleanup** - Temporary files and memory freed properly
- **Partial results** - Work completed so far is preserved
- **Status update** - Progress tracking updated with cancellation reason

### Immediate Termination (Last Resort)
- **Force stop** - Operation terminated immediately
- **Potential issues** - May leave temporary files or open connections
- **Use when** - Operation not responding to graceful cancellation
- **Cleanup needed** - Manual cleanup may be required

## Use Cases

### Long-Running Operations
```bash
# Cancel operation taking too long
vodou-core progress data-processor  # Shows 2+ hour operation
vodou-core cancel data-processor --operation slow_operation_123

# Cancel stuck network operation
vodou-core cancel api-server --operation network_sync_456
```

### Resource Management
```bash
# Cancel high-memory operation to free resources
vodou-core cancel ml-server --operation memory_intensive_789

# Cancel operation before starting higher-priority task
vodou-core cancel analytics-server --operation background_analysis_123
```

### Workflow Changes
```bash
# Cancel operation due to changed requirements
vodou-core cancel data-transformer --operation old_transform_456

# Cancel operation before system maintenance
vodou-core cancel backup-server --operation nightly_backup_789
```

### Error Recovery
```bash
# Cancel operation that's producing errors
vodou-core cancel file-processor --operation error_prone_123

# Cancel operation before restarting server
vodou-core cancel problematic-server --operation unstable_operation_456
vodou-core reconnect problematic-server
```

## Monitoring Cancellation Results

### Check Cancellation Status
```bash
# Verify operation was cancelled
vodou-core progress ml-server --operation sampling_abc123

# Review all cancelled operations
vodou-core progress ml-server --all | grep -A5 "CANCELLED"
```

### Cleanup After Cancellation
```bash
# Check for temporary files left by cancelled operation
vodou-core call-tool list_directory --args '{"path":"/tmp"}'

# Check server resource usage after cancellation
vodou-core call-tool get_memory_info
vodou-core call-tool get_cpu_info
```

## Best Practices

### When to Cancel Operations

#### Good Reasons to Cancel:
- **Operation taking much longer than expected** (> 2x estimated time)
- **System resources needed for higher priority task**
- **Operation producing errors or unexpected results**
- **Requirements changed, operation no longer needed**
- **System maintenance or shutdown required**

#### Consider Before Cancelling:
- **How much progress has been made** (may be close to completion)
- **Whether partial results will be preserved** (check operation type)
- **Impact on server stability** (some operations may affect server state)
- **Whether operation can be resumed** (some types support resume)

### Safe Cancellation Workflow
```bash
# 1. Check operation progress first
vodou-core progress server-name --operation operation-id

# 2. If cancellation is needed, cancel gracefully
vodou-core cancel server-name --operation operation-id

# 3. Verify cancellation completed
vodou-core progress server-name --operation operation-id

# 4. Check for cleanup needs
vodou-core progress server-name --all
```

### Batch Cancellation (when needed)
```bash
#!/bin/bash
# cancel-all-operations.sh - Cancel multiple operations

SERVER="overloaded-server"

# Get all running operations
OPERATIONS=$(vodou-core progress $SERVER | grep -E "^\[.*\]" | sed -n 's/\[\([^]]*\)\].*/\1/p')

for op in $OPERATIONS; do
    echo "Cancelling operation: $op"
    vodou-core cancel $SERVER --operation $op
    sleep 2  # Brief pause between cancellations
done

echo "All operations cancelled for $SERVER"
```

## Integration Examples

### Emergency Shutdown Procedure
```bash
#!/bin/bash
# emergency-shutdown.sh - Cancel all operations before shutdown

echo "=== Emergency Shutdown: Cancelling All Operations ==="

# List all servers with active operations
SERVERS=$(vodou-core list | awk '{print $2}')

for server in $SERVERS; do
    echo "Checking operations for $server..."
    
    # Get running operations
    OPERATIONS=$(vodou-core progress $server 2>/dev/null | grep -E "^\[.*\]" | sed -n 's/\[\([^]]*\)\].*/\1/p')
    
    for op in $OPERATIONS; do
        echo "  Cancelling $op on $server..."
        vodou-core cancel $server --operation $op
    done
done

echo "All operations cancelled. System ready for shutdown."
```

### Resource Management Script
```bash
#!/bin/bash
# free-resources.sh - Cancel operations to free system resources

TARGET_SERVER="resource-intensive-server"

echo "=== Freeing Resources on $TARGET_SERVER ==="

# Check current resource usage
vodou-core call-tool get_memory_info --args '{"server":"'$TARGET_SERVER'"}'

# Cancel non-critical operations
OPERATIONS=$(vodou-core progress $TARGET_SERVER | grep -E "background|maintenance|cleanup" | sed -n 's/\[\([^]]*\)\].*/\1/p')

for op in $OPERATIONS; do
    echo "Cancelling non-critical operation: $op"
    vodou-core cancel $TARGET_SERVER --operation $op
done

# Check resource usage after cancellation
echo "Resources after cancellation:"
vodou-core call-tool get_memory_info --args '{"server":"'$TARGET_SERVER'"}'
```

## Related Commands

- [`progress`](progress.md) - View operation progress before deciding to cancel
- [`clear-progress`](clear-progress.md) - Clean up cancelled operation entries
- [`reconnect`](reconnect.md) - Restart server if cancellation causes issues
- [`health-check`](health-check.md) - Check server health after cancellation

## See Also

- [Operation Management](../operations.md#cancellation) - How operation cancellation works
- [Resource Management](../../docs-DEV/performance.md#resource-cleanup) (internal) — resource cleanup after cancellation
- [Troubleshooting](../troubleshooting.md#cancellation-issues) - Cancellation problems and solutions