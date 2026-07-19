-- Migration 036: Route screenshot (and related) intents to browser-tools-mcp (server: browser-tools-stdio, tool: takeScreenshot).
-- Removes OI-playwright-mcp screenshot/navigate intents so "screenshot" uses browser-tools-mcp.

DELETE FROM intent_mappings WHERE server_name = 'OI-playwright-mcp' AND tool_name IN ('browser_take_screenshot', 'browser_navigate');

INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('screenshot', 'browser-tools-stdio', 'takeScreenshot', 10),
  ('take screenshot', 'browser-tools-stdio', 'takeScreenshot', 10),
  ('take a screenshot', 'browser-tools-stdio', 'takeScreenshot', 10),
  ('browser screenshot', 'browser-tools-stdio', 'takeScreenshot', 10);
