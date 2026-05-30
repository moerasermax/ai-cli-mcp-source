// 端對端：透過新 server 實跑 claude(pipe) + codex(stdin) + agy(ConPTY)，wait 拿結果。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const logs = [];
const log = (...a) => logs.push(a.join(' '));
process.on('exit', () => writeFileSync('e2e-out.txt', logs.join('\n') + '\n'));

const transport = new StdioClientTransport({
  command: 'node',
  args: ['C:\\Users\\Moera\\ai-cli-mcp-source\\dist\\server.js'],
});
const client = new Client({ name: 'e2e', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
log('connected');
const cwd = 'C:\\Users\\Moera';

async function runAndWait(model, prompt, timeout) {
  const started = await client.callTool({ name: 'run', arguments: { model, prompt, workFolder: cwd } });
  const { pid } = JSON.parse(started.content[0].text);
  log(`[${model}] started pid=${pid}`);
  const waited = await client.callTool({ name: 'wait', arguments: { pids: [pid], timeout } });
  return JSON.parse(waited.content[0].text)[0];
}

for (const [model, to] of [['haiku', 90], ['gpt-5.4-mini', 120], ['agy', 150]]) {
  log(`--- ${model} ---`);
  try {
    const r = await runAndWait(model, 'Reply with exactly one word: PONG', to);
    const o = JSON.stringify(r.agentOutput || r.stdout || '');
    log(`  status=${r.status} exit=${r.exitCode} outLen=${o.length}`);
    log(`  output=${o.slice(0, 200)}`);
    log(o.length > 5 && o !== '""' && o !== '{}' ? '  OK 有輸出' : '  FAIL 無輸出');
  } catch (e) { log(`  ERROR: ${e.message}`); }
}

await client.close();
log('=== e2e done ===');
process.exit(0);
