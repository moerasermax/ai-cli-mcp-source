/**
 * 驗證狀態五態判定（純邏輯，不啟動任何真實 AI）。
 * 重點在「順序」：先跑測試再改程式碼不能算通過，這是這套判定最容易假綠燈的地方。
 * 執行：npm run build && node verify-verification.mjs
 */
import {
  classifyVerification,
  normalizeToolEvent,
  verificationFromAgentOutput,
} from './dist/core/verification.js';
import { buildProcessResult } from './dist/core/process-result.js';
import { codexAgent } from './dist/agents/codex.js';
import { bodyOf } from './tools/sync-plugin-core.mjs';
import { readFileSync as readFile, existsSync as fileExists } from 'node:fs';
import assert from 'node:assert';

let failures = 0;
/**
 * 只吃**同步**函式。
 *
 * 2026-09-08 突變測試抓到：傳 async 函式進來時，fn() 只是回傳一個 Promise，
 * try/catch 完全抓不到裡面的斷言錯誤，那條測試就永遠 PASS——四條假綠燈就是
 * 這樣來的。所以這裡明確擋掉 Promise，需要動態載入的東西一律提到檔案頂層
 * 用 top-level await 取得。
 */
function ok(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('ok() 只接受同步函式；async 會讓斷言錯誤被吞掉而永遠通過');
    }
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

// ---- 各家 agent 的原始工具紀錄格式 ----
const claudeEdit = (p) => ({ tool: 'Edit', input: { file_path: p }, output: null });
const claudeBash = (cmd, out = '') => ({ tool: 'Bash', input: { command: cmd }, output: out });
const codexExec = (cmd, exit = 0, out = '') => ({
  tool: 'command_execution',
  input: { command: cmd },
  output: out,
  exit_code: exit,
});
const codexMcp = (tool) => ({ server: 'knowledge', tool, input: {}, output: {} });

const ctx = (over = {}) => ({
  pid: 1,
  agent: 'claude',
  status: 'completed',
  exitCode: 0,
  startTime: new Date().toISOString(),
  workFolder: 'C:/tmp',
  prompt: 'p',
  stdout: '',
  stderr: '',
  ...over,
});

// ---------------- 正規化 ----------------
ok('正規化：改 .ts 算 code_change', () => {
  assert.strictEqual(normalizeToolEvent(claudeEdit('src/a.ts')).kind, 'code_change');
});

ok('正規化：改 README.md 不算 code_change', () => {
  assert.strictEqual(normalizeToolEvent(claudeEdit('README.md')).kind, 'other');
});

ok('正規化：npm test 算 verification', () => {
  const e = normalizeToolEvent(claudeBash('npm test'));
  assert.strictEqual(e.kind, 'verification');
  assert.strictEqual(e.ok, true);
});

ok('正規化：codex exit_code 非 0 判失敗（優先於文字比對）', () => {
  const e = normalizeToolEvent(codexExec('npm test', 1, 'everything looks great'));
  assert.strictEqual(e.kind, 'verification');
  assert.strictEqual(e.ok, false, 'exit_code=1 必須是失敗，不能被輸出文字蓋過');
});

ok('正規化：claude 沒有 exit_code 時用輸出文字判失敗', () => {
  assert.strictEqual(normalizeToolEvent(claudeBash('npm test', '2 tests failed')).ok, false);
});

ok('正規化：exit_code=0 時不因輸出含 error 字樣就誤判失敗', () => {
  assert.strictEqual(normalizeToolEvent(codexExec('npm test', 0, 'Error: handled ok')).ok, true);
});

ok('正規化：sed -i 改 .ts 算 code_change', () => {
  assert.strictEqual(normalizeToolEvent(claudeBash('sed -i s/a/b/ src/a.ts')).kind, 'code_change');
});

ok('正規化：MCP 呼叫不算 code_change 也不算 verification', () => {
  assert.strictEqual(normalizeToolEvent(codexMcp('knowledge_search')).kind, 'other');
});

