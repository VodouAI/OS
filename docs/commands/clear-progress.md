# clear-progress - Clean Up Progress Entries

Remove completed, failed, and cancelled operation progress entries from the tracking system.

## Syntax

```bash
vodou-core clear-progress <server-name>
```

## Description

The `clear-progress` command removes historical progress entries for completed operations, helping maintain a clean progress tracking system. This is useful for housekeeping and preventing the progress database from growing too large over time.

Clear-progress functionality:
- **Cleanup completed operations** - Remove successfully finished operations from history
- **Remove failed operations** - Clean up operations that failed or encountered errors
- **Clear cancelled operations** - Remove operations that were manually cancelled
- **Preserve running operations** - Keep active operations untouched
- **Database maintenance** - Reduce database size and improve performance

## Arguments

- `<server-name>` - Name of the server to clear progress entries for

## Examples

### Clear Progress for Specific Server
```bash
# Clean up progress entries for machine learning server
vodou-core clear-progress ml-server

# Clear filesystem server progress history
vodou-core clear-progress data-fs

# Clean up analytics server completed operations
vodou-core clear-progress analytics-server
```

### Regular Maintenance Workflow
```bash
# 1. Review what will be cleared
vodou-core progress my-server --all

# 2. Clear completed/failed operations
vodou-core clear-progress my-server

# 3. Verify active operations remain
vodou-core progress my-server
```

## Example Output

### Successful Cleanup
```bash
$ vodou-core clear-progress ml-server
🧹 Clearing progress entries for server 'ml-server'...

📊 Found progress entries:
  ✅ Completed operations: 15
  ❌ Failed operations: 3  
  🛑 Cancelled operations: 2
  🔄 Running operations: 1 (will be preserved)

⚠️  This will permanently remove 20 progress entries.
❓ Continue with cleanup? (y/N): y

🗑️  Removing completed operations...
  ✅ Removed: sampling_abc123 (completed 2 hours ago)
  ✅ Removed: analysis_def456 (completed 1 day ago)  
  ✅ Removed: backup_ghi789 (completed 3 days ago)
  ... (12 more completed operations)

🗑️  Removing failed operations...
  ❌ Removed: network_sync_123 (failed 6 hours ago)
  ❌ Removed: file_proc_456 (failed 2 days ago)
  ❌ Removed: analysis_789 (failed 1 week ago)

🗑️  Removing cancelled operations...
  🛑 Removed: slow_process_321 (cancelled 4 hours ago)
  🛑 Removed: background_task_654 (cancelled 1 day ago)

✅ Progress cleanup completed

📊 Summary:
  Entries removed: 20
  Active operations preserved: 1
  Database space freed: 2.3MB

💡 Running operations continue to be tracked normally
```

### Server with No Completed Operations
```bash
$ vodou-core clear-progress idle-server
🧹 Clearing progress entries for server 'idle-server'...

📊 Found progress entries:
  ✅ Completed operations: 0
  ❌ Failed operations: 0
  🛑 Cancelled operations: 0
  🔄 Running operations: 0

💡 No progress entries to clear for server 'idle-server'
📊 Progress tracking database is already clean
```

### Server with Only Running Operations
```bash
$ vodou-core clear-progress active-server
🧹 Clearing progress entries for server 'active-server'...

📊 Found progress entries:
  ✅ Completed operations: 0
  ❌ Failed operations: 0  
  🛑 Cancelled operations: 0
  🔄 Running operations: 3 (will be preserved)

💡 No completed progress entries to clear
📊 All 3 operations are still running and will be preserved

🔄 Active operations:
  [sampling_current_123] Data Sampling (45.2% complete)
  [analysis_running_456] Model Analysis (67.8% complete)
  [backup_active_789] Data Backup (23.1% complete)
```

### User Cancellation
```bash
$ vodou-core clear-progress important-server
🧹 Clearing progress entries for server 'important-server'...

📊 Found progress entries:
  ✅ Completed operations: 25
  ❌ Failed operations: 5
  🛑 Cancelled operations: 3
  🔄 Running operations: 2 (will be preserved)

⚠️  This will permanently remove 33 progress entries.
❓ Continue with cleanup? (y/N): n

❌ Progress cleanup cancelled - no entries removed
📊 All 35 progress entries preserved (33 historical + 2 active)

💡 Use 'vodou-core progress important-server --all' to review entries before clearing
```

## Safety Features

### Confirmation Required
- **Interactive confirmation** - User must confirm before cleanup
- **Entry count display** - Shows exactly what will be removed
- **Running operation protection** - Active operations are never removed
- **Cancellation support** - Users can abort cleanup with 'n' or Enter

### Selective Cleanup
- **Only historical entries** - Completed, failed, and cancelled operations
- **Active operation preservation** - Running operations always protected
- **Type-specific removal** - Clear completed but keep failed if desired (future enhancement)

### Non-Destructive Preview
```bash
# Preview what would be cleared without making changes
vodou-core progress server-name --all  # Shows all entries

# Count operations by status
vodou-core progress server-name --all | grep -E "(COMPLETED|FAILED|CANCELLED)" | wc -l

# Then decide whether to clear
vodou-core clear-progress server-name
```

## Error Handling

### Server Not Found
```bash
$ vodou-core clear-progress nonexistent-server
❌ Error: Server 'nonexistent-server' not found
💡 Use 'vodou-core list' to see available servers
💡 Check server name spelling
```

