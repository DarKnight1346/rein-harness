#!/usr/bin/env node
// Stand-in for `claude -p --input-format stream-json`: answers each user message with "ok" over
// two API calls, reporting token usage like the real CLI (stream_event message_start/delta).
import {createInterface} from 'node:readline';

const out = (o) => process.stdout.write(JSON.stringify(o) + '\n');
out({type: 'system', subtype: 'init', session_id: 'fake-session'});
const usage = (input, cached, output) => ({input_tokens: input, cache_read_input_tokens: cached, cache_creation_input_tokens: 0, output_tokens: output});
for await (const line of createInterface({input: process.stdin})) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    continue;
  }
  if (msg.type !== 'user') continue;
  out({type: 'stream_event', event: {type: 'message_start', message: {usage: usage(1000, 4000, 0)}}});
  out({type: 'stream_event', event: {type: 'message_delta', usage: {output_tokens: 50}}});
  out({type: 'stream_event', event: {type: 'message_start', message: {usage: usage(200, 5000, 0)}}});
  out({type: 'stream_event', event: {type: 'content_block_start', content_block: {type: 'text'}}});
  out({type: 'stream_event', event: {type: 'content_block_delta', delta: {type: 'text_delta', text: 'ok'}}});
  out({type: 'stream_event', event: {type: 'message_delta', usage: {output_tokens: 30}}});
  out({type: 'result', subtype: 'success', result: 'ok', usage: usage(1200, 9000, 80)});
}
