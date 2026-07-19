-- Migration 035: Route screenshot to OI-playwright-mcp only (for shared browser context tests).
-- Removes browser-tools-stdio screenshot intent so "take a screenshot" uses Playwright.

DELETE FROM intent_mappings WHERE server_name = 'browser-tools-stdio' AND tool_name = 'takeScreenshot';
