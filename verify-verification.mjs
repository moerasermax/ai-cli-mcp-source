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
import assert from 'node:assert';

let failures = 0;
function ok(name, fn) {
  try {
    fn();
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
ok('verificationFromAgentOutput：tools 不存在且 structured 時回 null', () => {
  assert.strictEqual(verificationFromAgentOutput({ message: 'hi' }), null);
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

ok('沒有 tools 的 claude 結果不硬掰驗證狀態', () => {
  const r = buildProcessResult(ctx(), { message: 'done' }, false);
  assert.strictEqual(r.verification, undefined, '看不到工具紀錄時不應捏造狀態');
});

// ---------------- 落地記錄（第 1 層與 hook 共用同一份檔案）----------------
const { recordVerification, resetVerificationLog } = await import('./dist/core/verification-log.js');
const { mkdtempSync, existsSync, readFileSync, rmSync } = await import('node:fs');
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
const setSettings = (obj) => writeFileSync(settingsFile, JSON.stringify(obj));
const freshState = () => {
  const d = mkdtempSync(join(PDIR, 'state-'));
  process.env.AI_CLI_STATE_DIR = d;
  return d;
};

ok('plugin：已啟用時不提示', () => {
  setSettings({ enabledPlugins: { [PLUGIN_KEY]: true } });
  const s = getPluginStatus();
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.notice, null);
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

ok('★ plugin：讀不到 Claude Code 設定時不亂喊', () => {
  process.env.AI_CLI_CLAUDE_SETTINGS_PATH = join(PDIR, 'nope.json');
  const s = getPluginStatus();
  assert.ok(s.reason, '要說明為什麼判斷不了');
  assert.strictEqual(s.notice, null, '讀不到就不該催人安裝——可能根本不是 Claude Code 環境');
  process.env.AI_CLI_CLAUDE_SETTINGS_PATH = settingsFile;
});

ok('plugin：設定檔壞掉時不亂喊', () => {
  writeFileSync(settingsFile, '{ 這不是 JSON');
  const s = getPluginStatus();
  assert.ok(s.reason);
  assert.strictEqual(s.notice, null);
});

const DAY = 24 * 60 * 60 * 1000;

ok('★ plugin：提示不會每次 run 都跳（間隔內只跳一次）', () => {
  freshState();
  setSettings({ enabledPlugins: {} });
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0), '第一次要提示');
  assert.strictEqual(consumePluginNotice(t0), null, '同一時間不能再吵');
  assert.strictEqual(consumePluginNotice(t0 + 2 * DAY), null, '第 2 天還在間隔內');
});

ok('★ plugin：滿 3 天後會再提醒一次（不是提醒一次就永遠沉默）', () => {
  freshState();
  setSettings({ enabledPlugins: {} });
  const t0 = Date.parse('2026-09-08T00:00:00Z');
  assert.ok(consumePluginNotice(t0));
  assert.ok(consumePluginNotice(t0 + 3 * DAY + 1000), '滿 3 天要再提醒');
  assert.strictEqual(consumePluginNotice(t0 + 3 * DAY + 2000), null, '提醒完又進入下一個間隔');
  assert.ok(consumePluginNotice(t0 + 6 * DAY + 3000), '再滿 3 天再提醒');
});

ok('plugin：間隔可由環境變數覆寫', () => {
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
  const dir = freshState();
  setSettings({ enabledPlugins: {} });
  writeFileSync(join(dir, 'plugin-notice.json'), '{ 壞掉的 JSON');
  assert.ok(consumePluginNotice(), '讀不懂旗標就該重新提醒');
});

ok('plugin：已啟用時清掉旗標（日後若停用會重新開始提醒）', () => {
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
