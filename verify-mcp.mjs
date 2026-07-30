// MCP server smoke test：對**每一個對外入口**跑 handshake + 呼叫工具。
//
// 為什麼三個入口都要跑：4.1.2 之前 `ai-cli mcp` 這條路徑一連上就自殺
// （runMcpServer 啟動完就 resolve，bin/ai-cli.ts 隨即 process.exit），
// 但這支腳本當時硬編 `C:\Users\Moera\...\dist\server.js`，只測得到其中一個入口，
// 於是那個 bug 從框架初版活到 4.1.1 都沒被抓到。典型的假綠燈。
// 路徑一律相對本檔解析，不要再寫死任何機器上的絕對路徑。
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const logs = [];
const log = (...a) => logs.push(a.join(' '));
process.on('exit', () => writeFileSync('mcp-test-out.txt', logs.join('\n') + '\n'));

const dist = (relative) => fileURLToPath(new URL(`./dist/${relative}`, import.meta.url));

/** 三個入口在對外行為上應完全等價。 */
const ENTRIES = [
  { name: 'dist/server.js', args: [dist('server.js')] },
  { name: 'dist/bin/ai-cli-mcp.js', args: [dist('bin/ai-cli-mcp.js')] },
  { name: 'dist/bin/ai-cli.js mcp', args: [dist('bin/ai-cli.js'), 'mcp'] },
];

const EXPECTED_TOOLS = [
  'run', 'list_processes', 'get_result', 'wait', 'peek', 'kill_process',
  'cleanup_processes', 'doctor', 'models', 'set_config', 'query_usage',
];

/**
 * 入口壞掉時實測是 202ms 內 reject（-32000 Connection closed），不是 hang。
 * 還是加一層 timeout：突變測試會把這支腳本跑很多次，任何一次 hang 都會讓整個
 * harness 卡死，而不是回報一個乾淨的 FAIL。
 */
const withTimeout = (promise, ms, label) =>
  Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      timer.unref?.();
    }),
  ]);

async function checkEntry(entry) {
  log(`\n=== 入口：${entry.name} ===`);
  const transport = new StdioClientTransport({ command: 'node', args: entry.args });
  const client = new Client({ name: 'smoke-test', version: '1.0.0' }, { capabilities: {} });

  await withTimeout(client.connect(transport), 20000, `${entry.name} connect`);
  log('connected & initialized');

  const tools = await client.listTools();
  const names = tools.tools.map((t) => t.name);
  log(`list_tools (${names.length}): ${names.join(', ')}`);

  const missing = EXPECTED_TOOLS.filter((e) => !names.includes(e));
  if (missing.length) throw new Error(`MISSING TOOLS: ${missing.join(', ')}`);
  log(`all ${EXPECTED_TOOLS.length} expected tools present`);

  const models = await client.callTool({ name: 'models', arguments: {} });
  const modelsPayload = JSON.parse(models.content[0].text);
  log(`models agents = ${Object.keys(modelsPayload).filter((k) => Array.isArray(modelsPayload[k])).join(', ')}`);
  if (!modelsPayload.antigravity) throw new Error('antigravity missing!');
  if (modelsPayload.gemini) throw new Error('gemini should NOT be present!');
  // 5.0.0 移除：kiro / forge 不得再出現在 models payload 或 alias 清單裡。
  for (const gone of ['kiro', 'forge']) {
    if (modelsPayload[gone]) throw new Error(`${gone} should NOT be present (removed in 5.0.0)!`);
  }
  if (modelsPayload.aliases.some((a) => a.name === 'kiro-ultra')) {
    throw new Error('kiro-ultra alias should NOT be present (removed in 5.0.0)!');
  }
  log('antigravity present; gemini/kiro/forge absent');

  const doctor = await client.callTool({ name: 'doctor', arguments: {} });
  const doctorPayload = JSON.parse(doctor.content[0].text);
  const avail = Object.keys(doctorPayload).filter((k) => k !== 'checks' && doctorPayload[k].available).join(', ');
  log(`doctor available CLIs = ${avail}`);

  const list = await client.callTool({ name: 'list_processes', arguments: {} });
  log(`list_processes: ${list.content[0].text.trim()}`);

  await client.close();
  log(`--- ${entry.name} OK ---`);
}

let failures = 0;
for (const entry of ENTRIES) {
  try {
    await checkEntry(entry);
  } catch (error) {
    failures++;
    log(`!!! ${entry.name} FAILED: ${error.message}`);
    // 這一行必須進 stdout（而不是只進 mcp-test-out.txt）：tools/mutation-test.mjs
    // 是靠掃 stdout 裡含 "FAIL " 的行、再比對 mutations.json 的 expect 字串，
    // 才能判斷突變是「被我們指定的那條斷言殺掉」還是被別的斷言誤殺。
    console.log(`  FAIL 入口 ${entry.name} 的 MCP handshake 與工具呼叫 — ${error.message}`);
  }
}

if (failures) {
  log(`\n=== MCP smoke test FAILED（${failures}/${ENTRIES.length} 個入口壞掉）===`);
  process.exit(1);
}
log(`\n=== MCP smoke test PASSED（${ENTRIES.length} 個入口全部通過）===`);
process.exit(0);
