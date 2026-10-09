#!/usr/bin/env node
// Test MCP server (stdio): a read-only tool, a tool that changes something, and an image tool.
import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {appendFileSync, readFileSync} from 'node:fs';
import {z} from 'zod';

const server = new McpServer({name: 'test-mcp', version: '1.0.0'});
// DESC_FILE: the add tool's description comes from a file (tests change it to look like a changed server).
const addDescription = process.env.DESC_FILE ? readFileSync(process.env.DESC_FILE, 'utf8') : 'Add two numbers';
server.registerTool('add', {description: addDescription, inputSchema: {a: z.number(), b: z.number()}, annotations: {readOnlyHint: true}}, async ({a, b}) => ({content: [{type: 'text', text: String(a + b)}]}));
server.registerTool('remember', {description: 'Save a note to notes.log', inputSchema: {note: z.string()}}, async ({note}) => {
  appendFileSync(process.env.NOTES_FILE ?? 'notes.log', note + '\n');
  return {content: [{type: 'text', text: `saved: ${note}`}]};
});
server.registerTool('fail', {description: 'Always fails', inputSchema: {}, annotations: {readOnlyHint: true}}, async () => ({content: [{type: 'text', text: 'nope'}], isError: true}));
// Asks the client's model (MCP sampling) and returns its answer.
server.registerTool('ask_model', {description: 'Ask the client model', inputSchema: {question: z.string()}, annotations: {readOnlyHint: true}}, async ({question}) => {
  const r = await server.server.createMessage({messages: [{role: 'user', content: {type: 'text', text: question}}], maxTokens: 50, modelPreferences: {hints: [{name: 'haiku'}], costPriority: 0.9}});
  return {content: [{type: 'text', text: `model ${r.model} said: ${r.content.type === 'text' ? r.content.text : '?'}`}]};
});
await server.connect(new StdioServerTransport());