### Database Access Error
```bash
$ vodou-core clear-progress my-server
❌ Error: Unable to access progress tracking database
💡 Check database file permissions and try again
💡 Ensure no other instances of vodou-core are running
💡 Verify database file is not corrupted
```

### Concurrent Operation Conflict
```bash
$ vodou-core clear-progress busy-server
🧹 Clearing progress entries for server 'busy-server'...

⚠️  Warning: New operations started during cleanup
📊 Cleanup partially completed:
  Entries removed: 15 of 20
  New operations detected: 2

💡 Some entries may have been preserved due to concurrent activity
💡 Run clear-progress again to clean up remaining entries
```

## Use Cases

### Regular Maintenance
```bash
#!/bin/bash
# weekly-progress-cleanup.sh - Clean up progress entries weekly

SERVERS=$(vodou-core list | awk '{print $2}')

echo "=== Weekly Progress Cleanup ==="

for server in $SERVERS; do
    echo "Cleaning progress for $server..."
    vodou-core clear-progress $server
    echo
done

echo "Weekly progress cleanup completed"
```

### Before System Backup
```bash
# Clean up progress database before backup to reduce backup size
vodou-core clear-progress ml-server
vodou-core clear-progress data-processor  
vodou-core clear-progress analytics-server

# Then perform system backup
tar -czf vodou-core-backup.tar.gz ~/.vodou-core/
```

### Development Environment Reset
```bash
# Clean up development server progress after testing phase
vodou-core clear-progress dev-server
vodou-core clear-progress test-server

# Start fresh for new development cycle
vodou-core progress dev-server  # Should show no historical entries
```

### Troubleshooting Cleanup
```bash
# Clear progress entries for problematic server
vodou-core clear-progress problematic-server

# Restart server and monitor new operations
vodou-core reconnect problematic-server
vodou-core progress problematic-server
```

## Database Impact

### Storage Benefits
- **Reduced database size** - Remove historical data not needed for current operations
- **Improved performance** - Faster queries when fewer entries to search
- **Storage management** - Prevent unlimited database growth
- **Backup efficiency** - Smaller databases backup faster

### Query Performance
```bash
# Before cleanup: Large database with thousands of entries
vodou-core progress busy-server --all  # May be slow

# After cleanup: Only active operations remain
vodou-core clear-progress busy-server
vodou-core progress busy-server        # Faster response
```

## Automation and Scheduling

### Automated Cleanup Script
```bash
#!/bin/bash
# auto-cleanup-progress.sh - Automated progress cleanup

# Configuration
MAX_COMPLETED_OPERATIONS=50
CLEANUP_INTERVAL_DAYS=7

# Function to count completed operations
count_completed() {
    local server=$1
    vodou-core progress $server --all 2>/dev/null | grep -c "COMPLETED"
}

# Main cleanup logic
SERVERS=$(vodou-core list | awk '{print $2}')

for server in $SERVERS; do
    completed_count=$(count_completed $server)
    
    if [ $completed_count -gt $MAX_COMPLETED_OPERATIONS ]; then
        echo "Server $server has $completed_count completed operations (max: $MAX_COMPLETED_OPERATIONS)"
        echo "Running automated cleanup..."
        
        # Auto-confirm cleanup for automation
        echo "y" | vodou-core clear-progress $server
    fi
done
```

### Cron Job Integration
```bash
# Add to crontab for weekly cleanup:
# crontab -e
# Add line: 0 2 * * 0 /path/to/auto-cleanup-progress.sh

# Or monthly cleanup:
# 0 2 1 * * /path/to/auto-cleanup-progress.sh
```

## Best Practices

### When to Clear Progress

#### Good Times to Clear:
- **After project completion** - Clean up when project phase ends
- **Regular maintenance** - Weekly or monthly cleanup schedule
- **Before system backup** - Reduce backup size and duration
- **Database performance issues** - When queries become slow
- **Storage space concerns** - When database grows too large

#### Consider Before Clearing:
- **Audit requirements** - Some environments need operation history
- **Debugging needs** - Historical data may help troubleshoot issues
- **Active investigations** - Don't clear if analyzing past failures
- **Compliance logging** - Regulatory requirements may mandate retention

### Safe Cleanup Workflow
```bash
# 1. Review what will be cleared
vodou-core progress server-name --all

# 2. Export important history if needed
vodou-core progress server-name --all > server-history-backup.txt

# 3. Clear progress entries
vodou-core clear-progress server-name

# 4. Verify only active operations remain
vodou-core progress server-name
```

### Selective Cleanup (Manual)
```bash
# Instead of clearing all, selectively review and clear:

# Show only failed operations
vodou-core progress server-name --all | grep "FAILED"

# Show only old completed operations  
vodou-core progress server-name --all | grep "COMPLETED" | grep -E "days? ago"

# Then decide whether full cleanup is appropriate
vodou-core clear-progress server-name
```

## Related Commands

- [`progress`](progress.md) - View progress entries before clearing them
- [`cancel`](cancel.md) - Cancel operations that will become clearable entries
- [`approvals`](approvals.md) - Related cleanup for approval history
- [`health-check`](health-check.md) - Verify server health after cleanup

## See Also

- [Database Maintenance](../maintenance.md#progress-cleanup) - Database housekeeping procedures  
- [Performance Optimization](../../docs-DEV/performance.md#database-optimization) (internal) — database performance tuning
- [Troubleshooting](../troubleshooting.md#database-issues) - Database-related problems