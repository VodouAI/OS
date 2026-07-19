# Codex Integration Guide - Cursor & VS Code

Complete guide for using Vodou (Brain Trust 4) with Codex in Cursor or VS Code.

## 🎯 **Critical Requirement: Agent Mode**

**⚠️ IMPORTANT**: Vodou requires **Agent (Full Access)** mode to function properly. Without this mode, Vodou cannot execute commands or interact with MCP servers.

## 🚀 **Quick Setup**

### **Step 1: Enable Agent Mode**

#### **In Cursor:**
1. Open Cursor settings (⌘, or Ctrl+,)
2. Navigate to **Codex Settings** or **AI Settings**
3. Find **"Agent Mode"** or **"Full Access Mode"**
4. **Enable "Agent (Full Access)" mode**
5. Save settings

#### **In VS Code:**
1. Open VS Code settings (⌘, or Ctrl+,)
2. Search for **"Codex"** or **"AI Agent"**
3. Find **"Agent Mode"** or **"Full Access Mode"**
4. **Enable "Agent (Full Access)" mode**
5. Save settings

### **Step 2: Verify Vodou Installation**

```bash
# Check if Vodou is installed
./do --version

# Test Vodou functionality
./do "cpu memory disk"
```

### **Step 3: Test Integration**

Ask Codex to use Vodou:
```
"Use Vodou to check my system CPU, memory, and disk usage"
```

Codex should execute:
```bash
./do "cpu memory disk"
```

## 🔧 **Why Agent Mode is Required**

Vodou needs **full access** to:
- ✅ Execute terminal commands (`./do` and related commands)
- ✅ Read and write files (for MCP server configuration)
- ✅ Access system resources (CPU, memory, disk monitoring)
- ✅ Run MCP servers (process management)
- ✅ Connect to external services (HTTP MCP servers)

**Without Agent Mode:**
- ❌ Codex cannot execute `./do` commands
- ❌ Vodou tools cannot be called
- ❌ MCP servers cannot be started
- ❌ System monitoring fails

## 📋 **Common Use Cases**

### **System Monitoring**
```
"Use Vodou to check my system performance"
```
Codex executes: `./do "cpu memory disk"`

### **Code Analysis**
```
"Use Vodou to analyze my codebase"
```
Codex executes: `./do "analyze codebase"`

### **Server Management**
```
"Use Vodou to list all MCP servers"
```
Codex executes: `./do list`

### **Health Checks**
```
"Use Vodou to check server health"
```
Codex executes: `./do health-check`

## 🛠️ **Troubleshooting**

### **Issue: Vodou Commands Not Executing**

**Symptoms:**
- Codex says it's executing Vodou but nothing happens
- Error messages about permissions or access

**Solution:**
1. **Verify Agent Mode is enabled** (see Step 1 above)
2. Check Vodou installation:
   ```bash
   ./do --version
   ```
3. Test Vodou manually:
   ```bash
   ./do "cpu"
   ```
4. Check file permissions:
   ```bash
   chmod +x ./do
   ls -la ./do
   ```

### **Issue: "Command Not Found" Errors**

**Symptoms:**
- `./do: command not found`
- `bash: ./do: No such file or directory`

**Solution:**
1. Navigate to Vodou directory:
   ```bash
   cd /path/to/vodou-core
   ```
2. Verify the **`do`** launcher exists:
   ```bash
   ls -la ./do
   ```
3. Make executable:
   ```bash
   chmod +x ./do
   ```

### **Issue: Permission Denied**

**Symptoms:**
- `Permission denied` errors
- Cannot execute `./do`

**Solution:**
```bash
# Make Vodou executable
chmod +x ./do

# Make binary executable
chmod +x vodou-core
chmod +x target/release/vodou-core
```

### **Issue: MCP Servers Not Starting**

**Symptoms:**
- Vodou runs but MCP servers fail
- Connection errors

**Solution:**
1. Check server status:
   ```bash
   ./do list
   ./do health-check
   ```
2. Verify services are running:
   ```bash
   ./start-vodou-services.sh
   ```
3. Check Docker (if using Docker servers):
   ```bash
   docker ps
   ```

## 💡 **Best Practices**

### **1. Always Use Agent Mode**
- **Never disable Agent Mode** when using Vodou
- Agent Mode is required for Vodou functionality
- Without it, Vodou cannot execute commands

### **2. Use Natural Language Queries**
Instead of:
```
"Execute: ./do cpu"
```

Use:
```
"Use Vodou to check my CPU usage"
```

Codex will automatically format the command correctly.

### **3. Combine Multiple Queries**
```
"Use Vodou to check CPU, memory, and disk, then analyze my codebase"
```

Codex can execute:
```bash
./do "cpu memory disk analyze codebase"
```

### **4. Verify Before Complex Operations**
For important operations, ask Codex to verify:
```
"Use Vodou to list all servers, then show me the health status"
```

## 🔍 **Verification Checklist**

Before using Vodou with Codex, verify:

- [ ] **Agent (Full Access) mode is enabled** in Cursor/VS Code
- [ ] Vodou is installed and accessible (`./do --version` works)
- [ ] **`do`** launcher is executable (`chmod +x do`; shipped **`vodou`** / other copies match **`do`**)
- [ ] Vodou services are running (`./start-vodou-services.sh`)
- [ ] Test query works: `./do "cpu"`
- [ ] Codex can execute Vodou commands successfully

## 📚 **Additional Resources**

- **[Setup Guide](setup.md)** - Complete Vodou installation instructions
- **[CLI Reference](cli-reference.md)** - All available Vodou commands
- **[Troubleshooting](troubleshooting.md)** - Comprehensive troubleshooting guide
- **[Examples](examples.md)** - Real-world usage examples

## 🎯 **Quick Reference**

| Task | Vodou Command | Codex Prompt |
|------|-----------|--------------|
| System monitoring | `./do "cpu memory disk"` | "Use Vodou to check system performance" |
| Code analysis | `./do "analyze codebase"` | "Use Vodou to analyze my code" |
| List servers | `./do list` | "Use Vodou to list all MCP servers" |
| Health check | `./do health-check` | "Use Vodou to check server health" |
| Install server | `./do install server-name` | "Use Vodou to install [server-name]" |

---

**⚠️ Remember**: Always enable **Agent (Full Access) mode** in Cursor or VS Code for Vodou to work properly!

