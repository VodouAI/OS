# Browser Extension Installation Guide

Complete guide for installing the browser extension required for the pre-installed `browser-tools-mcp` server.

## 🎯 **Overview**

The `browser-tools-mcp` server (pre-installed with Vodou) requires a Chrome browser extension to function. The extension enables browser automation, screenshot capture, console log monitoring, and network request tracking.

## 📦 **Extension Location**

The browser extension is included with Vodou and located at:
```
MCP-servers/browser-tools-mcp/chrome-extension/
```

A pre-packaged extension ZIP file is available:
```
MCP-servers/browser-tools-mcp/chrome-extension/oi-os-extension.zip
```

## 🚀 **Installation Steps**

### **Step 1: Locate the Extension**

The extension is included in your Vodou installation. Navigate to:
```bash
cd MCP-servers/browser-tools-mcp/chrome-extension
```

Or use the pre-packaged ZIP file:
```bash
# Extract the extension
unzip oi-os-extension.zip -d ~/Downloads/oi-os-extension
```

### **Step 2: Install in Chrome**

1. **Open Chrome Extensions Page**
   - Open Google Chrome
   - Navigate to `chrome://extensions/`
   - Or: Menu (⋮) → Extensions → Manage Extensions

2. **Enable Developer Mode**
   - Toggle the "Developer mode" switch in the top-right corner
   - This enables loading unpacked extensions

3. **Load the Extension**
   - Click "Load unpacked" button
   - Select the `chrome-extension` folder:
     ```
     /path/to/OIv0.5/MCP-servers/browser-tools-mcp/chrome-extension
     ```
   - Or select the extracted folder if using the ZIP file

4. **Verify Installation**
   - The extension should appear in your extensions list
   - Name: "OI-OS - Browser Tools"
   - Version: 0.6.0

### **Step 3: Pin the Extension (Optional but Recommended)**

1. Click the puzzle icon (🧩) in Chrome's toolbar
2. Find "OI-OS - Browser Tools"
3. Click the pin icon (📌) to keep it visible

### **Step 4: Verify Browser Tools Server is Running**

The browser extension requires the browser-tools-server to be running. Vodou automatically starts this service, but you can verify:

```bash
# Check if browser-tools-server is running
ps aux | grep browser-connector

# Or check the service status
./start-vodou-services.sh
```

Expected output:
```
✅ Browser Tools: Running
```

## 🔧 **Configuration**

### **Access DevTools Panel**

1. Open Chrome DevTools (F12 or Right-click → Inspect)
2. Navigate to the "BrowserToolsMCP" tab in DevTools
3. The panel should show connection status

### **Extension Features**

Once installed, the extension provides:
- ✅ **Console Log Capture** - Monitors console.log, console.error, etc.
- ✅ **Network Monitoring** - Tracks XHR requests and responses
- ✅ **Screenshot Capture** - Takes screenshots on demand
- ✅ **Element Selection** - Tracks selected DOM elements
- ✅ **Auto-Paste to Cursor** - Automatically pastes screenshots into Cursor (optional)

### **Enable Auto-Paste (Optional)**

1. Open Chrome DevTools (F12)
2. Navigate to "BrowserToolsMCP" tab
3. Enable "Allow Auto-Paste into Cursor"
4. Make sure to focus/click into the Agent input field in Cursor for auto-paste to work

## ✅ **Verification**

### **Test the Installation**

1. **Start Vodou Services** (if not already running):
   ```bash
   ./start-vodou-services.sh
   ```

2. **Open a Web Page** in Chrome

3. **Open DevTools** (F12) and navigate to "BrowserToolsMCP" tab

4. **Check Connection Status**:
   - Should display "Connected to server"
   - If not connected, check that browser-tools-server is running

5. **Test with Vodou**:
   ```bash
   # Take a screenshot
   ./do "take a screenshot"
   
   # Get console errors
   ./do "what are the console errors"
   
   # Run accessibility audit
   ./do "run accessibility audit"
   ```

## 🐛 **Troubleshooting**

### **Extension Not Loading**

**Issue**: Extension doesn't appear after loading

**Solutions**:
1. Check that you selected the correct folder (should contain `manifest.json`)
2. Verify Developer Mode is enabled
3. Check Chrome's error console for extension errors
4. Try reloading the extension (click the refresh icon on the extension card)

### **Extension Not Connecting**

**Issue**: DevTools panel shows "Not connected"

**Solutions**:
1. **Verify browser-tools-server is running**:
   ```bash
   ps aux | grep browser-connector
   ```
   If not running:
   ```bash
   ./start-vodou-services.sh
   ```

2. **Restart Chrome completely**:
   - Quit Chrome entirely (not just close windows)
   - Restart Chrome
   - Open DevTools → BrowserToolsMCP panel

3. **Check for multiple DevTools panels**:
   - Close all DevTools windows
   - Open only ONE DevTools panel
   - Navigate to BrowserToolsMCP tab

4. **Restart browser-tools-server**:
   ```bash
   # Stop the server
   pkill -f browser-connector
   
   # Restart services
   ./start-vodou-services.sh
   ```

### **Screenshots Not Working**

**Issue**: Screenshot commands fail

**Solutions**:
1. Verify extension is installed and enabled
2. Check that browser-tools-server is running
3. Ensure you have an active tab open in Chrome
4. Check DevTools → BrowserToolsMCP panel for connection status

### **Console Logs Not Capturing**

**Issue**: Console logs aren't being captured

**Solutions**:
1. Refresh the page after installing the extension
2. Check that extension has necessary permissions
3. Verify browser-tools-server is running and connected
4. Check DevTools → BrowserToolsMCP panel

## 🔄 **Updating the Extension**

If you update Vodou and the extension changes:

1. **Remove Old Extension**:
   - Go to `chrome://extensions/`
   - Find "OI-OS - Browser Tools"
   - Click "Remove"

2. **Install Updated Extension**:
   - Follow installation steps above
   - Load the updated extension folder

## 📚 **Additional Resources**

- **Browser Tools MCP Documentation**: [browsertools.agentdesk.ai](https://browsertools.agentdesk.ai/)
- **GitHub Repository**: [AgentDeskAI/browser-tools-mcp](https://github.com/AgentDeskAI/browser-tools-mcp)
- **Extension Features**: See [Browser Tools README](../MCP-servers/browser-tools-mcp/README.md)

## 🎯 **Quick Reference**

| Task | Command/Step |
|------|-------------|
| Install Extension | Load unpacked from `chrome-extension/` folder |
| Verify Server Running | `ps aux \| grep browser-connector` |
| Start Services | `./start-vodou-services.sh` |
| Test Screenshot | `./do "take a screenshot"` |
| Check Connection | Open DevTools → BrowserToolsMCP tab |
| Restart Server | `pkill -f browser-connector && ./start-vodou-services.sh` |

## ⚠️ **Important Notes**

1. **Chrome Only**: This extension currently works with Chrome/Chromium browsers only
2. **Server Required**: The extension requires `browser-tools-server` to be running
3. **Single Instance**: Only one DevTools panel should be open at a time
4. **Auto-Start**: Vodou automatically starts the browser-tools-server via `start-vodou-services.sh`

---

**Status**: ✅ **Ready to Use** | **Extension Version**: 0.6.0 | **Compatibility**: Chrome/Chromium

