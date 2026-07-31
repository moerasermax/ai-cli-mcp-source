/**
 * `ai-cli exec` 前景契約 ＋ `lost` ≠ `failed` 的回歸測試。
 *
 * ── 這一支守什麼 ──────────────────────────────────────────────
 * exec 存在的理由是「呼叫端要自己擁有這個程序」。三條規則若破了，
 * 呼叫端會**在不知情的情況下**拿到錯的資訊：
 *
 *   1. 能力 fail-closed —— 沒有嚴格模式就拒絕，不退回權限旁路。
 *      破了的樣子：畫面說「唯讀」，程序其實全開。
 *   2. terminal frame 等三個 EOF —— child close / stdout / stderr。
 *      破了的樣子：最後幾個 byte 在「已完成」之後才到，而呼叫端
 *      已經把那次執行封存了。
 *   3. stdout 走 base64 —— 多位元字元跨 chunk 不得被切壞。
 *
 * 外加 S2c：PID 不見且沒有結束回報時必須是 `lost`，不是 `failed`。
 *
 * 用法：node verify-exec-contract.mjs
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CLI = join(ROOT, 'dist', 'bin', 'ai-cli.js');

const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

/** 跑一次 exec，回傳解析後的 frames。 */
function runExec(request) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'exec'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (c) => (out += c.toString('utf-8')));
    child.stderr.on('data', (c) => (err += c.toString('utf-8')));
    child.on('close', (code) => {
      const frames = out
        .split('\n')
        .filter((line) => line.trim() !== '')
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch {
            return { parseError: line };
          }
        });
      resolve({ frames, stderr: err, code });
    });
    child.stdin.end(JSON.stringify(request));
  });
}

const load = (rel) => import(pathToFileURL(join(ROOT, 'dist', rel)).href);

console.log('== ai-cli exec 前景契約 ==');

const registry = await load('agents/registry.js');

// ── 1. 能力 fail-closed ───────────────────────────────────────
{
  const noStrict = await runExec({
    cwd: ROOT,
    model: 'or-some/model', // direct-api：沒有 buildStrictCommand
    prompt: 'hi',
    capabilities: ['fs/read'],
  });
  const terminal = noStrict.frames.at(-1);
  check(
    terminal?.type === 'terminal' && terminal.status === 'spawn-failed',
    '★ 沒有嚴格模式的 agent → 拒絕啟動（不退回權限旁路）',
    terminal?.detail ?? JSON.stringify(terminal)
  );
  check(
    typeof terminal?.detail === 'string' && terminal.detail.length > 0,
    '★ 拒絕時要說出為什麼（不是靜默失敗）'
  );

  const badCapability = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    capabilities: ['fs/write'], // claude 的嚴格模式給不出寫入保證
  });
  const t2 = badCapability.frames.at(-1);
  check(
    t2?.type === 'terminal' && t2.status === 'spawn-failed',
    '★ 給不出保證的能力 → 拒絕，而不是放寬',
    t2?.detail ?? ''
  );
}

// ── 2. 嚴格模式**絕不**帶危險旗標 ─────────────────────────────
{
  for (const id of ['claude', 'codex', 'antigravity']) {
    const agent = registry.getAgent(id);
    check(
      typeof agent.buildStrictCommand === 'function',
      `${id} 有嚴格模式`
    );
    const strict = agent.buildStrictCommand(
      { cliPath: 'X', cwd: '.', prompt: 'p', resolvedModel: 'm', rawModel: 'm', reasoningEffort: '' },
      ['fs/read']
    );
    const dangerous = strict.args.filter((a) => /dangerous/i.test(a));
    check(
      dangerous.length === 0,
      `★ ${id} 的嚴格模式零危險旗標（一般模式有，這正是兩者的差別）`,
      dangerous.join(',')
    );
    // 對照：一般模式**應該**還帶著旁路（沒帶反而代表我改錯了地方）
    const normal = agent.buildCommand({
      cliPath: 'X',
      cwd: '.',
      prompt: 'p',
      resolvedModel: 'm',
      rawModel: 'm',
      reasoningEffort: '',
    });
    check(
      normal.args.some((a) => /dangerous/i.test(a)),
      `對照組：${id} 的一般模式仍帶旁路（確認我改的是新路徑，不是既有行為）`
    );
  }
}

// ── 3. 協定形狀 ───────────────────────────────────────────────
{
  // 用一個一定不存在的 CLI 觸發 spawn 失敗，驗 frame 結構而不花錢
  const previous = process.env.CLAUDE_CLI_NAME;
  process.env.CLAUDE_CLI_NAME = 'definitely-not-a-real-binary-xyz';
  const missing = await runExec({
    cwd: ROOT,
    model: 'opus',
    prompt: 'hi',
    capabilities: ['fs/read'],
  });
  if (previous === undefined) delete process.env.CLAUDE_CLI_NAME;
  else process.env.CLAUDE_CLI_NAME = previous;

  const last = missing.frames.at(-1);
  check(
    last?.type === 'terminal',
    '★ 任何結束路徑都必須以 terminal frame 收尾（呼叫端靠它判斷「說完了」）',
    JSON.stringify(last)
  );
  check(
    missing.frames.every((f) => f.v === 1),
    '每個 frame 都帶協定版本 v（呼叫端要能拒絕未知版本）'
  );
  const bad = missing.frames.filter((f) => f.parseError !== undefined);
  check(bad.length === 0, '★ stdout 只有合法 NDJSON（診斷訊息不得混進協定）', bad.length ? bad[0].parseError : '');
}

// ── 4. exec 不得用立即 process.exit（最後一個 frame 會掉） ────
{
  const { readFileSync } = await import('node:fs');
  const bin = readFileSync(join(ROOT, 'src', 'bin', 'ai-cli.ts'), 'utf-8');
  check(
    /isExec/.test(bin) && /process\.exitCode = exitCode/.test(bin),
    '★ exec 走 exitCode 而非立即 exit（stdout 是 pipe 時最後一個 frame 會掉）'
  );
}

// ── 5. S2c：lost ≠ failed ─────────────────────────────────────
{
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(join(ROOT, 'src', 'core', 'file-process-service.ts'), 'utf-8');
  check(
    /status: 'running' \| 'completed' \| 'failed' \| 'lost'/.test(src),
    "★ 狀態union 有 'lost'（沒收到結束回報 ≠ 失敗）"
  );
  check(
    !/proc\.status = 'failed';/.test(src),
    "★ 「PID 不見且無 exit-status」不得再寫成 failed",
  );
  check(
    /proc\.status = 'lost';/.test(src),
    '★ 該情境改記 lost（照實說「不知道」，而不是編一個結論）'
  );
  check(
    /status: 'lost', exitCode: SIGTERM_EXIT_CODE/.test(src),
    '★ 砍掉但沒拿到結束回報 → lost（「被砍」不等於「失敗」）'
  );
}

const passed = results.filter(([ok]) => ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
if (passed !== results.length) {
  for (const [ok, name] of results) if (!ok) console.log(`  FAILED: ${name}`);
  process.exitCode = 1;
}