// ★ 2026-09-08 端到端實測抓到：codex 改檔不走 shell，走 file_change。
// 只收 command_execution 的話，codex 子 agent 改了程式碼也永遠判 not_applicable。
ok('★ 正規化：codex 的 file_change 算 code_change', () => {
  const e = normalizeToolEvent({ tool: 'file_change', input: { file_path: 'src/a.ts', kind: 'update' } });
  assert.strictEqual(e.kind, 'code_change', 'codex 改檔走 file_change，不是 shell');
});

ok('正規化：file_change 刪除程式碼也算數', () => {
  const e = normalizeToolEvent({ tool: 'file_change', input: { file_path: 'src/a.ts', kind: 'delete' } });
  assert.strictEqual(e.kind, 'code_change', '刪掉程式碼一樣需要驗證');
});

ok('正規化：file_change 改到文件不算 code_change', () => {
  const e = normalizeToolEvent({ tool: 'file_change', input: { file_path: 'README.md', kind: 'update' } });
  assert.strictEqual(e.kind, 'other');
});

ok('★ codex parser 會收 file_change 並展開成每檔一筆', () => {
  // 真實 codex NDJSON（2026-09-08 由 codex 0.153.4 實際輸出捕捉）
  const ndjson = [
    JSON.stringify({ type: 'thread.started', thread_id: 'th_1' }),
    JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'file_change', status: 'completed',
        changes: [{ path: 'D:\\proj\\src\\a.ts', kind: 'update' }, { path: 'D:\\proj\\src\\b.ts', kind: 'add' }] },
    }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'agent_message', text: 'done' } }),
  ].join('\n');
  const parsed = codexAgent.parseOutput(ndjson, '', 0, { workFolder: 'D:\\proj', status: 'completed' });
  const changes = (parsed.tools ?? []).filter((t) => t.tool === 'file_change');
  assert.strictEqual(changes.length, 2, '一筆 file_change 帶兩個檔案，要展開成兩筆');
  assert.strictEqual(changes[0].input.file_path, 'D:\\proj\\src\\a.ts');
  assert.strictEqual(changes[1].input.kind, 'add');
});

ok('★ codex 端到端形狀：file_change + 之後跑 npm test → passed', () => {
  const ndjson = [
    JSON.stringify({ type: 'item.completed', item: { id: 'i1', type: 'file_change', changes: [{ path: 'D:\\proj\\src\\a.ts', kind: 'update' }] } }),
    JSON.stringify({ type: 'item.completed', item: { id: 'i2', type: 'command_execution', command: 'pwsh.exe -Command "npm test"', aggregated_output: 'ok', exit_code: 0 } }),
  ].join('\n');
  const parsed = codexAgent.parseOutput(ndjson, '', 0, { workFolder: 'D:\\proj', status: 'completed' });
  const r = verificationFromAgentOutput(parsed, { projectRoot: 'D:\\proj' });
  assert.strictEqual(r.status, 'passed', `實際 ${r.status}: ${r.reason}`);
});

ok('★ codex 端到端形狀：只有 file_change 沒驗證 → not_observed', () => {
  const ndjson = JSON.stringify({
    type: 'item.completed',
    item: { id: 'i1', type: 'file_change', changes: [{ path: 'D:\\proj\\src\\a.ts', kind: 'update' }] },
  });
  const parsed = codexAgent.parseOutput(ndjson, '', 0, { workFolder: 'D:\\proj', status: 'completed' });
  const r = verificationFromAgentOutput(parsed, { projectRoot: 'D:\\proj' });
  assert.strictEqual(r.status, 'not_observed', `實際 ${r.status}`);
  assert.match(r.evidence.lastCodeChange ?? '', /a\.ts/);
});

// ---------------- 專案範圍（projectRoot）----------------
// 真實 transcript 實測抓到的誤報：寫到暫存目錄的一次性分析腳本被當成專案程式碼。
const ROOT = 'C:\\Users\\Moera\\ai-cli-mcp-source';

ok('projectRoot：工作目錄內的 .ts 算 code_change', () => {
  const e = normalizeToolEvent(claudeEdit(`${ROOT}\\src\\a.ts`), { projectRoot: ROOT });
  assert.strictEqual(e.kind, 'code_change');
});

