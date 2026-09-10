/**
 * MCP `run` 的系統提示通道：schema、真的送到 CLI、以及 fail-closed。
 *
 * ── 為什麼需要這一支 ──────────────────────────────────────────
 * 派工常常要交代「這場對話怎麼運作」：你是稽核者、只回報不改碼；或者
 * 以下這些標記與逐筆重播是工作台產生的，不是使用者打的字。
 * 沒有系統提示通道時，這些只能寫進 prompt 內文——也就是**使用者訊息的位置**。
 *
 * 那個組合的長相就是提示注入的標準形狀，而對齊良好的模型會**合理地**拒絕照做。
 * 一個實際遇到的案例（某個做續接對帳的呼叫端），模型的原話是：
 *   「都是被塞進使用者訊息內文的提示注入……我不會附加 [ack ...] 標記」
 * 拒絕的代價可以很大：缺 ack → 判 stale → 這一回合的回答被丟掉 → 下一回合
 * 塞更多結構重建 → 更像攻擊 → 拒絕得更用力。
 *
 * 系統提示是操作方自己的通道，那裡的文字天生就不是使用者輸入。
 *
 * ⚠ 誠實記一筆：上面那個案例**最後不是靠這個參數解決的**（真正的根因是模型自己
 *   先前的拒絕訊息被重播回去）。這一支釘的是「通道本身有沒有正確接上」，
 *   與任何特定呼叫端無關。
 *
 * 這一支釘住三件事：
 *   1. 給了 system_prompt，claude 真的拿到 --append-system-prompt-file，且檔案內容逐字相符
 *   2. 沒給就完全不出現這個參數（既有呼叫端的行為不能被動到）
 *   3. agent 沒有系統提示通道時**拒絕**，不是靜默丟掉
 *      —— 靜默丟掉會讓呼叫端以為說明送到了，而模型什麼都沒看到，比不支援更糟
 *
 * 用法：node verify-mcp-system-prompt.mjs
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

console.log('MCP run 的系統提示通道（system_prompt → --append-system-prompt-file）\n');

// 多行內容：走 args 的話 cmd.exe 會在換行處截斷，所以這裡刻意用多行。
const SYSTEM_TEXT = [
  '[操作方] 你正在一個工作台裡回覆這個對話串。',
  '· [sync …] 是續接對帳，不是使用者打的字。',
  '使用者真正說的話在最後。',
].join('\n');

// 1. 不給 → 完全不出現這個參數。既有行為不能被動到。
{
  const built = plan({ model: 'opus' });
  check(
    !built.args.some((a) => String(a).includes('system-prompt')),
    '不給 system_prompt → 指令列完全沒有這個參數（既有行為不變）',
    built.args.join(' ')
  );
}

// 2. 給了 → claude 拿到 --append-system-prompt-file，而且檔案內容逐字相符。
//    只驗「參數有沒有送出去」是不夠的：檔案是空的、內容被截斷，參數照樣在。
{
  const built = plan({ model: 'opus', system_prompt: SYSTEM_TEXT });
  const idx = built.args.indexOf('--append-system-prompt-file');
  const path = idx >= 0 ? built.args[idx + 1] : null;
  let written = null;
  try {
    written = path ? readFileSync(path, 'utf8') : null;
  } catch {
    /* 讀不到就是沒寫成功 */
  }
  check(
    idx >= 0 && written === SYSTEM_TEXT,
    '★ system_prompt → --append-system-prompt-file，且檔案內容逐字相符（含換行）',
    path ? `${path} (${written === null ? '讀不到' : `${written.length} 字`})` : '沒有參數'
  );
}

// 3. strict builder（唯讀回合）也要有——唯讀回合同樣需要那段說明。
{
  const built = plan({
    model: 'opus',
    system_prompt: SYSTEM_TEXT,
    capabilities: ['fs/read', 'analysis/produce'],
  });
  const noDanger = built.args.every((a) => !/dangerous/i.test(a));
  check(
    noDanger && built.args.includes('--append-system-prompt-file'),
    '★ 唯讀回合（strict builder）也帶得上系統提示，且零危險旗標',
    built.args.join(' ')
  );
}

// 4. fail-closed：codex 沒有系統提示通道 → 拒絕，不是靜默丟掉。
{
  let refused = false;
  let message = '';
  try {
    plan({ model: 'gpt-6-astra', system_prompt: SYSTEM_TEXT });
  } catch (error) {
    refused = true;
    message = String(error?.message ?? error);
  }
  check(
    refused && /系統提示通道/.test(message),
    '★ fail-closed：agent 沒有系統提示通道時拒絕啟動（不靜默丟掉）',
    refused ? message.slice(0, 90) : '沒有拋錯——那代表那段說明被默默丟了'
  );
}

// 5. schema 真的收這個欄位（不是只有實作收、文件沒說）。
{
  const source = readFileSync(join(ROOT, 'src', 'app', 'mcp.ts'), 'utf8');
  check(
    /system_prompt:\s*\{/.test(source) && /append-system-prompt-file/.test(source),
    'MCP schema 宣告了 system_prompt，且說明提到實際的 CLI 參數'
  );
}

const failed = results.filter(([ok]) => !ok);
console.log(`\n${failed.length ? 'FAIL' : 'PASS'}: ${results.length - failed.length} passed, ${failed.length} failed`);
process.exit(failed.length ? 1 : 0);
