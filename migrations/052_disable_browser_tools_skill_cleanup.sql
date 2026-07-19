-- Migration 052: Disable oi-browser-tools skill, clean up broad keyword routing
-- Date: 2026-03-24
-- Reason: oi-qa-testing skill now handles QA via vodou-mac-control + browser-tools-stdio hybrid.
--         Broad keywords like "audit", "console", "errors", "logs" were hijacking unrelated queries.
--         browser-tools-stdio is now only reachable via explicit audit keywords.

-- Remove all oi-browser-tools skill loader mappings
DELETE FROM intent_mappings WHERE server_name = 'brain-trust4' AND tool_parameters LIKE '%oi-browser-tools%';

-- Remove broad/ambiguous keywords that were routing to browser-tools-stdio
DELETE FROM intent_mappings WHERE server_name = 'browser-tools-stdio' AND keyword IN (
  'audit', 'console', 'errors', 'logs', 'optimize', 'quality',
  'clean', 'clear', 'debugger', 'element', 'reset', 'select',
  'speed', 'standards', 'traffic', 'requests', 'framework'
);

-- Keep only explicit audit keywords for browser-tools-stdio
INSERT OR IGNORE INTO intent_mappings (keyword, server_name, tool_name, execution_type, priority, tool_parameters) VALUES
  ('lighthouse audit', 'browser-tools-stdio', 'runPerformanceAudit', 'mcp', 10, '{}'),
  ('lighthouse', 'browser-tools-stdio', 'runPerformanceAudit', 'mcp', 8, '{}'),
  ('seo audit', 'browser-tools-stdio', 'runSEOAudit', 'mcp', 10, '{}'),
  ('accessibility audit', 'browser-tools-stdio', 'runAccessibilityAudit', 'mcp', 10, '{}'),
  ('best practices audit', 'browser-tools-stdio', 'runBestPracticesAudit', 'mcp', 10, '{}'),
  ('performance audit', 'browser-tools-stdio', 'runPerformanceAudit', 'mcp', 10, '{}'),
  ('wcag audit', 'browser-tools-stdio', 'runAccessibilityAudit', 'mcp', 10, '{}');