ok('★ projectRoot：暫存目錄的一次性腳本不算 code_change', () => {
  const e = normalizeToolEvent(claudeEdit('D:\\Temp\\scratch\\probe.mjs'), { projectRoot: ROOT });
  assert.strictEqual(e.kind, 'other', '暫存腳本沒有測試可跑，不該要求驗證');
});

ok('projectRoot：路徑分隔與大小寫差異不影響判斷', () => {
  const e = normalizeToolEvent(claudeEdit('c:/users/moera/ai-cli-mcp-source/src/a.ts'), {
    projectRoot: ROOT,
  });
  assert.strictEqual(e.kind, 'code_change');
});

ok('projectRoot：前綴相同但不是子目錄的路徑不算數', () => {
  const e = normalizeToolEvent(claudeEdit(`${ROOT}-other\\src\\a.ts`), { projectRoot: ROOT });
  assert.strictEqual(e.kind, 'other', 'ai-cli-mcp-source-other 不是 ai-cli-mcp-source 的子目錄');
});

ok('projectRoot：沒給就一律算數（維持舊行為）', () => {
  assert.strictEqual(normalizeToolEvent(claudeEdit('D:\\Temp\\x.mjs')).kind, 'code_change');
});

ok('★ projectRoot：相對路徑一律算在專案內', () => {
  const e = normalizeToolEvent(claudeEdit('src/a.ts'), { projectRoot: ROOT });
  assert.strictEqual(e.kind, 'code_change', '相對路徑本來就相對於工作目錄，不能被排除');
});

ok('projectRoot：POSIX 絕對路徑在專案外時排除', () => {
  const e = normalizeToolEvent(claudeEdit('/tmp/probe.mjs'), { projectRoot: '/home/me/proj' });
  assert.strictEqual(e.kind, 'other');
});

ok('★ 暫存腳本 + 專案內修改並存時，以專案內的為準', () => {
  const events = [
    claudeEdit(`${ROOT}\\src\\a.ts`),
    claudeBash('npm test'),
    claudeEdit('D:\\Temp\\probe.mjs'),
  ].map((e) => normalizeToolEvent(e, { projectRoot: ROOT }));
  const r = classifyVerification(events);
  assert.strictEqual(r.status, 'passed', '之後寫的暫存腳本不該讓已驗證的工作變成未驗證');
});

ok('buildProcessResult 用 workFolder 當專案根', () => {
  const r = buildProcessResult(
    ctx({ workFolder: ROOT }),
    { message: 'done', tools: [claudeEdit('D:\\Temp\\probe.mjs')] },
    false
  );
  assert.strictEqual(r.verification.status, 'not_applicable', '子 agent 寫到工作目錄外不算數');
});

// ---------------- 五態 ----------------
ok('not_applicable：只改文件，不需要驗證', () => {
  const r = classifyVerification([claudeEdit('README.md')].map(normalizeToolEvent));
  assert.strictEqual(r.status, 'not_applicable');
});

ok('passed：改完程式碼之後跑測試成功', () => {
  const r = classifyVerification(
    [claudeEdit('src/a.ts'), claudeBash('npm test')].map(normalizeToolEvent)
  );
  assert.strictEqual(r.status, 'passed');
  assert.strictEqual(r.evidence.verificationsAfterChange.length, 1);
});

ok('failed：改完程式碼之後測試失敗', () => {
  const r = classifyVerification(
    [claudeEdit('src/a.ts'), codexExec('npm test', 1)].map(normalizeToolEvent)
  );
  assert.strictEqual(r.status, 'failed');
  assert.strictEqual(r.evidence.failedVerifications.length, 1);
});

ok('not_observed：改了程式碼但完全沒跑驗證', () => {
  const r = classifyVerification([claudeEdit('src/a.ts')].map(normalizeToolEvent));
  assert.strictEqual(r.status, 'not_observed');
  assert.match(r.reason, /no verification ran afterwards/);
});

