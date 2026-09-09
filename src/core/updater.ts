/**
 * 原始碼安裝的背景更新器。只依賴 Node 內建模組；更新子程序不能載入會被替換的
 * app / native addon。執行中的 MCP 繼續使用已載入的版本，下次啟動才生效。
 * 所有外部指令都有逾時，對外操作只回結構化結果，不把更新失敗變成服務失敗。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export type UpdatePolicy = 'on' | 'check' | 'off';
export interface UpdateOptions { repoRoot?: string; force?: boolean }
export interface UpdateCommit { sha: string; subject: string }
export interface UpdateState {
  checkedAt: string | null;
  branch: string | null;
  local: string | null;
  remote: string | null;
  behind: number;
  available: boolean;
  lastApplied: { at: string; from: string; to: string; ok: boolean; commits: UpdateCommit[]; message: string } | null;
  notice: string | null;
}
export interface CommandResult {
  command: string;
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}
export type UpdateResult = UpdateState & {
  supported: boolean;
  policy: UpdatePolicy;
  ok?: boolean;
  reason?: string;
  applied?: boolean;
  rolledBack?: boolean;
  log?: CommandResult[];
};

const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const MINUTE = 60_000;
const GIT_TIMEOUT = 20_000;
const emptyState = (): UpdateState => ({
  checkedAt: null, branch: null, local: null, remote: null, behind: 0,
  available: false, lastApplied: null, notice: null,
});
const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
const repoOf = (options: UpdateOptions): string => resolve(options.repoRoot || process.env.AI_CLI_UPDATE_REPO_ROOT || DEFAULT_ROOT);
const stateDir = (): string => process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
const statePath = (): string => join(stateDir(), 'update.json');
const lockPath = (): string => join(stateDir(), 'update.lock');

/**
 * 「程式碼過去了，但那台機器還不能用」的缺口。
 *
 * 自動更新帶得動 repo 裡的東西，帶不動每台機器自己的狀態——`providers.json` 的 API 金鑰
 * 不在版控裡，`~/.claude/plugins/` 的副本 `git pull` 也碰不到。這種事只有站在那台機器前
 * 的人做得到，而他不會知道要做，除非我們說。
 *
 * **key 是引入這件事的 commit。** 只有當這次更新真的包含那個 commit 時才附上提醒，
 * 所以每台機器只會看到一次——已經更新過的機器不會再被提醒，而這正是它跟「在提示裡
 * 寫一段固定文字」的差別：後者會變成每次更新都出現的永久噪音，然後被忽略。
 */
const POST_UPDATE_ACTIONS: ReadonlyArray<{ sha: string; action: string }> = [
  {
    sha: '4a06d74',
    action:
      '【要動手】程式碼修改驗證閘門已移除，但 Claude Code plugin 是安裝時複製到 ' +
      '~/.claude/plugins/ 的副本，git pull 碰不到它——不手動移除的話它會繼續用舊版判定擋你。\n' +
      '  在 Claude Code 輸入：/plugin uninstall ai-cli-verification-gate@ai-cli-mcp\n' +
      '                      /plugin marketplace remove ai-cli-mcp\n' +
      '  然後跑：node tools/check-gate-removed.mjs（檢查七處，全乾淨回 exit 0；只回報不改設定）',
  },
  {
    sha: 'b8f7865',
    action:
      '【要動手，想用才需要】NVIDIA 免費 API（build.nvidia.com）現在接得上了，' +
      '但金鑰與設定不在版控裡，每台機器要自己加。\n' +
      '  編 ~/.local/share/ai-cli/providers.json，加一筆 nv：\n' +
      '    base_url: https://integrate.api.nvidia.com/v1\n' +
      '    api_key : 你自己的 nvapi- 金鑰（去 build.nvidia.com 申請，免費、不用信用卡）\n' +
      '    retry   : { "max_retries": 3, "initial_delay_ms": 1000 }\n' +
      '    model_extra_body: nemotron-3.5-lightning-30b-a3b → reasoning_effort "none"、' +
      'nemotron-3-ultra-550b-a55b → "medium"、muse-glimmer-30b → max_tokens 16384\n' +
      '  ⚠️ 那個檔是整份 fail-closed，任何一筆寫壞會連 openrouter/dashscope 一起掛，先備份。\n' +
      '  實測 10/10 的三顆：nv-openai/gpt-oss-20b（最快）、' +
      'nv-nvidia/nemotron-3.5-lightning-30b-a3b（1M context）、nv-meta/muse-glimmer-30b（較難的 coding）',
  },
];

