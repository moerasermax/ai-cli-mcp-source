/**
 * 使用者持久化設定。放在 providers.json 同一層目錄：
 *   ~/.local/share/ai-cli/config.json
 *
 * 目前支援：
 *   {
 *     "defaultReasoningEffort": "medium",
 *     "aliasReasoningEffort": { "claude-ultra": "medium", "codex-ultra": "medium" },
 *     "aliasModel": { "codex-ultra": "gpt-5.6-terra" }
 *   }
 *
 * 設計原則：
 * - 設定檔不存在／壞掉 → 靜默退回內建預設，永遠不讓 run 因為設定檔而失敗。
 * - 以 mtime 快取，改檔後不必重啟 MCP server。
 * - 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT 優先於設定檔（方便臨時覆蓋／測試）。
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { ALLOWED_REASONING_EFFORTS } from './reasoning.js';
import { debugLog } from './debug.js';

export interface UserConfig {
  /** 所有支援 reasoning 的 agent 在未指定時套用的預設值。 */
  defaultReasoningEffort?: string;
  /** 針對特定 model/alias 的覆蓋值，優先於 defaultReasoningEffort。 */
  aliasReasoningEffort?: Record<string, string>;
  /** alias → 實際 model 的覆寫，優先於 catalog 的內建 MODEL_ALIASES。 */
  aliasModel?: Record<string, string>;
}

export const CONFIG_DIR = join(homedir(), '.local', 'share', 'ai-cli');
export const CONFIG_PATH = join(CONFIG_DIR, 'config.json');

/** 設定檔不存在時的內建行為（1:1 沿用原本 dist 的 ultra alias 預設）。 */
export const BUILTIN_ALIAS_REASONING: Record<string, string> = {
  'claude-ultra': 'max',
  'codex-ultra': 'xhigh',
};

let cache: { mtimeMs: number; config: UserConfig } | null = null;

function normalizeEffort(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toLowerCase();
  if (!normalized) return undefined;
  if (!ALLOWED_REASONING_EFFORTS.has(normalized)) {
    debugLog(`[Config] Ignoring invalid reasoning effort "${value}" from ${source}`);
    return undefined;
  }
  return normalized;
}

/**
 * model 名稱只 trim，不 lowercase：'Gemini 3.1 Pro (High)' 的大小寫有意義，
 * antigravity 的路由靠 startsWith('Gemini ') 判斷。
 */
