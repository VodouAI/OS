-- Fix broken chrome-devtools intent → tool mappings (tools must exist on server).
UPDATE intent_mappings SET tool_name = 'list_console_messages'
 WHERE server_name = 'chrome-devtools' AND keyword = 'page console';

UPDATE intent_mappings SET tool_name = 'list_network_requests'
 WHERE server_name = 'chrome-devtools' AND keyword = 'browser network';

UPDATE intent_mappings SET tool_name = 'performance_start_trace'
 WHERE server_name = 'chrome-devtools' AND keyword = 'browser performance';

-- Natural phrases → real MCP tool names (keyword is PRIMARY KEY).
INSERT OR REPLACE INTO intent_mappings (keyword, server_name, tool_name, priority) VALUES
  ('new tab', 'chrome-devtools', 'new_page', 10),
  ('open new tab', 'chrome-devtools', 'new_page', 10),
  ('list pages', 'chrome-devtools', 'list_pages', 10),
  ('list tabs', 'chrome-devtools', 'list_pages', 10),
  ('select page', 'chrome-devtools', 'select_page', 10),
  ('select tab', 'chrome-devtools', 'select_page', 10),
  ('close tab', 'chrome-devtools', 'close_page', 10),
  ('close page', 'chrome-devtools', 'close_page', 10),
  ('console messages', 'chrome-devtools', 'list_console_messages', 10),
  ('browser console', 'chrome-devtools', 'list_console_messages', 10),
  ('network requests', 'chrome-devtools', 'list_network_requests', 10),
  ('emulate mobile', 'chrome-devtools', 'emulate', 10),
  ('resize window', 'chrome-devtools', 'resize_page', 10),
  ('upload file', 'chrome-devtools', 'upload_file', 10);
