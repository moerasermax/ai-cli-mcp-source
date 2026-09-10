/**
 * MCP `run` 的唯讀能力：schema、轉送、fail-closed。
 *
 * ── 為什麼需要這一支 ──────────────────────────────────────────
 * `ai-cli exec` 從一開始就有嚴格模式（claude `--allowedTools Read,Glob,Grep`、
 * codex `--sandbox read-only`），但那條路只有 exec 走得到。MCP `run` 一律走
 * 一般組裝，也就是帶著 `--dangerously-skip-permissions` /
 * `--dangerously-bypass-approvals-and-sandbox`。
 *
 * 於是任何透過 MCP 使用這個框架的呼叫端——例如 TKFLYC Launcher 的「唯讀回合」——
 * 就算自己不做 git 快照，模型仍然有完整的檔案寫入能力。**「我不做快照」不等於
 * 「它不會寫檔」**：那樣做出來的唯讀回合，實際上是一個沒有回復點的可寫回合，
 * 比什麼都不做更糟。
 *
 * 這一支釘住三件事：
 *   1. schema 真的收 capabilities（不是只有文件寫了）
 *   2. 給了就走 strict、沒給維持原樣（不能改變既有呼叫端的行為）
 *   3. 空陣列 ≠ 沒給；agent 沒有 strict builder 時**拒絕**而不是退回
 *
 * 用法：node verify-mcp-capabilities.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const builder = await import(pathToFileURL(join(ROOT, 'dist', 'core', 'command-builder.js')).href);
const plan = (extra) =>
  builder.buildCliCommand({
    workFolder: ROOT,
    prompt: 'hi',
    cliPaths: { claude: 'claude', codex: 'codex' },
    ...extra,
  });

console.log('MCP run 的唯讀能力（capabilities → strict builder）\n');

// 1. 沒給 capabilities → 一般模式。這是既有行為，不能被這次的改動動到。
{
  const built = plan({ model: 'opus' });
  check(
    built.args.includes('--dangerously-skip-permissions'),
    '不給 capabilities → 一般組裝（既有行為不變）',
    built.args.join(' ')
  );
}

// 2. 給了 → strict。claude 應該拿到 allowedTools 而且完全沒有 dangerous 旗標。
{
  const built = plan({ model: 'opus', capabilities: ['fs/read', 'analysis/produce'] });
  const noDanger = built.args.every((a) => !/dangerous/i.test(a));
  check(
    noDanger && built.args.includes('--allowedTools'),
    '★ capabilities → strict builder（claude：有 allowedTools、零危險旗標）',
    built.args.join(' ')
  );
}

// 3. codex 的 read-only sandbox。
{
  const built = plan({ model: 'gpt-5.3-codex', capabilities: ['fs/read'] });
  const noDanger = built.args.every((a) => !/dangerous/i.test(a));
  const idx = built.args.indexOf('--sandbox');
  check(
    noDanger && idx >= 0 && built.args[idx + 1] === 'read-only',
    '★ capabilities → strict builder（codex：--sandbox read-only、零危險旗標）',
    built.args.join(' ')
  );
}

// 4. 空陣列 ≠ 沒給。折成同一件事，等於讓要求限制的呼叫端拿到全開權限而不自知。
{
  const built = plan({ model: 'opus', capabilities: [] });
  check(
    built.args.every((a) => !/dangerous/i.test(a)),
    '★ 空陣列仍走 strict（[] 是「什麼都不給」，不是「沒有意見」）',
    built.args.join(' ')
  );
}

// 5. fail-closed：沒有 strict builder 的 agent 要拒絕，不得退回一般模式。
{
  let threw = false;
  let message = '';
  try {
    plan({ model: 'or-some/model', capabilities: ['fs/read'] });
  } catch (error) {
    threw = true;
    message = error.message;
  }
  check(
    threw && /嚴格模式/.test(message),
    '★ 沒有 strict builder 的 agent → 拒絕啟動（不退回權限旁路）',
    message
  );
}

// 6. schema 真的收這個欄位——文件寫了但 schema 沒收，呼叫端會靜默失去限制。
{
  const mcpSrc = readFileSync(join(ROOT, 'src', 'app', 'mcp.ts'), 'utf-8');
  const declared = /capabilities:\s*\{\s*\n\s*type:\s*'array'/.test(mcpSrc);
  const forwarded = /capabilities:\s*\(toolArguments\.capabilities as unknown\[\]\)/.test(mcpSrc);
  check(declared, 'run 的 inputSchema 宣告了 capabilities');
  check(
    forwarded,
    '★ handler 真的把它轉送給 startProcess（宣告了卻沒轉送＝呼叫端以為有限制）'
  );
}

// 7. 兩條啟動路徑都要支援。只有一條擋得住，呼叫端要看運氣。
{
  const ps = readFileSync(join(ROOT, 'src', 'core', 'process-service.ts'), 'utf-8');
  const fps = readFileSync(join(ROOT, 'src', 'core', 'file-process-service.ts'), 'utf-8');
  check(
    /capabilities\?: readonly string\[\]/.test(ps) && /capabilities\?: readonly string\[\]/.test(fps),
    '★ process-service 與 file-process-service 都收 capabilities'
  );
}

const failed = results.filter(([ok]) => !ok).length;
console.log(`\n${failed === 0 ? 'PASS' : 'FAIL'}: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
