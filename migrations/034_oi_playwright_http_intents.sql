-- Migration 034: OI-playwright-mcp intents (browser_take_screenshot, browser_navigate)
-- Use with persistent HTTP server (--port 8931 --shared-browser-context) for shared tab context.
-- Route screenshot/navigate to Playwright so navigate+screenshot share the same browser context.

DELETE FROM intent_mappings WHERE server_name = 'browser-tools-stdio' AND tool_name = 'takeScreenshot';

INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('screenshot', 'OI-playwright-mcp', 'browser_take_screenshot', 10),
  ('take screenshot', 'OI-playwright-mcp', 'browser_take_screenshot', 10),
  ('take a screenshot', 'OI-playwright-mcp', 'browser_take_screenshot', 10),
  ('playwright screenshot', 'OI-playwright-mcp', 'browser_take_screenshot', 10),
  ('browser screenshot', 'OI-playwright-mcp', 'browser_take_screenshot', 10),
  ('navigate', 'OI-playwright-mcp', 'browser_navigate', 10),
  ('browser navigate', 'OI-playwright-mcp', 'browser_navigate', 10),
  ('playwright', 'OI-playwright-mcp', 'browser_navigate', 9);