/**
 * 這次更新帶進來的 commit 裡，有哪些需要人動手的後續。
 *
 * 用 startsWith 比對短 sha：`git log` 給的是完整 sha，而上面的表寫短碼比較好讀。
 */
export function postUpdateActions(commits: ReadonlyArray<{ sha: string }>): string[] {
  return POST_UPDATE_ACTIONS.filter(({ sha }) => commits.some((c) => c.sha.startsWith(sha))).map(
    ({ action }) => action
  );
}

export function getUpdatePolicy(): UpdatePolicy {
  const value = process.env.AI_CLI_AUTO_UPDATE;
  return value === 'off' || value === 'check' ? value : 'on';
}

export function updateCheckIntervalMs(): number {
  const seconds = Number(process.env.AI_CLI_UPDATE_CHECK_INTERVAL_SEC ?? 3600);
  return Number.isInteger(seconds) && seconds > 0 && seconds <= Math.floor(2_147_483_647 / 1000)
    ? seconds * 1000 : 3_600_000;
}

function unsupportedReason(options: UpdateOptions): string | null {
  const root = repoOf(options);
  return existsSync(join(root, '.git')) && existsSync(join(root, 'package.json'))
    ? null : '此安裝不支援原始碼更新：repo 根目錄必須有 .git 與 package.json';
}

