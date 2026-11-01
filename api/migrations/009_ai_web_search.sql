-- Web search is an explicitly granted per-agent capability and is off by default.
INSERT INTO ai_agent_tool_grants(agent_id, tool_key, enabled)
SELECT id, 'web.search', false FROM ai_agents
ON CONFLICT (agent_id, tool_key) DO NOTHING;
