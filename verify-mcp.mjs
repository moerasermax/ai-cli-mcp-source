// MCP server smoke test：啟動 dist/server.js，跑 handshake + 呼叫工具。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';

const logs = [];
const log = (...a) => logs.push(a.join(' '));
process.on('exit', () => writeFileSync('mcp-test-out.txt', logs.join('\n') + '\n'));

const transport = new StdioClientTransport({
  command: 'node',
  args: ['C:\\Users\\Moera\\ai-cli-mcp-source\\dist\\server.js'],
});

const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });
await client.connect(transport);
log('connected & initialized');

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
log(`list_tools (${names.length}): ${names.join(', ')}`);

const expected = ['run', 'list_processes', 'get_result', 'wait', 'peek', 'kill_process', 'cleanup_processes', 'doctor', 'models'];
const missing = expected.filter((e) => !names.includes(e));
if (missing.length) { log('MISSING TOOLS:', missing); process.exit(1); }
log('all 9 expected tools present');

const models = await client.callTool({ name: 'models', arguments: {} });
const modelsPayload = JSON.parse(models.content[0].text);
log(`models agents = ${Object.keys(modelsPayload).filter((k) => Array.isArray(modelsPayload[k])).join(', ')}`);
if (!modelsPayload.antigravity || !modelsPayload.kiro) { log('agy/kiro missing!'); process.exit(1); }
if (modelsPayload.gemini) { log('gemini should NOT be present!'); process.exit(1); }
log('antigravity & kiro present, gemini absent');

const doctor = await client.callTool({ name: 'doctor', arguments: {} });
const doctorPayload = JSON.parse(doctor.content[0].text);
const avail = Object.keys(doctorPayload).filter((k) => k !== 'checks' && doctorPayload[k].available).join(', ');
log(`doctor available CLIs = ${avail}`);

const list = await client.callTool({ name: 'list_processes', arguments: {} });
log(`list_processes: ${list.content[0].text.trim()}`);

await client.close();
log('=== MCP smoke test PASSED ===');
process.exit(0);