// ★ 這支測試存在的理由
ok('順序陷阱：先跑測試再改程式碼 → not_observed，絕不能是 passed', () => {
  const r = classifyVerification(
    [claudeBash('npm test'), claudeEdit('src/a.ts')].map(normalizeToolEvent)
  );
  assert.strictEqual(r.status, 'not_observed', '測試跑在修改之前，不能算數');
  assert.strictEqual(r.evidence.staleVerifications, 1, '應指出有 1 次過期的驗證');
  assert.strictEqual(r.evidence.verificationsAfterChange.length, 0);
});

ok('順序：多次修改時以最後一次為準', () => {
  const r = classifyVerification(
    [claudeEdit('src/a.ts'), claudeBash('npm test'), claudeEdit('src/b.ts')].map(normalizeToolEvent)
  );
  assert.strictEqual(r.status, 'not_observed', '最後一次修改後沒有驗證');
  assert.strictEqual(r.evidence.lastCodeChange, 'Edit src/b.ts');
  assert.strictEqual(r.evidence.staleVerifications, 1);
});

ok('failed 優先於 passed：修改後兩次驗證有一次失敗', () => {
  const r = classifyVerification(
    [claudeEdit('src/a.ts'), codexExec('npm run build', 0), codexExec('npm test', 1)].map(
      normalizeToolEvent
    )
  );
  assert.strictEqual(r.status, 'failed');
});

ok('waived：改了沒驗證但有明確理由', () => {
  const r = classifyVerification([claudeEdit('src/a.ts')].map(normalizeToolEvent), {
    waivedReason: '此專案沒有測試框架',
  });
  assert.strictEqual(r.status, 'waived');
  assert.match(r.reason, /此專案沒有測試框架/);
});

ok('waived 不能蓋過 failed', () => {
  const r = classifyVerification(
    [claudeEdit('src/a.ts'), codexExec('npm test', 1)].map(normalizeToolEvent),
    { waivedReason: '我覺得沒差' }
  );
  assert.strictEqual(r.status, 'failed', '驗證真的失敗時，豁免不能把它變成通過');
});

ok('not_observed：agent 沒有結構化工具紀錄（agy）', () => {
  const r = classifyVerification([], { structured: false });
  assert.strictEqual(r.status, 'not_observed');
  assert.match(r.reason, /no structured tool history/);
});

ok('無結構化紀錄時不得回報 not_applicable', () => {
  const r = classifyVerification([], { structured: false });
  assert.notStrictEqual(r.status, 'not_applicable', '看不到不等於沒改');
});

// ---------------- agentOutput 介面 ----------------
// 舊版在這裡回 null，等於多出一個沒有名字的第七態「欄位缺席」，
// 跟 process-result 宣稱的「一律回報」自相矛盾（codex 稽核抓到）。
ok('★ verificationFromAgentOutput：一律回報，不回 null', () => {
  const r = verificationFromAgentOutput({ message: 'hi' });
  assert.notStrictEqual(r, null, '欄位缺席不是一種狀態');
  assert.strictEqual(r.status, 'not_applicable', '有記錄能力但沒有工具事件 = 真的沒動到檔案');
});

ok('verificationFromAgentOutput：agy（structured=false）回 not_observed', () => {
  const r = verificationFromAgentOutput({ message: 'hi' }, { structured: false });
  assert.strictEqual(r.status, 'not_observed');
});

ok('verificationFromAgentOutput：吃得下 codex 的 tools 陣列', () => {
  const r = verificationFromAgentOutput({
    tools: [claudeEdit('src/a.ts'), codexExec('npm test', 0)],
  });
  assert.strictEqual(r.status, 'passed');
});

// ---------------- 併入 process result ----------------
ok('running 只能是 pending，不能宣稱 passed', () => {
  const r = buildProcessResult(
    ctx({ status: 'running', liveness: { alive: true } }),
    { tools: [claudeEdit('src/a.ts'), claudeBash('npm test')] },
    false
  );
  assert.strictEqual(r.verification.status, 'pending');
});

