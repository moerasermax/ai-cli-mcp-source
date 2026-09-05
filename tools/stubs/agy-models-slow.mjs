#!/usr/bin/env node
/** 只列錄下的模型輸出，不連 vendor。預設慢 2 秒，trace 用來證明逾時真的殺掉程序。 */
import { appendFileSync } from 'node:fs';
const trace = (event) => {
  if (process.env.AGY_STUB_TRACE_PATH) {
    appendFileSync(process.env.AGY_STUB_TRACE_PATH,
      `${JSON.stringify({ event, pid: process.pid, args: process.argv.slice(2) })}\n`);
  }
};
trace('started');
setTimeout(() => {
  trace('completed');
  console.log('Fetching available models...');
  if (process.env.AGY_STUB_EMPTY !== 'true') {
    console.log('gemini-3.7-flash-high\tGemini 3.7 Flash (High)');
    console.log('gemini-3.1-pro-high\tGemini 3.1 Pro (High)');
    console.log('claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)');
    console.log('gpt-oss-120b-medium\tGPT-OSS 120B (Medium)');
  }
}, Number(process.env.AGY_STUB_DELAY_MS ?? 2000));
