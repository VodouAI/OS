-- So "cpu memory disk" returns all three intents at same priority and run in parallel.
UPDATE intent_mappings SET priority = 90
WHERE server_name = 'mcp-monitor' AND tool_name IN ('get_cpu_info', 'get_disk_info');