// ★ 這條是整個第 1 層的重點
ok('compact 回傳也必須帶 verification（AI 只看得到工具回傳）', () => {
  const r = buildProcessResult(ctx(), { message: 'done', tools: [claudeEdit('src/a.ts')] }, false);
  assert.ok(r.verification, 'compact 模式不能把 verification 拿掉');
  assert.strictEqual(r.verification.status, 'not_observed');
  assert.strictEqual(r.agentOutput.tools, undefined, 'compact 仍應拿掉笨重的 tools 明細');
});

ok('verbose 回傳同時有 verification 與 tools 明細', () => {
  const r = buildProcessResult(ctx(), { message: 'done', tools: [claudeEdit('src/a.ts')] }, true);
  assert.strictEqual(r.verification.status, 'not_observed');
  assert.ok(Array.isArray(r.agentOutput.tools));
});

ok('antigravity 的結果標成 not_observed 而不是 not_applicable', () => {
  const r = buildProcessResult(ctx({ agent: 'antigravity' }), { message: 'done' }, false);
  assert.strictEqual(r.verification.status, 'not_observed');
});

ok('★ 沒有 tools 的 claude 結果也要有 verification（契約一致）', () => {
  const r = buildProcessResult(ctx(), { message: 'done' }, false);
  assert.ok(r.verification, 'verification 欄位不得缺席');
  assert.strictEqual(r.verification.status, 'not_applicable');
});

// ---------------- codex 稽核驗證成立的問題 ----------------
ok('★ 輸出含「0 failed」不得判成失敗（最常見的成功輸出）', () => {
  const e = normalizeToolEvent({ tool: 'Bash', input: { command: 'npm test' }, output: '49 passed, 0 failed' });
  assert.strictEqual(e.ok, true, '"0 failed" 是成功，不是失敗');
});

ok('輸出含「3 failed」仍要判成失敗', () => {
  const e = normalizeToolEvent({ tool: 'Bash', input: { command: 'npm test' }, output: '46 passed, 3 failed' });
  assert.strictEqual(e.ok, false);
});

ok('輸出含「all tests passed」不得判成失敗', () => {
  const e = normalizeToolEvent({ tool: 'Bash', input: { command: 'npm test' }, output: 'all tests passed' });
  assert.strictEqual(e.ok, true);
});

ok('★ echo 出指令字串不算跑過驗證（最廉價的偽造）', () => {
  const e = normalizeToolEvent({ tool: 'Bash', input: { command: 'echo "npm test"' }, output: 'npm test' });
  assert.notStrictEqual(e.kind, 'verification', 'echo 不是執行');
});

ok('★ 同一指令同時改檔與驗證 → 判成 code_change（不得假通過）', () => {
  const events = [
    normalizeToolEvent({ tool: 'Bash', input: { command: 'sed -i s/a/b/ src/a.ts && npm test' }, output: 'ok' }),
  ];
  assert.strictEqual(events[0].kind, 'code_change', '無法確定先後，保守當成未驗證');
  assert.strictEqual(classifyVerification(events).status, 'not_observed');
});

ok('★ 前一次改檔已驗證，之後又用一行 shell 改檔 → 不得判 passed', () => {
  const events = [
    { tool: 'Edit', input: { file_path: 'src/a.ts' } },
    { tool: 'Bash', input: { command: 'npm test' }, output: 'ok' },
    { tool: 'Bash', input: { command: 'sed -i s/x/y/ src/b.ts && npm test' }, output: 'ok' },
  ].map((e) => normalizeToolEvent(e));
  assert.strictEqual(classifyVerification(events).status, 'not_observed', '後來那次修改不能被前面的驗證蓋過');
});

ok('★ 相對路徑 ../ 不得逃逸專案根', () => {
  const e = normalizeToolEvent(claudeEdit('../outside/evil.ts'), { projectRoot: 'C:\\proj' });
  assert.strictEqual(e.kind, 'other', '../ 指向專案外');
});

ok('★ 絕對路徑裡的 .. 要被正規化', () => {
  const e = normalizeToolEvent(claudeEdit('C:\\proj\\..\\outside\\evil.ts'), { projectRoot: 'C:\\proj' });
  assert.strictEqual(e.kind, 'other', '字面前綴相同不代表真的在專案內');
});

