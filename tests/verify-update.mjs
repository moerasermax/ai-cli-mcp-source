/**
 * 自動更新回歸：所有 fetch/pull/push 都只針對 TEMP 內的 bare origin 與 A/B clones。
 * 最小 fixture 用 node marker 代替 tsc；真實 MCP 用 slow-agent stub，不呼叫供應商。
 * 每次失敗印 FAIL <名稱>，供 mutation harness 精確辨識，不能拿任意非零 exit 當 KILLED。
 */
import '../tools/stubs/catalog-test-env.mjs';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { applyUpdate, checkForUpdate, clearNoticeOnStartup, consumeNotice, getUpdateStatus, postUpdateActions, spawnUpdateCommand } from '../dist/core/updater.js';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const TEMP = mkdtempSync(join(tmpdir(), 'ai-cli-update with spaces-'));
const TRACE = join(TEMP, 'git-trace.jsonl');
const URL = 'https://github.com/moerasermax/tkflyc-ai-cli/blob/master/CHANGELOG.md';
const savedEnv = { ...process.env };
process.env.GIT_TRACE2_EVENT = TRACE;
// 不繼承機器上的 signing/hooks/更新分支等設定；只有本機 file transport 被允許。
process.env.GIT_CONFIG_GLOBAL = join(TEMP, 'empty-gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
delete process.env.AI_CLI_UPDATE_SKIP_STARTUP;
delete process.env.AI_CLI_UPDATE_BRANCH;
let passed = 0;
let failed = 0;
let serial = 0;
const text = (path) => existsSync(path) ? readFileSync(path, 'utf8') : '';
const json = (path) => JSON.parse(readFileSync(path, 'utf8'));
const delay = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`);
  if (ok) passed++; else { failed++; if (detail) console.log(`  ${String(detail).replace(/\s+/g, ' ').slice(-1300)}`); }
}
async function scenario(name, fn) {
  try { await fn(); } catch (error) { check(name, false, error.stack ?? error); }
}
function git(cwd, ...args) {
  if (!resolve(cwd).startsWith(`${resolve(TEMP)}${process.platform === 'win32' ? '\\' : '/'}`)) throw new Error('拒絕對測試範圍以外的 repo 執行 git');
  return execFileSync('git', args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 20000, stdio: 'pipe' }).trim();
}
function commit(f, name, content = name, file = 'tracked.txt') {
  writeFileSync(join(f.b, file), content);
  git(f.b, 'add', '--', file);
  git(f.b, 'commit', '-m', name);
  git(f.b, 'push', 'origin', 'master');
  return git(f.b, 'rev-parse', 'HEAD');
}
function activate(f, policy = 'on') {
  process.env.AI_CLI_UPDATE_REPO_ROOT = f.a;
  process.env.AI_CLI_STATE_DIR = f.state;
  process.env.AI_CLI_AUTO_UPDATE = policy;
  process.env.AI_CLI_UPDATE_CHECK_INTERVAL_SEC = '3600';
  delete process.env.AI_CLI_UPDATE_BRANCH;
}
function fixture() {
  const dir = join(TEMP, String(++serial));
  const origin = join(dir, 'origin.git');
  mkdirSync(dir);
  git(dir, 'init', '--bare', '--initial-branch=master', origin);
  git(dir, 'clone', origin, 'B');
  const b = join(dir, 'B');
  git(b, 'config', 'user.name', 'Update Test');
  git(b, 'config', 'user.email', 'update@example.invalid');
  const pkg = { name: 'update-fixture', version: '1.0.0', private: true, homepage: URL,
    scripts: { build: 'node -e "require(\'./build.cjs\')"', prepare: 'node -e "require(\'./build.cjs\')"' } };
  writeFileSync(join(b, 'package.json'), JSON.stringify(pkg, null, 2));
  writeFileSync(join(b, 'package-lock.json'), JSON.stringify({ name: pkg.name, version: pkg.version, lockfileVersion: 3, requires: true, packages: { '': { name: pkg.name, version: pkg.version } } }, null, 2) + '\n');
  writeFileSync(join(b, 'build.cjs'), "const fs=require('node:fs');fs.appendFileSync('build.marker','build\\n');fs.mkdirSync('dist/bin',{recursive:true});fs.copyFileSync('doctor.cjs','dist/bin/ai-cli.js');\n");
  writeFileSync(join(b, 'doctor.cjs'), "require('node:fs').appendFileSync('doctor.marker','doctor\\n');process.exit(process.argv[2]==='doctor'?0:1);\n");
  writeFileSync(join(b, '.gitignore'), 'dist/\n*.marker\nnode_modules/\n');
  writeFileSync(join(b, 'tracked.txt'), 'initial');
  git(b, 'add', '.'); git(b, 'commit', '-m', 'initial'); git(b, 'push', '-u', 'origin', 'master');
  git(dir, 'clone', origin, 'A');
  const f = { dir, origin, a: join(dir, 'A'), b, state: join(dir, 'state'), pkg };
  mkdirSync(f.state);
  git(f.a, 'config', 'user.name', 'Update Test'); git(f.a, 'config', 'user.email', 'update@example.invalid');
  activate(f);
  return f;
}
const disk = (f) => json(join(f.state, 'update.json'));
const head = (f) => git(f.a, 'rev-parse', 'HEAD');
const marker = (f) => text(join(f.a, 'build.marker'));
const onlyGitNetwork = (trace) => trace.split('\n').filter(Boolean).map(JSON.parse)
  .filter((e) => e.event === 'start' && e.argv?.some((a) => ['fetch', 'pull', 'push'].includes(a)));

async function openMcp(f, policy = 'off') {
  const stub = join(ROOT, 'tools/stubs', process.platform === 'win32' ? 'slow-agent.cmd' : 'slow-agent.mjs');
  if (process.platform !== 'win32') chmodSync(stub, 0o755);
  const transport = new StdioClientTransport({ command: process.execPath, args: [join(ROOT, 'dist/server.js')], stderr: 'pipe', env: {
    ...process.env, AI_CLI_AUTO_UPDATE: policy, AI_CLI_UPDATE_REPO_ROOT: f.a, AI_CLI_STATE_DIR: f.state,
    CODEX_CLI_NAME: stub, CLAUDE_CLI_NAME: stub, AI_CLI_BREAKER_DISABLED: 'true', SLOW_AGENT_TOTAL_SEC: '8',
  } });
  const client = new Client({ name: 'verify-update', version: '1' }, { capabilities: {} });
  let stderr = '';
  // setEncoding 讓 Node 在內部處理跨 chunk 的多位元組字元；少了它，一個中文字被切在
  // 兩個 chunk 之間會各自解成替換字元，要比對的訊息（含中文）就永遠對不上。
  transport.stderr.setEncoding('utf8').on('data', (s) => { stderr += s; });
  const notifications = [];
  client.setNotificationHandler(LoggingMessageNotificationSchema, (n) => { notifications.push(n.params); });
  await client.connect(transport, { timeout: 10000 });
  return { client, notifications, stderr: () => stderr, call: async (name, args = {}) => {
    const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 12000 });
    if (response.isError) throw new Error(JSON.stringify(response));
    return JSON.parse(response.content[0].text);
  } };
}

try {
  await scenario('最新與兩個 commit 更新', async () => {
    const f = fixture();
    const initial = head(f);
    const fresh = await checkForUpdate();
    check('已是最新 available false', fresh.available === false && fresh.local === initial);
    const noop = await applyUpdate();
    check('已是最新不建置不 pull', noop.applied === false && !marker(f) && !noop.log.some((c) => c.command.includes(' pull ')));
    const one = commit(f, 'first release');
    const two = commit(f, 'second release');
    const checked = await checkForUpdate({ force: true });
    check('遠端兩個 commit behind 2', checked.behind === 2 && checked.available && checked.local === initial && checked.remote === two);
    const applied = await applyUpdate();
    check('套用成功且 HEAD 等於 origin', applied.applied === true && head(f) === two, JSON.stringify(applied));
    check('非依賴變動只 build 且 doctor exit 0', marker(f) === 'build\n' && text(join(f.a, 'doctor.marker')) === 'doctor\n'
      && applied.log.some((c) => c.command === 'npm run build') && !applied.log.some((c) => c.command.startsWith('npm install')));
    const state = disk(f);
    check('lastApplied 保存兩筆 commit 標題', state.lastApplied?.ok === true && state.lastApplied.from === initial && state.lastApplied.to === two
      && JSON.stringify(state.lastApplied.commits) === JSON.stringify([{ sha: two, subject: 'second release' }, { sha: one, subject: 'first release' }]));
    check('成功 notice 持續存在並含版本重連網址標題', /已更新至最新版/.test(state.notice ?? '') && state.notice.includes('/mcp') && state.notice.includes(URL)
      && state.notice.includes(initial.slice(0, 7)) && state.notice.includes('2 個 commit') && state.notice.includes('second release')
      && consumeNotice() === state.notice && consumeNotice() === state.notice);
    git(f.a, 'config', 'remote.origin.url', join(TEMP, 'does-not-exist'));
    const traceBefore = text(TRACE);
    const throttled = await checkForUpdate();
    check('節流不 fetch 且回原狀態', throttled.ok !== false && throttled.checkedAt === state.checkedAt && throttled.remote === two && text(TRACE) === traceBefore);
    const forced = await checkForUpdate({ force: true });
    check('force 確實略過節流並回結構化 fetch 錯誤', forced.ok === false && forced.log.some((c) => c.command.includes('fetch origin')));
  });
  await scenario('髒樹守門', async () => {
    const f = fixture(); const prev = head(f);
    commit(f, 'remote change'); await checkForUpdate();
    writeFileSync(join(f.a, 'tracked.txt'), 'local uncommitted work');
    const stateBefore = text(join(f.state, 'update.json'));
    const result = await applyUpdate();
    check('髒樹未 commit 拒絕且完全不動', result.applied === false && /未 commit/.test(result.reason) && head(f) === prev
      && text(join(f.a, 'tracked.txt')) === 'local uncommitted work' && !marker(f) && !existsSync(join(f.state, 'update.lock'))
      && text(join(f.state, 'update.json')) === stateBefore, JSON.stringify(result));
  });
  await scenario('非 ff 與錯誤分支守門', async () => {
    const f = fixture();
    writeFileSync(join(f.a, 'local.txt'), 'local'); git(f.a, 'add', '.'); git(f.a, 'commit', '-m', 'local commit');
    const prev = head(f);
    commit(f, 'remote fork'); await checkForUpdate();
    const result = await applyUpdate();
    check('非祖先在 pull 前拒絕且不回滾', result.applied === false && /fast-forward/.test(result.reason) && result.rolledBack === undefined
      && head(f) === prev && !result.log.some((c) => / pull |reset --hard/.test(c.command)) && !marker(f), JSON.stringify(result));
    git(f.a, 'checkout', '-b', 'developer');
    process.env.AI_CLI_UPDATE_BRANCH = 'master';
    const wrong = await applyUpdate();
    check('目前分支不同就拒絕', wrong.applied === false && /目前分支/.test(wrong.reason) && head(f) === prev);
    delete process.env.AI_CLI_UPDATE_BRANCH;
  });
  await scenario('build 失敗回滾', async () => {
    const f = fixture(); const prev = head(f);
    commit(f, 'broken build', 'process.exit(1);', 'build.cjs'); await checkForUpdate();
    const result = await applyUpdate();
    check('build 失敗回滾並重新 build', result.applied === false && result.rolledBack === true && head(f) === prev
      && marker(f) === 'build\n' && result.log.some((c) => c.command === `git reset --hard ${prev}` && c.ok), JSON.stringify(result));
    check('回滾記錄失敗且釋放鎖', disk(f).lastApplied?.ok === false && disk(f).available && !existsSync(join(f.state, 'update.lock')));
  });
  await scenario('依賴變動 prepare 與 smoke 回滾', async () => {
    const f = fixture();
    commit(f, 'package metadata', JSON.stringify({ ...f.pkg, description: 'new release' }), 'package.json'); await checkForUpdate();
    const result = await applyUpdate();
    check('package 變動 npm install 經 prepare 建置', result.applied === true && marker(f) === 'build\n'
      && result.log.some((c) => c.command === 'npm install --no-audit --no-fund' && c.ok), JSON.stringify(result));
    const prev = head(f);
    commit(f, 'broken smoke', 'process.exit(1);', 'doctor.cjs'); await checkForUpdate({ force: true });
    const smoke = await applyUpdate();
    check('doctor 非零回滾與 rebuild', smoke.applied === false && smoke.rolledBack === true && head(f) === prev && marker(f) === 'build\nbuild\nbuild\n', JSON.stringify(smoke));
  });
  await scenario('原生模組被鎖', async () => {
    const f = fixture(); const prev = head(f);
    const locked = { ...f.pkg, scripts: { ...f.pkg.scripts, prepare: 'node -e "console.error(\'EPERM node_modules/node-pty/build/pty.node\');process.exit(1)"' } };
    commit(f, 'locked native install', JSON.stringify(locked), 'package.json'); await checkForUpdate();
    const result = await applyUpdate();
    check('node-pty EPERM 安裝失敗說明並回滾', result.applied === false && result.rolledBack === true && head(f) === prev
      && result.reason === '其他 ai-cli server 仍在執行，鎖住原生模組；關閉後再更新', JSON.stringify(result));
  });
  await scenario('鎖與殘留鎖', async () => {
    const f = fixture(); const prev = head(f);
    const next = commit(f, 'lock release'); await checkForUpdate();
    const path = join(f.state, 'update.lock');
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }));
    const locked = await applyUpdate();
    check('活 pid 鎖拒絕更新', locked.applied === false && /update.lock/.test(locked.reason) && head(f) === prev && !marker(f));
    const deadPid = Number(execFileSync(process.execPath, ['-e', 'console.log(process.pid)'], { encoding: 'utf8' }));
    writeFileSync(path, JSON.stringify({ pid: deadPid, at: new Date().toISOString() }));
    const stale = await applyUpdate();
    check('不存在 pid 殘留鎖照常更新', stale.applied === true && head(f) === next && !existsSync(path), JSON.stringify(stale));
    commit(f, 'expired lock release'); await checkForUpdate({ force: true });
    writeFileSync(path, JSON.stringify({ pid: process.pid, at: new Date(Date.now() - 31 * 60000).toISOString() }));
    const expired = await applyUpdate();
    check('超過三十分鐘的鎖可覆蓋', expired.applied === true && !existsSync(path));
    commit(f, 'concurrent release'); await checkForUpdate({ force: true });
    const before = marker(f);
    const pair = await Promise.all([applyUpdate(), applyUpdate()]);
    check('同時更新只有一個套用', pair.filter((r) => r.applied).length === 1 && marker(f) === `${before}build\n`, JSON.stringify(pair));
  });
  await scenario('check 與 off 政策', async () => {
    const f = fixture(); const prev = head(f);
    commit(f, 'check release'); activate(f, 'check');
    const checked = await checkForUpdate(); const refused = await applyUpdate();
    check('check 政策只寫狀態和提示不套用', checked.available && checked.notice?.includes('有新版') && checked.notice.includes(URL)
      && refused.applied === false && head(f) === prev && !marker(f) && existsSync(join(f.state, 'update.json')));
    activate(f, 'off'); git(f.a, 'config', 'remote.origin.url', join(TEMP, 'missing-off-origin'));
    const before = text(TRACE); const stateBefore = text(join(f.state, 'update.json'));
    const off = await checkForUpdate({ force: true }); const offApply = await applyUpdate();
    check('off 政策完全不 fetch 不改狀態', off.policy === 'off' && off.ok !== false && offApply.applied === false
      && text(TRACE) === before && text(join(f.state, 'update.json')) === stateBefore && !marker(f));
  });
  await scenario('新版啟動清除', async () => {
    const f = fixture(); const prev = head(f);
    // 先鎖住舊 process 的啟動判斷，再由磁碟模擬新版已安裝。
    await clearNoticeOnStartup();
    commit(f, 'restart release'); await checkForUpdate(); await applyUpdate();
    const state = disk(f);
    await clearNoticeOnStartup();
    check('舊 process 重複啟動清除函式仍保留 notice', disk(f).notice === state.notice && state.notice !== null);
    // 新的模組實例代表全新的 process 啟動，只讀這個 fixture 的 HEAD。
    const restarted = await import(`../dist/core/updater.js?restart=${serial}`);
    const result = await restarted.clearNoticeOnStartup();
    check('新版 HEAD 等於 lastApplied.to 清 notice', result.notice === null && disk(f).notice === null && /ai-cli 已是最新版/.test(result.reason)
      && disk(f).lastApplied.from === prev);
    const secondRestart = await import(`../dist/core/updater.js?secondRestart=${serial}`);
    const again = await secondRestart.clearNoticeOnStartup();
    check('提示已清除後再次啟動不再重複回報', again.reason === undefined && again.notice === null, JSON.stringify(again));
  });
  await scenario('不支援安裝與壞狀態', async () => {
    const f = fixture();
    writeFileSync(join(f.state, 'update.json'), '{invalid');
    check('壞狀態當空', getUpdateStatus().notice === null && getUpdateStatus().checkedAt === null);
    const checked = await checkForUpdate();
    check('壞狀態可以重新檢查', checked.available === false && checked.local === head(f));
    const unsupported = await checkForUpdate({ repoRoot: f.dir, force: true });
    const refused = await applyUpdate({ repoRoot: f.dir });
    check('沒有 .git package.json 不支援', unsupported.supported === false && refused.supported === false && !!refused.reason);
    const missing = await spawnUpdateCommand(f.a, join(TEMP, 'no-such-command'), [], 1000);
    const timeout = await spawnUpdateCommand(f.a, process.execPath, ['-e', 'setInterval(()=>{},1000)'], 100);
    check('spawn 錯誤與逾時回結構化結果', missing.ok === false && !!missing.stderr && timeout.timedOut && !timeout.ok);
  });
  await scenario('CLI update check 與 doctor', async () => {
    const f = fixture(); const prev = head(f); commit(f, 'CLI release');
    const cli = async (args) => spawnUpdateCommand(ROOT, process.execPath, [join(ROOT, 'dist/bin/ai-cli.js'), ...args], 30000);
    const checked = await cli(['update', '--check', '--json']);
    check('CLI --check JSON 只檢查', checked.ok && JSON.parse(checked.stdout).behind === 1 && head(f) === prev && !marker(f), checked.stderr);
    const updated = await cli(['update', '--json']);
    check('CLI update JSON 套用成功', updated.ok && JSON.parse(updated.stdout).applied === true, updated.stdout + updated.stderr);
    const doctor = await cli(['doctor']);
    check('CLI doctor 含 update 區塊', doctor.ok && JSON.parse(doctor.stdout).update?.notice?.includes('/mcp'), doctor.stdout + doctor.stderr);
    const help = await cli(['--help']);
    check('CLI help 列出 update', help.ok && /update.*--check.*--json/.test(help.stdout));
  });
  await scenario('MCP notice 回傳契約', async () => {
    const f = fixture(); activate(f, 'off');
    const notice = `ai-cli 已更新至最新版（aaaaaaa → bbbbbbb，2 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。更新內容請至 ${URL} 查看\nbbbbbbb example`;
    writeFileSync(join(f.state, 'update.json'), JSON.stringify({ notice }));
    const trace = text(TRACE);
    const server = await openMcp(f);
    let pid;
    try {
      const doctor = await server.call('doctor');
      check('MCP doctor 有 update.notice', doctor.update?.notice === notice && doctor.update.policy === 'off');
      const run = await server.call('run', { prompt: 'Reply PONG', model: 'gpt-5.5', workFolder: f.a }); pid = run.pid;
      check('MCP run 啟動回傳 updateNotice', run.updateNotice === notice && Number.isSafeInteger(pid) && run.status === 'started' && typeof run.message === 'string', JSON.stringify(run));
      const models = await server.call('models');
      check('MCP models payload 含 updateNotice', models.updateNotice === notice);
      check('MCP list_processes 仍為陣列', Array.isArray(await server.call('list_processes')));
      const waited = await server.call('wait', { pids: [pid], timeout: 1 });
      check('MCP wait 仍為陣列且保留 liveness', Array.isArray(waited) && waited[0].liveness?.alive === true);
      await delay(3200);
      check('MCP off 連背景 timer 都不 fetch', onlyGitNetwork(text(TRACE).slice(trace.length)).length === 0 && disk(f).notice === notice);
    } finally {
      if (pid) await server.call('wait', { pids: [pid], timeout: 10 }).catch(() => {});
      await server.client.close();
    }
  });
  await scenario('MCP 背景更新與重啟', async () => {
    const f = fixture(); const prev = head(f); const target = commit(f, 'background release');
    const start = performance.now(); const server = await openMcp(f, 'on');
    try {
      await server.client.listTools();
      check('背景更新不阻塞 MCP 啟動', performance.now() - start < 1500 && head(f) === prev);
      const deadline = Date.now() + 30000;
      while (!getUpdateStatus().lastApplied && Date.now() < deadline) await delay(200);
      const state = disk(f);
      check('MCP 背景子程序自動完成更新', state.lastApplied?.ok === true && state.lastApplied.to === target && marker(f) === 'build\n', JSON.stringify(state));
      const noticeDeadline = Date.now() + 5000;
      while (!server.notifications.some((n) => n.data === state.notice) && Date.now() < noticeDeadline) await delay(100);
      check('背景完成 stderr 與 warning notification', server.stderr().includes('已更新至最新版')
        && server.notifications.some((n) => n.level === 'warning' && n.data === state.notice));
      check('背景完成後舊 MCP 持續提示', (await server.call('doctor')).update.notice === state.notice && state.notice !== null);
    } finally { await server.client.close(); }
    const restarted = await openMcp(f, 'off');
    try {
      /*
        兩個條件都要等，不能只等 notice。

        updater 是「先清 notice（寫檔）、再 report（印 stderr）」兩個動作，
        所以 notice 變 null 的時候 stderr 常常還沒寫出來。舊版只等 notice 就斷言，
        實測 4 次跑 2 次失敗——那不是偶發，是等待條件漏了一半。
      */
      const expected = `ai-cli 已是最新版 ${target.slice(0, 7)}`;
      const deadline = Date.now() + 5000;
      while ((disk(f).notice || !restarted.stderr().includes(expected)) && Date.now() < deadline) await delay(50);
      check('重啟 MCP 清提示並印新版 SHA', disk(f).notice === null && restarted.stderr().includes(expected));
    } finally { await restarted.client.close(); }
  });
} finally {
  for (const key of Object.keys(process.env)) if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  rmSync(TEMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

// ---- 更新完畢後需要人動手的提醒（POST_UPDATE_ACTIONS）----
// 自動更新帶得動程式碼，帶不動每台機器自己的狀態：providers.json 的金鑰不在版控裡、
// ~/.claude/plugins/ 的副本 git pull 碰不到。這種事只有人做得到，而他不會知道要做。
{
  const full = (short) => short + "0".repeat(40 - short.length);
  const gate = full("4a06d74");
  const nvidia = full("b8f7865");

  check("帶進閘門移除的 commit 時，提醒要移除 plugin",
    postUpdateActions([{ sha: gate }]).length === 1 &&
    postUpdateActions([{ sha: gate }])[0].includes("plugin uninstall"));

  check("★ 帶進 NVIDIA 那個 commit 時，提醒要自己加 provider",
    postUpdateActions([{ sha: nvidia }]).length === 1 &&
    postUpdateActions([{ sha: nvidia }])[0].includes("providers.json") &&
    postUpdateActions([{ sha: nvidia }])[0].includes("nvapi-"));

  check("兩個都帶進來就給兩則", postUpdateActions([{ sha: gate }, { sha: nvidia }]).length === 2);

  // 這條是整個機制的重點：已經更新過的機器不該再被提醒，否則會變成永久噪音而被忽略。
  check("★ 不相關的 commit 不給提醒（不能變成每次都出現的固定文字）",
    postUpdateActions([{ sha: full("deadbee") }]).length === 0);

  check("沒有 commit 時不給提醒", postUpdateActions([]).length === 0);

  // 短碼比對必須是前綴，不能是「包含」——否則任何含有該片段的 sha 都會誤中。
  check("短碼只比對前綴，不是任意位置",
    postUpdateActions([{ sha: "00000004a06d74" + "0".repeat(26) }]).length === 0);
}

console.log(`PASS: ${passed} passed, ${failed} failed`);
process.exitCode = failed ? 1 : 0;