function readState(): UpdateState {
  try {
    const value = JSON.parse(readFileSync(statePath(), 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyState();
    const state = emptyState();
    for (const key of ['checkedAt', 'branch', 'local', 'remote', 'notice'] as const) {
      if (typeof value[key] === 'string') state[key] = value[key];
    }
    if (Number.isSafeInteger(value.behind) && value.behind >= 0) state.behind = value.behind;
    state.available = value.available === true;
    const last = value.lastApplied;
    if (last && ['at', 'from', 'to', 'message'].every((k) => typeof last[k] === 'string')
      && typeof last.ok === 'boolean' && Array.isArray(last.commits)
      && last.commits.every((c: UpdateCommit) => c && typeof c.sha === 'string' && typeof c.subject === 'string')) {
      state.lastApplied = last;
    }
    return state;
  } catch { return emptyState(); }
}

function writeState(state: UpdateState): string | null {
  const temp = `${statePath()}.${process.pid}.${randomUUID()}.tmp`;
  try {
    mkdirSync(stateDir(), { recursive: true });
    writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { flag: 'wx' });
    renameSync(temp, statePath());
    return null;
  } catch (error) { return `無法寫入更新狀態：${messageOf(error)}`; }
  finally { try { unlinkSync(temp); } catch {} }
}

/** 同步讀狀態，doctor/models/run 不因更新而等待 git 或網路。 */
export function getUpdateStatus(options: UpdateOptions = {}): UpdateResult {
  try {
    const reason = unsupportedReason(options);
    return reason ? { ...emptyState(), supported: false, policy: getUpdatePolicy(), reason }
      : { ...readState(), supported: true, policy: getUpdatePolicy() };
  } catch (error) {
    return { ...emptyState(), supported: false, policy: getUpdatePolicy(), reason: messageOf(error) };
  }
}

/** 讀取不消費；只有新版啟動時才清除。 */
export function consumeNotice(options: UpdateOptions = {}): string | null {
  return getUpdateStatus(options).notice;
}

/** shell 只用於 Windows npm.cmd；參數均為程式內固定值，git 參數不經 shell。 */
export function spawnUpdateCommand(root: string, binary: string, args: string[], timeoutMs: number): Promise<CommandResult> {
  return new Promise((resolveResult) => {
    const result: CommandResult = { command: [binary, ...args].join(' '), ok: false, code: null, stdout: '', stderr: '', timedOut: false };
    let timer: NodeJS.Timeout | undefined;
    let done = false;
    const finish = () => { if (!done) { done = true; clearTimeout(timer); resolveResult(result); } };
    try {
      const npmOnWindows = process.platform === 'win32' && binary === 'npm';
      const child = spawn(npmOnWindows ? (process.env.ComSpec || process.env.COMSPEC || 'cmd.exe') : binary,
        npmOnWindows ? ['/d', '/s', '/c', `"npm.cmd ${args.join(' ')}"`] : args, {
          cwd: root, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
          windowsVerbatimArguments: npmOnWindows, detached: process.platform !== 'win32',
          // 煙霧測試不啟動下一輪更新、不替仍在執行的 server 清提示；git 不等待登入互動。
          env: { ...process.env, GIT_TERMINAL_PROMPT: '0', AI_CLI_UPDATE_SKIP_STARTUP: '1' },
        });
      child.stdout.setEncoding('utf8').on('data', (s: string) => { result.stdout = (result.stdout + s).slice(-1_048_576); });
      child.stderr.setEncoding('utf8').on('data', (s: string) => { result.stderr = (result.stderr + s).slice(-1_048_576); });
      child.on('error', (error) => { result.stderr += messageOf(error); finish(); });
      child.on('close', (code) => { result.code = code; result.ok = code === 0 && !result.timedOut; finish(); });
      timer = setTimeout(() => {
        result.timedOut = true;
        result.stderr += `\n指令逾時（${timeoutMs} ms）`;
        try {
          if (process.platform === 'win32' && child.pid) {
            const killer = spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
            const killTimer = setTimeout(() => { killer.kill(); child.kill(); finish(); }, 5000);
            killer.on('error', () => { clearTimeout(killTimer); child.kill(); finish(); });
            killer.on('close', () => { clearTimeout(killTimer); finish(); });
          } else { if (child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill(); }
        } catch { child.kill(); finish(); }
      }, timeoutMs);
    } catch (error) { result.stderr = messageOf(error); finish(); }
  });
}

function isAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}

function lockIsLive(): boolean {
  try {
    const lock = JSON.parse(readFileSync(lockPath(), 'utf8'));
    const at = typeof lock.at === 'number' ? lock.at : Date.parse(lock.at);
    return Number.isFinite(at) && Date.now() - at < 30 * MINUTE && isAlive(lock.pid);
  } catch {
    // 剛 wx 成功的 writer 可能還沒寫完 pid。新空檔也要視為持鎖，不能立即搶走。
    try { return Date.now() - statSync(lockPath()).mtimeMs < 30 * MINUTE; } catch { return false; }
  }
}

function acquireLock(): { release?: () => void; reason?: string } {
  const token = randomUUID();
  try {
    mkdirSync(stateDir(), { recursive: true });
    // wx 是跨 process 的仲裁；不能先 exists 再普通 write。
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const fd = openSync(lockPath(), 'wx');
        try { writeFileSync(fd, JSON.stringify({ pid: process.pid, at: new Date().toISOString(), token })); }
        finally { closeSync(fd); }
        return { release: () => {
          try { if (JSON.parse(readFileSync(lockPath(), 'utf8')).token === token) unlinkSync(lockPath()); } catch {}
        } };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        if (lockIsLive()) return { reason: '另一個 ai-cli 更新程序仍在執行（update.lock）' };
        try { unlinkSync(lockPath()); } catch {}
      }
    }
    return { reason: '無法取得 update.lock' };
  } catch (error) { return { reason: `無法取得 update.lock：${messageOf(error)}` }; }
}

async function branchOf(root: string): Promise<string> {
  if (process.env.AI_CLI_UPDATE_BRANCH) return process.env.AI_CLI_UPDATE_BRANCH;
  const upstream = await spawnUpdateCommand(root, 'git', ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'], GIT_TIMEOUT);
  return upstream.ok && upstream.stdout.trim().includes('/') ? upstream.stdout.trim().split('/').slice(1).join('/') : 'master';
}

async function changesUrl(root: string, branch: string): Promise<string> {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    if (typeof pkg.homepage === 'string' && pkg.homepage.trim()) return pkg.homepage.trim();
  } catch {}
  const remote = await spawnUpdateCommand(root, 'git', ['remote', 'get-url', 'origin'], GIT_TIMEOUT);
  const match = remote.stdout.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return match ? `https://github.com/${match[1]}/${match[2]}/blob/${branch}/CHANGELOG.md` : 'CHANGELOG.md';
}