ok('★ shell 改檔也要受 projectRoot 限制', () => {
  const e = normalizeToolEvent(
    { tool: 'Bash', input: { command: 'sed -i s/a/b/ D:\\elsewhere\\evil.ts' } },
    { projectRoot: 'C:\\proj' }
  );
  assert.strictEqual(e.kind, 'other', '改專案外的檔案不該要求本專案跑測試');
});

ok('shell 改專案內的相對路徑仍算 code_change', () => {
  const e = normalizeToolEvent(
    { tool: 'Bash', input: { command: 'sed -i s/a/b/ src/a.ts' } },
    { projectRoot: 'C:\\proj' }
  );
  assert.strictEqual(e.kind, 'code_change');
});

ok('★ 判定核心已同步到 plugin（dist 不進版控，plugin 必須自足）', () => {
  const target = 'plugin/hooks/verification-core.mjs';
  assert.ok(fileExists(target), 'plugin 必須自帶判定核心，否則 marketplace 安裝後永久靜默失效');
  const synced = bodyOf(readFile(target, 'utf8'));
  const compiled = readFile('dist/core/verification.js', 'utf8');
  assert.strictEqual(synced, compiled, '判定核心與 src 不一致——請重跑 npm run build');
});

// ---------------- 落地記錄（第 1 層與 hook 共用同一份檔案）----------------
const { recordVerification, resetVerificationLog } = await import('./dist/core/verification-log.js');
const { mkdtempSync, mkdirSync, existsSync, readFileSync, rmSync } = await import('node:fs');
const { join } = await import('node:path');
const LOGDIR = mkdtempSync(join('dist', 'verify-vlog-'));
process.env.AI_CLI_STATE_DIR = LOGDIR;
const logFile = join(LOGDIR, 'verification-gate.jsonl');
const readEntries = () =>
  existsSync(logFile)
    ? readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [];

ok('記錄：寫進與 hook 同一份 verification-gate.jsonl，並標明 source', () => {
  resetVerificationLog();
  recordVerification({ pid: 101, agent: 'codex', status: 'not_observed', lastCodeChange: 'Edit a.ts' });
  const entries = readEntries();
  assert.strictEqual(entries.length, 1);
  assert.strictEqual(entries[0].source, 'ai-cli', '要能跟 hook 記的那些分得開');
  assert.strictEqual(entries[0].status, 'not_observed');
  assert.ok(entries[0].at, '要有時間戳');
});

ok('★ 記錄：同一個 pid 只記一次（wait 會反覆呼叫 getProcessResult）', () => {
  recordVerification({ pid: 101, agent: 'codex', status: 'not_observed' });
  recordVerification({ pid: 101, agent: 'codex', status: 'not_observed' });
  assert.strictEqual(readEntries().length, 1, '重複呼叫不該灌爆記錄檔');
});

ok('記錄：不同 pid 各記一筆', () => {
  recordVerification({ pid: 102, agent: 'claude', status: 'passed' });
  assert.strictEqual(readEntries().length, 2);
});

rmSync(LOGDIR, { recursive: true, force: true });

// ---------------- plugin 安裝偵測 ----------------
// 自動更新散布程式碼，不散布「已啟用」。這一段守的是「其他機器怎麼知道要裝」。
const { getPluginStatus, consumePluginNotice, PLUGIN_KEY } = await import(
  './dist/core/plugin-status.js'
);
const { writeFileSync } = await import('node:fs');
const PDIR = mkdtempSync(join('dist', 'verify-plugin-'));
const settingsFile = join(PDIR, 'settings.json');
process.env.AI_CLI_CLAUDE_SETTINGS_PATH = settingsFile;
// 也要隔離 plugins 目錄，否則會讀到這台機器真實的 installed_plugins.json。
const claudePluginsDir = join(PDIR, 'plugins');
mkdirSync(claudePluginsDir, { recursive: true });
process.env.AI_CLI_CLAUDE_PLUGINS_DIR = claudePluginsDir;
const setSettings = (obj) => writeFileSync(settingsFile, JSON.stringify(obj));
const setInstalled = (obj) =>
  writeFileSync(join(claudePluginsDir, 'installed_plugins.json'), JSON.stringify(obj));
