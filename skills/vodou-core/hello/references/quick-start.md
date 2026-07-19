# Quick Start Guide - Get Running in 5 Minutes

## Prerequisites

- macOS, Linux, or Windows (WSL)
- Terminal access
- Internet connection

## Step 1: Installation (2 minutes)

### Run Installation Script

```bash
./install.sh
```

**What it does:**
- Sets up files and permissions
- Creates required directories (`screenshots/`)
- Configures environment
- Removes macOS quarantine attributes
- Builds MCP server dependencies

**Expected output:**
```
🚀 Vodou Installation Script
=========================
📁 Installing to current directory: ...
✅ Installation complete!
```

**If you see errors:**
- Missing permissions: `chmod +x install.sh`
- Missing dependencies: Script will guide you

## Step 2: Configure Credentials (1 minute)

### Get Your Vodou OS Credentials

1. Visit: **https://app.vodou.ai**
2. Sign up or log in
3. Copy your `VODOU_TOKEN` and `VODOU_USER_ID`

### Configure .env File

**Edit the file:**
```bash
nano .env
```

**Add your Vodou OS credentials and API keys:**
```bash
# Vodou OS Credentials (REQUIRED)
VODOU_TOKEN=your_token_here
VODOU_USER_ID=your_user_id_here

# VODOU_PROJECT_PATH is auto-configured during installation
VODOU_PROJECT_PATH=/path/to/your/oi/directory

# Additional API Keys (Optional but recommended)
ANTHROPIC_API_KEY=your_anthropic_key_here     # For Claude AI
OPENAI_API_KEY=your_openai_key_here           # For GPT models
STACKOVERFLOW_API_KEY=your_key_here           # For StackOverflow MCP
```

**Note about VODOU_PROJECT_PATH:**
- This is set automatically during installation
- Screenshots and outputs will be saved to: `VODOU_PROJECT_PATH/screenshots/`
- Don't change unless you move the Vodou installation

**Save:**
- nano: `Ctrl+X`, then `Y`, then `Enter`
- Other editors: Save normally

## Step 3: Start Services (1 minute)

### Run Start Script

```bash
./start-vodou-services.sh
```

**What starts:**
- Docker Gateway (if using Docker servers)
- Browser Tools Server
- All MCP server connections

**Expected output:**
```
🚀 Starting Vodou Required Services...
✅ Docker Gateway started
✅ Browser Tools started
✅ All services running
```

**If services fail:**
- Check Docker is running (if needed)
- Verify `.env` credentials
- Review error messages

## Step 4: Your First Command (30 seconds)

### Get Started with Vodou Help Center

```bash
./do "hello"
```

**Expected result:**
```
Welcome to Vodou - Your Complete Help Center 🚀

What is Vodou?
Vodou is a revolutionary platform...

[Help center content with stopping points]
```

**If it works**: 🎉 **Congratulations! Vodou is working!** You now have access to the complete Vodou help center.

**If it doesn't work:**
- Check services: `./start-vodou-services.sh`
- Verify credentials in `.env`
- Check error messages

## Step 5: Test Parallel Execution (30 seconds)

### Experience Parallel Power

Run multiple commands simultaneously:

```bash
./do "cpu memory disk"
```

**What happens:**
- All three execute simultaneously
- Results in 3-4 seconds
- This is Vodou's superpower!

**Expected result:**
```
📋 **mcp-monitor::get_cpu_info** (1.2s)
📋 **mcp-monitor::get_memory_info** (1.3s)
📋 **mcp-monitor::get_disk_info** (1.4s)
```

## Next Steps

### Explore Vodou Help Center

```bash
./do "hello"              # Comprehensive Vodou guide and help center
```

### Explore Available Tools

```bash
./do list                 # List all MCP servers
```

**See:**
- All connected MCP servers
- Available tools
- System status

### Try More Commands

```bash
# System check
./do "cpu memory disk network"

# Get help and information (recommended first command)
./do "hello"

# Code analysis (if you have a codebase)
./do "analyze my codebase"
```

### Learn Advanced Techniques

```bash
./do "oi mastery"
```

## Common First-Time Issues

### "Command not found: ./do"
**Solution**: Make sure you're in the Vodou directory
```bash
pwd  # Should show Vodou directory
ls -la oi  # Should show the script
```

### "Failed to connect to server"
**Solution**: 
1. Check services: `./start-vodou-services.sh`
2. Verify `.env` credentials
3. Check Docker (if using Docker servers)

### "Timeout" errors
**Solution**: 
- Services may still be starting
- Wait 30 seconds and try again
- Check `./do list` to see server status

## Quick Reference

### Essential Commands

```bash
./do "cpu memory disk"        # System check
./do list                     # See available tools
./do "hello"                  # Help center
./do "oi mastery"            # Advanced guide
```

### Getting Help

```bash
./do "hello"                  # This help center
./do "oi mastery"            # Advanced techniques
./do list                     # Available tools
```

## What You've Accomplished

✅ Installed Vodou  
✅ Configured credentials  
✅ Started services  
✅ Ran your first command  
✅ Experienced parallel execution  

**You're ready to use Vodou!** 🚀

## Further Learning

1. **Read**: `what-is-oi.md` - Understand Vodou's architecture
2. **Read**: `mcp-servers-guide.md` - Learn about MCP servers
3. **Read**: `skills-guide.md` - Understand the skills system
4. **Try**: `./do "hello"` - Interactive help center

---

**Welcome to Vodou!** 🎉