export async function checkForUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  if (!status.supported || status.policy === 'off') return status;
  if (!options.force && status.checkedAt && Date.now() - Date.parse(status.checkedAt) < updateCheckIntervalMs()) return status;
  if (lockIsLive()) return { ...status, reason: '更新進行中，稍後再檢查' };
  const log: CommandResult[] = [];
  try {
    const root = repoOf(options);
    const branch = await branchOf(root);
    for (const args of [['check-ref-format', '--branch', branch], ['fetch', 'origin', branch, '--quiet']]) {
      const result = await spawnUpdateCommand(root, 'git', args, GIT_TIMEOUT);
      log.push(result);
      if (!result.ok) return { ...getUpdateStatus(options), ok: false, reason: `更新檢查失敗：${result.stderr.trim()}`, log };
    }
    const values: string[] = [];
    for (const args of [['rev-parse', 'HEAD'], ['rev-parse', `origin/${branch}`], ['rev-list', '--count', `HEAD..origin/${branch}`]]) {
      const result = await spawnUpdateCommand(root, 'git', args, GIT_TIMEOUT);
      log.push(result);
      if (!result.ok) return { ...getUpdateStatus(options), ok: false, reason: `更新檢查失敗：${result.stderr.trim()}`, log };
      values.push(result.stdout.trim());
    }
    const [local, remote, count] = values;
    const behind = Number(count);
    const url = status.policy === 'check' && behind > 0 ? await changesUrl(root, branch) : null;
    if (lockIsLive()) return { ...getUpdateStatus(options), reason: '更新進行中，稍後再檢查' };
    // 網路等待後重讀，保留別的 process 剛寫入的成功紀錄與提示。
    const state: UpdateState = { ...readState(), checkedAt: new Date().toISOString(), branch, local, remote, behind, available: behind > 0 };
    const pendingRestart = state.lastApplied?.ok && state.notice === state.lastApplied.message;
    if (status.policy === 'check' && !pendingRestart) {
      state.notice = url ? `ai-cli 有新版（${local.slice(0, 7)} → ${remote.slice(0, 7)}，${behind} 個 commit），AI_CLI_AUTO_UPDATE=check 僅檢查；設為 on 後執行 ai-cli update。更新內容請至 ${url} 查看` : null;
    }
    const reason = writeState(state);
    return { ...getUpdateStatus(options), ok: !reason, ...(reason ? { reason } : {}) };
  } catch (error) { return { ...getUpdateStatus(options), ok: false, reason: messageOf(error), log }; }
}