const setMarketplaces = (obj) =>
  writeFileSync(join(claudePluginsDir, 'known_marketplaces.json'), JSON.stringify(obj));
const clearPluginFiles = () => {
  for (const f of ['installed_plugins.json', 'known_marketplaces.json']) {
    rmSync(join(claudePluginsDir, f), { force: true });
  }
};
const freshState = () => {
  const d = mkdtempSync(join(PDIR, 'state-'));
  process.env.AI_CLI_STATE_DIR = d;
  return d;
};

ok('plugin：已啟用時不提示', () => {
  clearPluginFiles();
  setSettings({ enabledPlugins: { [PLUGIN_KEY]: true } });
  const s = getPluginStatus();
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.notice, null);
});

// ★ 2026-09-08 本機實查：settings.json 不是權威來源。installed_plugins.json 列出的
// plugin 比 settings 多且帶 scope；known_marketplaces.json 有 3 個而 settings 只有 1 個。
// 只讀 settings 會把「用 project scope 裝過」的機器誤判成沒裝，然後每 3 天催一次。
ok('★ plugin：installed_plugins.json 說裝了就算裝了（settings 沒列也算）', () => {
  clearPluginFiles();
  setSettings({ enabledPlugins: {} });
  setInstalled({ version: 2, plugins: { [PLUGIN_KEY]: [{ scope: 'user', version: '1.0.0' }] } });
  const s = getPluginStatus();
  assert.strictEqual(s.enabled, true, 'settings 沒列不代表沒裝');
  assert.strictEqual(s.notice, null, '裝了就不該再催');
  assert.deepStrictEqual(s.scopes, ['user']);
});

ok('★ plugin：project scope 安裝也算已裝，不再被催', () => {
  clearPluginFiles();
  setSettings({ enabledPlugins: {} });
  setInstalled({
    version: 2,
    plugins: { [PLUGIN_KEY]: [{ scope: 'project', projectPath: 'D:\\WorkSpace\\X' }] },
  });
  const s = getPluginStatus();
  assert.strictEqual(s.enabled, true);
  assert.deepStrictEqual(s.scopes, ['project']);
});

ok('★ plugin：known_marketplaces.json 才是 marketplace 的權威來源', () => {
  clearPluginFiles();
  setSettings({ enabledPlugins: {} });
  setMarketplaces({
    'ai-cli-mcp': {
      source: { source: 'github', repo: 'moerasermax/ai-cli-mcp-source' },
      installLocation: 'C:\\x',
    },
  });
  const s = getPluginStatus();
  assert.strictEqual(s.marketplaceAdded, true, 'settings 沒有不代表沒加過');
  assert.doesNotMatch(s.notice ?? '', /marketplace add/, '加過就不該再叫人加一次');
});

ok('plugin：installed_plugins.json 存在但沒有我們的 plugin → 仍算沒裝', () => {
  clearPluginFiles();
  setSettings({ enabledPlugins: {} });
  setInstalled({ version: 2, plugins: { 'other@somewhere': [{ scope: 'user' }] } });
  const s = getPluginStatus();
  assert.strictEqual(s.enabled, false);
  assert.deepStrictEqual(s.scopes, []);
});

ok('★ plugin：檔案在但這台機器沒啟用 → 提示且給安裝指令', () => {
  setSettings({ enabledPlugins: {} });
  const s = getPluginStatus();
  assert.strictEqual(s.bundled, true, 'plugin 檔案應隨安裝存在');
  assert.strictEqual(s.enabled, false);
  assert.match(s.notice ?? '', /plugin install/);
  assert.match(s.notice ?? '', /marketplace add/, '沒加過 marketplace 時要一併給那一步');
});

ok('plugin：marketplace 已加、只差啟用 → 不重複叫人再 add 一次', () => {
  setSettings({
    enabledPlugins: {},
    extraKnownMarketplaces: { 'ai-cli-mcp': { source: { source: 'github', repo: 'moerasermax/ai-cli-mcp-source' } } },
  });
  const s = getPluginStatus();
  assert.strictEqual(s.marketplaceAdded, true);
  assert.doesNotMatch(s.notice ?? '', /marketplace add/);
  assert.match(s.notice ?? '', /plugin install/);
});

