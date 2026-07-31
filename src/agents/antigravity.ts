/**
 * Antigravity CLI (agy) — Google Gemini 後繼 CLI (2026/05)。
 *
 * 關鍵：agy.exe 在 stdout 不是 TTY 時會靜默不輸出。所以 win32 必須走 ConPTY
 * （spawnMode pty）。
 *
 * ★ 2026-07-31 更正：舊註解寫「模型由 CLI 內部決定，不接受 --model flag」，
 *   那是 v1.0.x 的事實。v1.1.9 實測有 `--model`、`--output-format
 *   text|json|stream-json`、`--sandbox`、`--mode plan`、
 *   `--disable-slash-commands`，而且 `agy models` 回 11 個模型。
 *   模型清單改為向 CLI 動態查詢，靜態清單降級為標示過的後備值。
 *
 * 行為 1:1 還原 dist：cli-builder.js antigravity 分支 + parsers.js parseAntigravityOutput
 * + process-service.js _startAntigravityPty。
 */

import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';

/**
 * 靜態後備清單。**只有在問不到 `agy models` 時才會被用到。**
 *
 * ★ 這份清單曾經是錯的，而且錯得沒有人看得出來：它宣稱 agy 只有四個
 *   模型、且「不接受 --model」。實測 v1.1.9 有 11 個模型（id 形如
 *   `gemini-3.6-flash-high`，還包含 `claude-sonnet-4-6`、
 *   `gpt-oss-120b-medium`——agy 自己就代理多家），而且 `--model` 早就支援。
 *
 *   所以現在的第一來源是 `discoverModels()` 去問 CLI，
 *   而這份清單對外一律標成 `builtin-fallback`。
 *   保留 'agy'/'agy-default' 是為了讓既有的 alias 路由不斷。
 */
const ANTIGRAVITY_FALLBACK_MODELS = [
  'agy',
  'agy-default',
  'gemini-3.1-pro-high',
  'gemini-3.5-flash-high',
] as const;

/** `agy models` 的逾時。它是本機讀設定，正常遠低於此。 */
const DISCOVER_TIMEOUT_MS = 5_000;

/**
 * 問 agy 現在支援哪些模型。
 *
 * 失敗一律回 null（CLI 不在、逾時、非零退出、輸出空）——
 * **不得回半套清單**，那會讓呼叫端以為問到了。
 */
function discoverModels(cliPath: string): readonly string[] | null {
  try {
    const result = spawnSync(cliPath, ['models'], {
      encoding: 'utf-8',
      timeout: DISCOVER_TIMEOUT_MS,
      windowsHide: true,
    });
    if (result.error || result.status !== 0 || typeof result.stdout !== 'string') return null;
    const models = result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      /*
        排除含空白的行：`agy models` 一行一個模型 id，帶空白的多半是
        標題或警告。寧可少列一個真模型，也不要把一句話當成模型名
        ——後者會變成選單裡一個「選了就失敗」的選項。
      */
      .filter((line) => line.length > 0 && !line.includes(' '));
    return models.length > 0 ? models : null;
  } catch {
    return null;
  }
}

/**
 * 把本框架用的模型名正規化成 agy CLI 的 `--model` 值。
 *
 * `Gemini 3.1 Pro (High)` → `gemini-3.1-pro-high`
 * `gemini-3.6-flash-high` → 原樣
 * `agy` / `agy-default`   → null（那是本框架的 alias，不是模型）
 * 認不出來的             → null（不傳 --model，回到 CLI 預設）
 *
 * 回 null 是刻意的保守：送一個 CLI 不認得的值會讓整個呼叫失敗，
 * 而不傳只是回到舊行為。**寧可少一個選項，不要多一個必定錯的呼叫。**
 */
export function normalizeAgyModel(model: string): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed === 'agy' || trimmed === 'agy-default') return null;
  const normalized = trimmed
    .toLowerCase()
    .replace(/[()]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-');
  // agy 的模型 id 只由小寫英數、點與連字號組成。其餘一律不傳。
  return /^[a-z0-9][a-z0-9.-]*$/.test(normalized) ? normalized : null;
}

/**
 * 能力 → 這個 vendor 的嚴格限制。
 *
 * **給不出保證就丟例外**（fail-closed）。放寬是最糟的失敗方式：
 * 呼叫端以為有限制、畫面上寫著有限制，而程序其實全開。
 */
const AGY_SAFE_CAPABILITIES = new Set(['fs/read', 'analysis/produce']);