export async function applyUpdate(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  const log: CommandResult[] = [];
  const refused = (reason: string): UpdateResult => ({ ...getUpdateStatus(options), applied: false, reason, log });
  if (!status.supported) return { ...status, applied: false };
  if (status.policy !== 'on') return refused(`AI_CLI_AUTO_UPDATE=${status.policy}，不套用更新`);
  let release: (() => void) | undefined;
  let prev: string | undefined;
  let target = '';
  let branch = '';
  let mutated = false;
  const root = repoOf(options);
  const run = async (binary: string, args: string[], timeout = GIT_TIMEOUT) => {
    const result = await spawnUpdateCommand(root, binary, args, timeout);
    log.push(result);
    return result;
  };
  const must = async (binary: string, args: string[], timeout = GIT_TIMEOUT): Promise<string> => {
    const result = await run(binary, args, timeout);
    if (!result.ok) {
      if (binary === 'npm' && args[0] === 'install' && /EPERM|EBUSY/i.test(result.stderr) && /node-pty/i.test(result.stderr)) {
        throw new Error('其他 ai-cli server 仍在執行，鎖住原生模組；關閉後再更新');
      }
      throw new Error(`${result.command} 失敗：${result.stderr.trim() || result.stdout.trim() || result.code}`);
    }
    return result.stdout.trim();
  };
  try {
    branch = await branchOf(root);
    await must('git', ['check-ref-format', '--branch', branch]);
    const preflight = async (): Promise<string | null> => {
      const dirty = await must('git', ['status', '--porcelain', '--untracked-files=no']);
      if (dirty) return '有未 commit 的追蹤檔改動，拒絕更新';
      const current = await must('git', ['branch', '--show-current']);
      if (current !== branch) return `目前分支 ${current || '(detached HEAD)'} 不是 ${branch}，拒絕更新`;
      const ancestor = await run('git', ['merge-base', '--is-ancestor', 'HEAD', `origin/${branch}`]);
      if (!ancestor.ok) return '本機含非遠端祖先的 commit，無法 fast-forward，拒絕更新';
      return null;
    };
    const reason = await preflight();
    if (reason) return refused(reason);
    const lock = acquireLock();
    if (!lock.release) return refused(lock.reason!);
    release = lock.release;
    // 在取得鎖之後重新驗證，不能用等待前讀到的 HEAD 當回滾點。
    const changed = await preflight();
    if (changed) return refused(changed);
    prev = await must('git', ['rev-parse', 'HEAD']);
    target = await must('git', ['rev-parse', `origin/${branch}`]);
    if (prev === target) return refused('ai-cli 已是最新版');
    mutated = true;
    // 明確關閉使用者 pull.rebase；只允許 fast-forward，不能把本機 commit 改寫。
    await must('git', ['-c', 'pull.rebase=false', 'pull', '--ff-only', 'origin', branch], MINUTE);
    target = await must('git', ['rev-parse', 'HEAD']);
    const files = (await must('git', ['diff', '--name-only', `${prev}..HEAD`])).split(/\r?\n/);
    if (files.some((name) => name === 'package.json' || name === 'package-lock.json')) {
      await must('npm', ['install', '--no-audit', '--no-fund'], 10 * MINUTE);
    } else { await must('npm', ['run', 'build'], 5 * MINUTE); }
    await must(process.execPath, [join(root, 'dist/bin/ai-cli.js'), 'doctor'], GIT_TIMEOUT);
    const commits = (await must('git', ['log', '--format=%H%x09%s', `${prev}..${target}`])).split(/\r?\n/).filter(Boolean).map((line) => {
      const tab = line.indexOf('\t');
      return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
    });
    const actions = postUpdateActions(commits);
    const notice = `ai-cli 已更新至最新版（${prev.slice(0, 7)} → ${target.slice(0, 7)}，${commits.length} 個 commit），請重新啟動 MCP（Claude Code：/mcp 重連）。更新內容請至 ${await changesUrl(root, branch)} 查看\n${commits.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join('\n')}${actions.length ? `\n\n這次更新有 ${actions.length} 件事需要你在這台機器上動手：\n\n${actions.join('\n\n')}` : ''}`;
    const state: UpdateState = { ...readState(), checkedAt: new Date().toISOString(), branch,
      local: target, remote: target, behind: 0, available: false,
      lastApplied: { at: new Date().toISOString(), from: prev, to: target, ok: true, commits, message: notice },
      notice,
    };
    const writeError = writeState(state);
    if (writeError) throw new Error(writeError);
    return { ...getUpdateStatus(options), applied: true, log };
  } catch (error) {
    let reason = messageOf(error);
    if (!mutated || !prev) return refused(reason);
    const reset = await run('git', ['reset', '--hard', prev], MINUTE);
    const rebuild = await run('npm', ['run', 'build'], 5 * MINUTE);
    const rolledBack = reset.ok && rebuild.ok;
    if (!rolledBack) reason += '；回滾或重新建置失敗，請查看 log 並手動修復';
    const state: UpdateState = { ...readState(), branch, local: reset.ok ? prev : target, remote: target,
      available: true, lastApplied: { at: new Date().toISOString(), from: prev, to: target, ok: false, commits: [], message: reason } };
    const writeError = writeState(state);
    if (writeError) reason += `；${writeError}`;
    return { ...getUpdateStatus(options), applied: false, rolledBack, reason, log };
  } finally { release?.(); }
}

