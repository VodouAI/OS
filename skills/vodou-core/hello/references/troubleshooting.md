# Troubleshooting Guide - Solve Common Problems

## Quick Diagnosis

### Check System Status

```bash
# Check all servers
./do list

# Check specific server
./do "status mcp-monitor"

# Health check
./do "health-check"
```

### Check Services

```bash
# Check if services are running
ps aux | grep -i "docker-gateway"
ps aux | grep -i "browser-tools"

# Check service logs
tail -f /tmp/docker-gateway.log
tail -f /tmp/browser-tools.log
```

## Common Problems

### Problem: "Command not found: ./do"

**Symptoms:**
- Terminal says command not found
- Script doesn't execute

**Solutions:**

1. **Check you're in the right directory:**
   ```bash
   pwd
   # Should show Vodou installation directory
   ```

2. **Check script exists:**
   ```bash
   ls -la oi
   # Should show the script
   ```

3. **Make script executable:**
   ```bash
   chmod +x oi
   ```

4. **Use full path:**
   ```bash
   /full/path/to/oi "cpu"
   ```

### Problem: "Failed to connect to server"

**Symptoms:**
- Connection errors
- Servers show as "unhealthy"
- Tools not available

**Solutions:**

1. **Check services are running:**
   ```bash
   ./start-vodou-services.sh
   ```

2. **Verify credentials:**
   ```bash
   cat .env
   # Should show VODOU_TOKEN and VODOU_USER_ID
   ```

3. **Check Docker (if using Docker servers):**
   ```bash
   docker ps
   # Docker should be running
   ```

4. **Restart services:**
   ```bash
   ./start-vodou-services.sh
   ```

5. **Check server health:**
   ```bash
   ./do "health-check"
   ```

### Problem: "Timeout" errors

**Symptoms:**
- Commands timeout
- Long delays
- No response

**Solutions:**

1. **Check system resources:**
   ```bash
   ./do "cpu memory disk"
   # Check if system is overloaded
   ```

2. **Use background execution:**
   ```bash
   ./do "background long-task"
   ```

3. **Break into smaller parts:**
   ```bash
   # Instead of:
   ./do "analyze everything"
   
   # Try:
   ./do "analyze code"
   ./do "analyze tests"
   ```

4. **Check server logs:**
   ```bash
   tail -f /tmp/*.log
   ```

### Problem: "No such tool" or "Intent not found"

**Symptoms:**
- Tool not found
- Intent not recognized
- Command doesn't work

**Solutions:**

1. **List available tools:**
   ```bash
   ./do list
   ./do "all-tools"
   ```

2. **Check if server is connected:**
   ```bash
   ./do list
   # Verify server shows as "healthy"
   ```

3. **Install missing server:**
   ```bash
   ./do "install mcp server"
   ```

4. **Check intent mappings:**
   ```bash
   ./do "intent list"
   ```

5. **Use direct tool call:**
   ```bash
   ./vodou-core call server-name tool-name
   ```

### Problem: Services won't start

**Symptoms:**
- Start script fails
- Services don't initialize
- Errors during startup

**Solutions:**

1. **Check dependencies:**
   ```bash
   node --version    # Should be v18+
   python3 --version # Should be 3.10+
   docker --version  # If using Docker
   ```

2. **Check port conflicts:**
   ```bash
   lsof -i :8080  # Check if port in use
   ```

3. **Check permissions:**
   ```bash
   ls -la *.sh
   chmod +x *.sh
   ```

4. **Check logs:**
   ```bash
   cat /tmp/docker-gateway.log
   cat /tmp/browser-tools.log
   ```

5. **Reinstall dependencies:**
   ```bash
   ./install.sh
   ```

### Problem: "Permission denied"

**Symptoms:**
- Can't execute scripts
- Permission errors
- Access denied

**Solutions:**

1. **Make scripts executable:**
   ```bash
   chmod +x *.sh
   chmod +x oi
   chmod +x vodou-core
   ```

2. **Check macOS quarantine:**
   ```bash
   xattr -d com.apple.quarantine vodou-core
   xattr -d com.apple.quarantine oi
   ```

3. **Check file ownership:**
   ```bash
   ls -la
   # Files should be owned by you
   ```

### Problem: "Database locked" or database errors

**Symptoms:**
- Database errors
- Lock errors
- Can't access database

**Solutions:**

1. **Check if Vodou is running:**
   ```bash
   ps aux | grep vodou-core
   ```

2. **Close other Vodou instances:**
   ```bash
   pkill vodou-core
   ```

3. **Check database file:**
   ```bash
   ls -la vodou-core.db
   # Should exist and be readable
   ```

4. **Backup and recreate (if needed):**
   ```bash
   cp vodou-core.db vodou-core.db.backup
   # Then restart services
   ```

### Problem: Slow performance

**Symptoms:**
- Commands take too long
- System is slow
- Timeouts

**Solutions:**

1. **Check system resources:**
   ```bash
   ./do "cpu memory disk"
   ```

2. **Use parallel execution:**
   ```bash
   # Instead of sequential:
   ./do "cpu"
   ./do "memory"
   ./do "disk"
   
   # Use parallel:
   ./do "cpu memory disk"
   ```

3. **Check server health:**
   ```bash
   ./do "health-check"
   ```

4. **Restart services:**
   ```bash
   ./start-vodou-services.sh
   ```

## Advanced Troubleshooting

### Debug Mode

**Enable verbose output:**
```bash
./do -v "your command"
```

**Check detailed logs:**
```bash
RUST_LOG=debug ./vodou-core brain "your command"
```

### Database Inspection

**Check intent mappings:**
```bash
sqlite3 vodou-core.db "SELECT * FROM intent_mappings;"
```

**Check server status:**
```bash
sqlite3 vodou-core.db "SELECT name, health_status FROM mcp_servers;"
```

**Check work logs:**
```bash
sqlite3 vodou-core.db "SELECT * FROM work_logs ORDER BY timestamp DESC LIMIT 10;"
```

### Network Issues

**Check connectivity:**
```bash
ping app.vodou.ai
curl https://app.vodou.ai
```

**Check firewall:**
```bash
# macOS
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --getglobalstate

# Linux
sudo ufw status
```

### Dependency Issues

**Check Node.js:**
```bash
node --version
npm --version
```

**Check Python:**
```bash
python3 --version
pip3 --version
```

**Check Go (if needed):**
```bash
go version
```

**Check Docker:**
```bash
docker --version
docker ps
```

## Getting Help

### Self-Service Resources

1. **Help Center:**
   ```bash
   ./do "hello"
   ```

2. **Advanced Guide:**
   ```bash
   ./do "oi mastery"
   ```

3. **Documentation:**
   - `docs/` directory
   - `README.md`
   - Reference guides

### Still Stuck?

1. **Check error messages carefully**
2. **Review logs in `/tmp/`**
3. **Try breaking tasks into smaller parts**
4. **Check system resources**
5. **Restart services**

## Prevention

### Best Practices

1. **Keep services running:**
   ```bash
   ./start-vodou-services.sh
   ```

2. **Monitor health:**
   ```bash
   ./do "health-check"
   ```

3. **Update regularly:**
   - Check for Vodou updates
   - Update MCP servers
   - Update dependencies

4. **Backup database:**
   ```bash
   cp vodou-core.db vodou-core.db.backup
   ```

5. **Monitor system resources:**
   ```bash
   ./do "cpu memory disk"
   ```

---

**Most problems can be solved by restarting services!** 🔄

