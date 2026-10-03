#!/usr/bin/env node
// Test MCP server (stdio): a read-only tool, a tool that changes something, and an image tool.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {appendFileSync} from 'node:fs';
import {z} from 'zod';

const server = new McpServer({name: 'test-mcp', version: '1.0.0'});
server.registerTool('add', {description: 'Add two numbers', inputSchema: {a: z.number(), b: z.number()}, annotations: {readOnlyHint: true}}, async ({a, b}) => ({content: [{type: 'text', text: String(a + b)}]}));
server.registerTool('remember', {description: 'Save a note to notes.log', inputSchema: {note: z.string()}}, async ({note}) => {
  appendFileSync(process.env.NOTES_FILE ?? 'notes.log', note + '\n');
  return {content: [{type: 'text', text: `saved: ${note}`}]};
});
server.registerTool('fail', {description: 'Always fails', inputSchema: {}, annotations: {readOnlyHint: true}}, async () => ({content: [{type: 'text', text: 'nope'}], isError: true}));
await server.connect(new StdioServerTransport());