/** 每個 process 只認第一次啟動的 HEAD，舊 server 不得因磁碟更新而冒充新版。 */
const startupChecks = new Map<string, Promise<UpdateResult>>();
export function clearNoticeOnStartup(options: UpdateOptions = {}): Promise<UpdateResult> {
  const status = getUpdateStatus(options);
  if (!status.supported || process.env.AI_CLI_UPDATE_SKIP_STARTUP === '1') return Promise.resolve(status);
  const key = `${repoOf(options)}\n${statePath()}`;
  const existing = startupChecks.get(key);
  if (existing) return existing;
  const pending = (async () => {
    const head = await spawnUpdateCommand(repoOf(options), 'git', ['rev-parse', 'HEAD'], GIT_TIMEOUT);
    if (head.ok && !lockIsLive()) {
      const state = readState();
      // 只有「這次真的清掉提示」才回報已是最新版；之後每次啟動都安靜，
      // 否則框架自動呼叫的 CLI（exec 等）每次都會在 stderr 多一行（獨立稽核 @gemini-3.1-pro 註記）。
      if (state.lastApplied?.ok && state.lastApplied.to === head.stdout.trim() && state.notice !== null) {
        const writeError = writeState({ ...state, notice: null });
        return { ...getUpdateStatus(options), reason: writeError ?? `ai-cli 已是最新版 ${head.stdout.trim().slice(0, 7)}` };
      }
    }
    return getUpdateStatus(options);
  })().catch((error) => ({ ...getUpdateStatus(options), reason: messageOf(error) }));
  startupChecks.set(key, pending);
  return pending;
}

/** bin 的 update 快速入口，不 import app，確保更新途中只使用已載入的程式碼。 */
export async function runUpdateCli(argv: string[], output = {
  stdout: (text: string) => { process.stdout.write(text); },
}): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    output.stdout('Usage: ai-cli update [--check] [--json]\nCheck origin and apply a fast-forward update; policy on/check/off is respected.\n');
    return 0;
  }
  const checked = await checkForUpdate({ force: true });
  const result = !argv.includes('--check') && checked.supported && checked.ok !== false && checked.available && checked.policy === 'on'
    ? await applyUpdate() : checked;
  output.stdout(argv.includes('--json') ? `${JSON.stringify(result)}\n`
    : `${result.reason || result.notice || (result.available ? `ai-cli 有新版（${result.behind} 個 commit）` : result.policy === 'off' ? 'ai-cli 自動更新已停用' : 'ai-cli 已是最新版')}\n`);
  return result.ok === false || result.applied === false || !result.supported ? 1 : 0;
}

/** transport 連線後呼叫。計時器不撐住 server，更新本體在隔離的 CLI 子程序執行。 */
export function scheduleBackgroundUpdates(notify: (message: string) => Promise<void>, options: UpdateOptions = {}): () => void {
  let stopped = false;
  let busy = false;
  let lastNotice: string | null = null;
  const report = async (message: string) => { if (!stopped) { try { await notify(message); } catch {} } };
  const startup = clearNoticeOnStartup(options).then(async (state) => {
    if (state.reason?.startsWith('ai-cli 已是最新版')) await report(state.reason);
  });
  const tick = async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await startup;
      const checked = await checkForUpdate(options);
      if (!stopped && checked.policy === 'on' && checked.available && checked.ok !== false) {
        // 執行目前安裝的 bin；AI_CLI_UPDATE_REPO_ROOT 僅讓測試指向暫存 clone。
        const child = await spawnUpdateCommand(repoOf(options), process.execPath,
          [join(DEFAULT_ROOT, 'dist/bin/ai-cli.js'), 'update', '--json'], 23 * MINUTE);
        if (!child.ok) {
          let reason = child.stderr.trim();
          try { reason = JSON.parse(child.stdout).reason || reason; } catch {}
          await report(`ai-cli 自動更新未套用：${reason || '更新子程序失敗'}`);
        }
      }
      const notice = consumeNotice(options);
      if (notice && notice !== lastNotice) { lastNotice = notice; await report(notice); }
    } catch (error) { await report(`ai-cli 更新檢查失敗：${messageOf(error)}`); }
    finally { busy = false; }
  };
  let interval: NodeJS.Timeout | undefined;
  const first = setTimeout(() => {
    void tick();
    interval = setInterval(() => { void tick(); }, updateCheckIntervalMs());
    interval.unref();
  }, 3000);
  first.unref();
  return () => { stopped = true; clearTimeout(first); clearInterval(interval); };
}