function buildStrictCommand(
  input: BuildCommandInput,
  capabilities: readonly string[]
): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, sessionId } = input;
  for (const capability of capabilities) {
    if (!AGY_SAFE_CAPABILITIES.has(capability)) {
      throw new Error(
        `agy 的嚴格模式無法保證能力「${capability}」——拒絕啟動（不放寬）。`
      );
    }
  }
  /*
    與 buildCommand 的差別：**沒有 --dangerously-skip-permissions**。
      --sandbox                 終端限制
      --mode plan               不改檔案
      --disable-slash-commands  不展開使用者的 slash/skill

    ★ 誠實的邊界：agy 的 --help 沒有列出 --sandbox / --mode plan 的
      精確允許集合，也沒有等同 claude --allowedTools 的工具白名單。
      所以這裡只接受**唯讀類**能力；任何其他能力一律拒絕，
      而不是假設 plan 模式擋得住。
  */
  const args = ['--sandbox', '--mode', 'plan', '--disable-slash-commands'];
  if (sessionId) args.push('--conversation', sessionId);
  const cliModel = normalizeAgyModel(resolvedModel);
  if (cliModel !== null) args.push('--model', cliModel);
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'antigravity', prompt, resolvedModel };
}

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, sessionId } = input;
  // - agy 用 --print (-p) 做非互動單次模式
  // - --dangerously-skip-permissions 自動核准工具呼叫
  // - cwd 自動作為 workspace
  const args = ['--dangerously-skip-permissions'];
  if (sessionId) {
    args.push('--conversation', sessionId);
  }
  /*
    ★ `--model` 曾經被註解成「不支援」，那是 v1.0.x 的事實，
      到 v1.1.9 已經不成立（`agy --help` 有 --model）。

      但**不能把 resolvedModel 原樣傳過去**：既有的 alias
      （`agy-ultra` → `Gemini 3.1 Pro (High)`）用的是 agy settings.json
      的顯示寫法，而 CLI 的 `--model` 只吃 `gemini-3.1-pro-high` 這種 id。
      原樣傳會讓每一次 agy 呼叫都失敗。先正規化，認不出來就**不傳**
      ——回到「由 CLI 決定」的舊行為，而不是送一個必定錯的值。
  */
  const cliModel = normalizeAgyModel(resolvedModel);
  if (cliModel !== null) {
    args.push('--model', cliModel);
  }
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'antigravity', prompt, resolvedModel };
}

/**
 * agy --print 輸出格式（v1.0.2）：
 *   致 User
 *   ---
 *   <body 多行>
 *   ---
 * 沒有 JSON、沒有 token stats、沒有 session_id。
 */
function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  const blockMatch = trimmed.match(/^致\s*User\s*\r?\n---\r?\n([\s\S]+?)\r?\n---\s*$/);
  if (blockMatch) {
    return { message: blockMatch[1].trim() };
  }
  return { message: trimmed };
}

function resolveAntigravityLocalPath(): string {
  return process.platform === 'win32' && process.env.LOCALAPPDATA
    ? join(process.env.LOCALAPPDATA, 'agy', 'bin', 'agy.exe')
    : join(homedir(), '.agy', 'bin', 'agy');
}

export const antigravityAgent: AgentDefinition = {
  id: 'antigravity',
  models: ANTIGRAVITY_FALLBACK_MODELS,
  billingRoute: 'subscription-cli',
  discoverModels,
  // 路由：agy / agy-default / agy-* / antigravity* / *-agy / 大寫 "Gemini ..."
  // 大寫 "Gemini " 區別於 lowercase gemini-cli 模型（本框架已不支援 gemini）。
  matchesModel: (model) =>
    model === 'agy' ||
    model === 'agy-default' ||
    model.startsWith('agy-') ||
    model.startsWith('antigravity') ||
    model.endsWith('-agy') ||
    // 舊的顯示寫法（agy settings.json 風格），alias 表仍在用
    model.startsWith('Gemini ') ||
    /*
      v1.1.9 的真實 id 形如 `gemini-3.6-flash-high`。
      **刻意不收** agy 也代理的 `claude-*` / `gpt-oss-*`——那些名字
      同時屬於 claude/codex agent，靠名字猜會把使用者送到錯的 CLI。
      要指定「agy 上的 claude」請用目錄的 `antigravity/claude-sonnet-4-6`。
    */
    model.startsWith('gemini-'),
  binary: {
    envVarName: 'AGY_CLI_NAME',
    defaultCliName: 'agy',
    localInstallPath: resolveAntigravityLocalPath(),
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for antigravity (agy) models.',
  },
  buildCommand,
  buildStrictCommand,
  parseOutput,
  // agy 在 win32 非 TTY 下靜默無輸出 → 強制走 ConPTY
  win32SpawnMode: 'pty',
};
