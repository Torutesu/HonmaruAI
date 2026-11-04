export const MCP_SCOPE_INFO = [
  { name: 'chat:read', title: 'Read public conversations', description: 'Search and read public channels and their message history.' },
  { name: 'chat:write', title: 'Send messages', description: 'Send messages and thread replies as you.' },
  { name: 'chat:schedule', title: 'Schedule messages', description: 'Schedule messages as you while this connection remains authorized.' },
  { name: 'chat:private', title: 'Access private channels', description: 'Include private channels you can currently access in granted operations.' },
  { name: 'chat:dm', title: 'Access direct messages', description: 'Include your direct and group messages in granted operations.' },
  { name: 'reactions:write', title: 'Change reactions', description: 'Add and remove your reactions on accessible messages.' },
  { name: 'channels:write', title: 'Create conversations', description: 'Create channels and conversations as you.' },
  { name: 'users:read', title: 'Read people and emoji', description: 'Read workspace member profiles and custom emoji.' },
  { name: 'files:read', title: 'Read files', description: 'Read files you can access.' },
  { name: 'files:write', title: 'Upload files', description: 'Upload and update files in accessible conversations.' },
  { name: 'canvases:read', title: 'Read canvases', description: 'Read shared canvases in accessible conversations.' },
  { name: 'canvases:write', title: 'Update canvases', description: 'Create or update shared canvases in accessible conversations.' },
  { name: 'lists:read', title: 'Read lists', description: 'Read accessible Harness tables and their records.' },
  { name: 'lists:write', title: 'Update lists', description: 'Create and update accessible Harness tables and records.' },
];
export const MCP_CONNECTOR_SCOPES = MCP_SCOPE_INFO.map(scope => scope.name);
export const MCP_ALL_SCOPES = ['read', 'write', 'execute', 'audit:read', ...MCP_CONNECTOR_SCOPES];
