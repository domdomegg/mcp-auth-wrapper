#!/usr/bin/env node
/**
 * Minimal stdio MCP server for testing.
 * Reports its env vars as tools so we can verify per-user env injection.
 */
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {z} from 'zod';

const server = new McpServer({
	name: 'stub-stdio-server',
	version: '1.0.0',
});

server.registerTool('echo', {description: 'Echoes back the input', inputSchema: {message: z.string()}}, async ({message}) => ({
	content: [{type: 'text', text: message}],
}));

server.registerTool('get_env', {description: 'Returns the value of an environment variable', inputSchema: {name: z.string()}}, async ({name}) => ({
	content: [{type: 'text', text: process.env[name] ?? ''}],
}));

server.registerTool('whoami', {description: 'Returns TEST_USER env var'}, async () => ({
	content: [{type: 'text', text: process.env.TEST_USER ?? 'unknown'}],
}));

const transport = new StdioServerTransport();
void server.connect(transport);
