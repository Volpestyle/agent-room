#!/usr/bin/env node

const tools = [
  'agentroom.room_state',
  'agentroom.list_agents',
  'agentroom.list_tasks',
  'agentroom.post_message',
  'agentroom.claim_task',
  'agentroom.ask_human',
  'agentroom.create_handoff',
  'agentroom.request_approval'
];

console.log(
  JSON.stringify(
    {
      name: 'agentroom-mcp-server',
      status: 'scaffold',
      message: 'Install @modelcontextprotocol/sdk and implement stdio/HTTP transports here.',
      plannedTools: tools
    },
    null,
    2
  )
);
