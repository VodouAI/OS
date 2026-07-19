-- Browser session creation
INSERT OR IGNORE INTO intent_mappings 
  (keyword, server_name, tool_name, requires_session, session_timeout, priority)
VALUES 
  ('open browser', 'Vodou-session-manager', 'create_session', 1, 3600, 10),
  ('start browser', 'Vodou-session-manager', 'create_session', 1, 3600, 10),
  ('browser session', 'Vodou-session-manager', 'create_session', 1, 3600, 10);

-- Browser tool calls (with session)
INSERT OR IGNORE INTO intent_mappings 
  (keyword, server_name, tool_name, requires_session, priority)
VALUES 
  ('navigate', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('go to', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('click', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('type', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('screenshot', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('take screenshot', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('snapshot', 'Vodou-session-manager', 'call_with_session', 1, 10),
  ('wait for', 'Vodou-session-manager', 'call_with_session', 1, 10);

-- Session management
INSERT OR IGNORE INTO intent_mappings 
  (keyword, server_name, tool_name, priority)
VALUES 
  ('list sessions', 'Vodou-session-manager', 'list_sessions', 10),
  ('close session', 'Vodou-session-manager', 'close_session', 10),
  ('session status', 'Vodou-session-manager', 'session_status', 10);