function normalizeModelName(value: unknown, source: string): string | undefined {
  if (typeof value !== 'string') {
    debugLog(`[Config] Ignoring non-string model from ${source}`);
    return undefined;
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  return normalized;
}

/**
 * 只取自有屬性。設定檔的 map 來自 JSON.parse，原型是 Object.prototype，
 * 直接用 map[key] 取 'constructor' / 'toString' 會拿到函式而不是 undefined。
 */
function ownValue(map: Record<string, string> | undefined, key: string): string | undefined {
  if (!map || !Object.prototype.hasOwnProperty.call(map, key)) return undefined;
  const value = map[key];
  return typeof value === 'string' ? value : undefined;
}

/** 讀取（並快取）設定檔。任何錯誤都退回空設定。 */
export function loadUserConfig(): UserConfig {
  let mtimeMs: number;
  try {
    if (!existsSync(CONFIG_PATH)) {
      cache = null;
      return {};
    }
    mtimeMs = statSync(CONFIG_PATH).mtimeMs;
  } catch (error) {
    debugLog(`[Config] Failed to stat ${CONFIG_PATH}: ${(error as Error).message}`);
    return {};
  }

  if (cache && cache.mtimeMs === mtimeMs) {
    return cache.config;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
  } catch (error) {
    debugLog(`[Config] Failed to parse ${CONFIG_PATH}: ${(error as Error).message}`);
    return {};
  }
  if (!parsed || typeof parsed !== 'object') {
    debugLog(`[Config] ${CONFIG_PATH} is not a JSON object; ignoring`);
    return {};
  }

  const raw = parsed as Record<string, unknown>;
  const config: UserConfig = {};

  const defaultEffort = normalizeEffort(raw.defaultReasoningEffort, 'defaultReasoningEffort');
  if (defaultEffort) {
    config.defaultReasoningEffort = defaultEffort;
  }

  if (raw.aliasReasoningEffort && typeof raw.aliasReasoningEffort === 'object') {
    const overrides: Record<string, string> = {};
    for (const [model, value] of Object.entries(raw.aliasReasoningEffort as object)) {
      const effort = normalizeEffort(value, `aliasReasoningEffort.${model}`);
      if (effort) {
        overrides[model] = effort;
      }
    }
    if (Object.keys(overrides).length > 0) {
      config.aliasReasoningEffort = overrides;
    }
  }

  if (raw.aliasModel && typeof raw.aliasModel === 'object') {
    const overrides: Record<string, string> = {};
    for (const [alias, value] of Object.entries(raw.aliasModel as object)) {
      const target = normalizeModelName(value, `aliasModel.${alias}`);
      if (target) {
        overrides[alias] = target;
      }
    }
    if (Object.keys(overrides).length > 0) {
      config.aliasModel = overrides;
    }
  }

  cache = { mtimeMs, config };
  return config;
}

/** 讀出設定檔的原始物件（未正規化）。寫入時必須以此為基底，才不會吃掉未知欄位。 */
function readRawConfig(): Record<string, unknown> {
  try {
    if (!existsSync(CONFIG_PATH)) return {};
    const parsed: unknown = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    return parsed as Record<string, unknown>;
  } catch (error) {
    debugLog(`[Config] Failed to read raw ${CONFIG_PATH}: ${(error as Error).message}`);
    return {};
  }
}

/**
 * 以「read → patch → 原子寫回」的方式更新設定檔，回傳寫入後生效的設定。
 *
 * patch 收到的是原始 JSON 物件（不是正規化後的 UserConfig），所以使用者手寫的
 * 未知欄位會原封不動保留下來。
 */
export function updateUserConfig(patch: (raw: Record<string, unknown>) => void): UserConfig {
  const raw = readRawConfig();
  patch(raw);

  mkdirSync(CONFIG_DIR, { recursive: true });
  // tmp 檔名帶 pid：固定檔名的話，兩個 MCP server process 同時寫入會互相覆蓋
  // 對方的 tmp，其中一方的 rename 會拿到 ENOENT。
  const tmpPath = `${CONFIG_PATH}.${process.pid}.tmp`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf-8');
    renameSync(tmpPath, CONFIG_PATH);
  } catch (error) {
    // 寫入或 rename 失敗時不要留下半個 tmp 檔。
    try {
      if (existsSync(tmpPath)) unlinkSync(tmpPath);
    } catch {
      /* 清理失敗就算了，別蓋掉原始錯誤 */
    }
    throw error;
  }

  // mtime 解析度可能不足以區分同一毫秒內的兩次寫入 → 直接作廢快取。
  cache = null;
  return loadUserConfig();
}

/**
 * 決定某次 run 在「呼叫端沒指定 reasoning_effort」時該套用的預設值。
 *
 * 優先序（高 → 低）：
 *   1. 環境變數 AI_CLI_DEFAULT_REASONING_EFFORT
 *   2. config.json 的 aliasReasoningEffort[rawModel]
 *   3. config.json 的 defaultReasoningEffort
 *   4. 內建 ultra alias 預設（claude-ultra=max / codex-ultra=xhigh）
 *
 * 注意：這裡只回傳「想要的值」，是否真的套用由 caller 依 agent 能力決定。
 */
export function resolveConfiguredReasoningEffort(rawModel: string): string | undefined {
  const fromEnv = normalizeEffort(
    process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
    'AI_CLI_DEFAULT_REASONING_EFFORT'
  );
  if (fromEnv) return fromEnv;

  const config = loadUserConfig();
  const aliasOverride = ownValue(config.aliasReasoningEffort, rawModel);
  if (aliasOverride) return aliasOverride;
  if (config.defaultReasoningEffort) return config.defaultReasoningEffort;

  return ownValue(BUILTIN_ALIAS_REASONING, rawModel);
}

/**
 * 取得設定檔對某個 alias 指定的 model 覆寫。
 * 沒設定就回 undefined，由 caller 退回 catalog 的內建 alias 表。
 */
export function resolveConfiguredAliasModel(alias: string): string | undefined {
  return ownValue(loadUserConfig().aliasModel, alias);
}

/** 給 models / doctor 工具回報目前生效的設定。 */
export function describeUserConfig() {
  const config = loadUserConfig();
  return {
    path: CONFIG_PATH,
    exists: existsSync(CONFIG_PATH),
    aliasModel: config.aliasModel,
    envOverride: normalizeEffort(
      process.env.AI_CLI_DEFAULT_REASONING_EFFORT,
      'AI_CLI_DEFAULT_REASONING_EFFORT'
    ),
    defaultReasoningEffort: config.defaultReasoningEffort,
    aliasReasoningEffort: config.aliasReasoningEffort,
    builtinAliasReasoningEffort: BUILTIN_ALIAS_REASONING,
  };
}