ok('★ plugin：三個來源都讀不到時不亂喊', () => {
  clearPluginFiles();
  process.env.AI_CLI_CLAUDE_SETTINGS_PATH = join(PDIR, 'nope.json');
  const s = getPluginStatus();
  assert.ok(s.reason, '要說明為什麼判斷不了');
  assert.strictEqual(s.notice, null, '讀不到就不該催人安裝——可能根本不是 Claude Code 環境');
  process.env.AI_CLI_CLAUDE_SETTINGS_PATH = settingsFile;
});

ok('plugin：settings 壞掉但 plugins 目錄讀得到 → 仍能判斷', () => {
  clearPluginFiles();
  writeFileSync(settingsFile, '{ 這不是 JSON');
  setInstalled({ version: 2, plugins: {} });
  const s = getPluginStatus();
  assert.strictEqual(s.reason, null, '有一份讀得到就不算判斷不了');
  assert.strictEqual(s.enabled, false);
  assert.ok(s.notice, '判斷得出來沒裝就該提醒');
});

ok('plugin：settings 壞掉且 plugins 目錄也沒有 → 不亂喊', () => {
  clearPluginFiles();
  writeFileSync(settingsFile, '{ 這不是 JSON');
  const s = getPluginStatus();
  assert.ok(s.reason);
  assert.strictEqual(s.notice, null);
});

const DAY = 24 * 60 * 60 * 1000;

ok('★ plugin：提示不會每次 run 都跳（間隔內只跳一次）', () => {
  clearPluginFiles();
  freshState();
  setSettings({ enabledPlugins: {} });
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0), '第一次要提示');
  assert.strictEqual(consumePluginNotice(t0), null, '同一時間不能再吵');
  assert.strictEqual(consumePluginNotice(t0 + 2 * DAY), null, '第 2 天還在間隔內');
});

ok('★ plugin：滿 3 天後會再提醒一次（不是提醒一次就永遠沉默）', () => {
  clearPluginFiles();
  freshState();
  setSettings({ enabledPlugins: {} });
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0));
  assert.ok(consumePluginNotice(t0 + 3 * DAY + 1000), '滿 3 天要再提醒');
  assert.strictEqual(consumePluginNotice(t0 + 3 * DAY + 2000), null, '提醒完又進入下一個間隔');
  assert.ok(consumePluginNotice(t0 + 6 * DAY + 3000), '再滿 3 天再提醒');
});

ok('plugin：間隔可由環境變數覆寫', () => {
  clearPluginFiles();
  freshState();
  setSettings({ enabledPlugins: {} });
  process.env.AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC = '60';
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0));
  assert.strictEqual(consumePluginNotice(t0 + 30_000), null);
  assert.ok(consumePluginNotice(t0 + 61_000), '60 秒間隔到了要再提醒');
  delete process.env.AI_CLI_PLUGIN_NOTICE_INTERVAL_SEC;
});

ok('plugin：旗標壞掉時當成沒提醒過（寧可多提也不要永遠沉默）', () => {
  clearPluginFiles();
  const dir = freshState();
  setSettings({ enabledPlugins: {} });
  writeFileSync(join(dir, 'plugin-notice.json'), '{ 壞掉的 JSON');
  assert.ok(consumePluginNotice(), '讀不懂旗標就該重新提醒');
});

ok('plugin：已啟用時清掉旗標（日後若停用會重新開始提醒）', () => {
  clearPluginFiles();
  freshState();
  setSettings({ enabledPlugins: {} });
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0));
  setSettings({ enabledPlugins: { [PLUGIN_KEY]: true } });
  assert.strictEqual(consumePluginNotice(t0 + 1000), null, '已啟用不提示');
  setSettings({ enabledPlugins: {} });
  assert.ok(consumePluginNotice(t0 + 2000), '停用後不必等滿 3 天，立刻重新開始提醒');
});

rmSync(PDIR, { recursive: true, force: true });

console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
process.exit(failures === 0 ? 0 : 1);
