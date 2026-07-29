/**
 * Model 目錄與 alias 表。
 * 1:1 還原自實際運行的 dist/model-catalog.js（含 antigravity/kiro，無 gemini）。
 *
 * 各 agent 的 model 清單其實也定義在各自的 agents/<name>.ts，
 * 這裡彙整出對外的 models payload 與描述字串。
 */

import { listAgents, getAgent, selectAgentForModel } from '../agents/registry.js';
import { resolveDirectApiModel } from '../agents/direct-api.js';
import type { AgentId } from '../agents/types.js';
import {
  describeUserConfig,
  loadUserConfigSnapshot,
  resolveConfiguredAliasModel,
  resolveConfiguredReasoningEffort,
  type UserConfig,
} from '../core/user-config.js';

export interface ModelAliasDetail {
  name: string;
  resolvesTo: string;
  agent: AgentId;
  defaultReasoningEffort?: string;
}

/** alias 的實際生效狀態：可能被 config.json 的 aliasModel 重新指向。 */
export interface EffectiveModelAliasDetail extends ModelAliasDetail {
  /** 這個 alias 目前是走內建表還是使用者設定。 */
  source: 'builtin' | 'config';
  /** source 為 config 時，內建表原本指向的 model。 */
  builtinResolvesTo?: string;
}

/** alias → 實際 model。1:1 還原 dist。 */
export const MODEL_ALIASES: Record<string, string> = {
  'claude-ultra': 'opus',
  'codex-ultra': 'gpt-5.6-sol',
  'agy-ultra': 'Gemini 3.1 Pro (High)',
  'antigravity-ultra': 'Gemini 3.1 Pro (High)',
  'kiro-ultra': 'kiro-default',
};

/** alias 詳細資訊的內建定義。實際生效值請用 getEffectiveAliasDetails()。 */
export const MODEL_ALIAS_DETAILS: ModelAliasDetail[] = [
  { name: 'claude-ultra', resolvesTo: 'opus', agent: 'claude', defaultReasoningEffort: 'max' },
  { name: 'codex-ultra', resolvesTo: 'gpt-5.6-sol', agent: 'codex', defaultReasoningEffort: 'xhigh' },
  { name: 'agy-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
  { name: 'antigravity-ultra', resolvesTo: 'Gemini 3.1 Pro (High)', agent: 'antigravity' },
  { name: 'kiro-ultra', resolvesTo: 'kiro-default', agent: 'kiro' },
];

/** direct-api 動態 model 後端提示。 */
export const DIRECT_API_DYNAMIC_BACKEND = {
  explicitPrefixes: {
    or: 'openrouter',
    ds: 'dashscope',
  },
  explicitPattern: '<provider>-<model>',
  providersConfig: '~/.local/share/ai-cli/providers.json',
  modelsAreDynamic: true,
} as const;

/**
 * alias → 實際 model。優先序：config.json 的 aliasModel → 內建 MODEL_ALIASES → 原樣回傳。
 *
 * 這個函式是在每次 run 組指令時才呼叫（見 core/command-builder.ts），
 * 而 loadUserConfig() 每次都重讀設定檔，所以改設定檔後不必重啟 MCP server。
 */
export function isBuiltinAlias(name: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODEL_ALIASES, name);
}

export function resolveModelAlias(model: string, config?: UserConfig): string {
  const configured = resolveConfiguredAliasModel(model, config ?? loadUserConfigSnapshot());
  if (configured) return configured;
  // 必須用 hasOwnProperty：'constructor' / 'toString' 這類 prototype 上的 key
  // 用 MODEL_ALIASES[model] 取會拿到函式而不是 undefined，resolvedModel 就不是字串了。
  return isBuiltinAlias(model) ? MODEL_ALIASES[model] : model;
}

/**
 * 決定某個（已解析 alias 後的）model 由哪個 agent 負責。
 * 與 command-builder.resolveModelSelection 的路由順序一致：direct-api 的
 * provider prefix 先解析，其餘交給 registry 的 matchesModel 依序比對。
 */
export function resolveAgentIdForModel(resolvedModel: string): AgentId {
  try {
    if (resolveDirectApiModel(resolvedModel)) return 'direct-api';
  } catch {
    // resolveDirectApiModel 對「像 provider prefix 但格式錯」的輸入會丟錯；
    // 這裡只是要判斷歸屬，交給一般路由即可。
  }
  return selectAgentForModel(resolvedModel).id;
}

/**
 * 目前實際生效的 alias 清單。alias 被 config 重新指向時，agent 欄位會跟著重算 —
 * 不能沿用 MODEL_ALIAS_DETAILS 裡寫死的 agent，否則 codex-ultra 被改指到 opus 時
 * 會用錯的 agent 去判斷 reasoning 能力。
 */
export function getEffectiveAliasDetails(
  config: UserConfig = loadUserConfigSnapshot()
): EffectiveModelAliasDetail[] {
  return MODEL_ALIAS_DETAILS.map((builtin) => {
    const override = resolveConfiguredAliasModel(builtin.name, config);
    const resolvesTo = override ?? builtin.resolvesTo;
    const detail: EffectiveModelAliasDetail = {
      ...builtin,
      resolvesTo,
      agent: resolveAgentIdForModel(resolvesTo),
      source: override ? 'config' : 'builtin',
    };
    if (override) {
      detail.builtinResolvesTo = builtin.resolvesTo;
    }
    return detail;
  });
}

/** 依固定顯示順序取得各 agent 的 model 清單。 */
function modelsByAgent(): Record<AgentId, readonly string[]> {
  const out = {} as Record<AgentId, readonly string[]>;
  for (const agent of listAgents()) {
    out[agent.id] = agent.models;
  }
  return out;
}

/** run 工具描述用的「Supported models」一行字串。1:1 對齊 dist 順序。 */
export function getSupportedModelsDescription(): string {
  const byAgent = modelsByAgent();
  return [
    '"claude-ultra", "codex-ultra", "agy-ultra", "kiro-ultra"',
    ...byAgent.claude.map((m) => `"${m}"`),
    ...byAgent.codex.map((m) => `"${m}"`),
    ...byAgent.antigravity.map((m) => `"${m}"`),
    ...byAgent.forge.map((m) => `"${m}"`),
    ...byAgent['direct-api'].map((m) => `"${m}"`),
    ...byAgent.kiro.map((m) => `"${m}"`),
  ].join(', ');
}

/** model 參數的長描述。1:1 還原 dist。 */
export function getModelParameterDescription(): string {
  const byAgent = modelsByAgent();
  const all = [
    ...byAgent.claude,
    ...byAgent.codex,
    ...byAgent.antigravity,
    ...byAgent.kiro,
    ...byAgent.forge,
    ...byAgent['direct-api'],
  ];
  return `The model to use. Aliases: "claude-ultra" (auto max effort), "codex-ultra" (auto xhigh reasoning), "agy-ultra" (Antigravity CLI), "kiro-ultra" (Kiro CLI default). Standard: ${all
    .map((m) => `"${m}"`)
    .join(
      ', '
    )}. direct-api accepts provider-prefixed models using "or-<model>" for OpenRouter, "ds-<model>" for DashScope, or "<provider>-<model>" for provider keys configured in ~/.local/share/ai-cli/providers.json. "forge" is a provider key, not a Forge model family selector. Antigravity (agy) uses whichever model is configured by the agy CLI (Google AI tier default). Kiro uses its CLI default for "kiro" and "kiro-default"; model names starting with "kiro-" are passed through with --model unless they resolve to the default.`;
}

/** 所有 agent 宣告的 model 名稱（不含 direct-api 的動態 provider-prefixed 名稱）。 */
export function listKnownModels(): string[] {
  return listAgents().flatMap((agent) => [...agent.models]);
}

/**
 * 判斷一個 model 名稱是否「真的被認得」。
 *
 * 之所以需要這個：claude agent 的 matchesModel 永遠回 true（registry 的 fallback），
 * 所以打錯字的 model 不會報錯，而是被靜默送去 claude。設定 alias 時必須主動擋掉。
 */
export function isKnownModelTarget(model: string): boolean {
  // alias 名稱不是 model。alias 解析只做一層，把 alias 當 target 會直接把該名稱
  // 原樣送進 CLI（例如 kiro-ultra 會被 kiro 剝成 --model ultra）。
  if (isBuiltinAlias(model)) return false;

  // direct-api 的 provider prefix 必須真的解析得出來。只看 matchesModel 不夠：
  // 它是 startsWith('or-')/startsWith('ds-')，'or-' 這種空 model 也會過，
  // 但 run 的時候 resolveDirectApiModel 會丟錯 → 設定成功卻每次 run 都爆。
  const looksLikeDirectApi = listAgents().some(
    (agent) => agent.id === 'direct-api' && agent.matchesModel(model)
  );
  if (looksLikeDirectApi) {
    try {
      return resolveDirectApiModel(model) !== null;
    } catch {
      return false;
    }
  }
  try {
    if (resolveDirectApiModel(model)) return true;
  } catch {
    return false;
  }

  if (listKnownModels().includes(model)) return true;
  // 非 fallback agent 的 pattern 命中也算（例如任意 gpt-* 交給 codex）。
  return listAgents().some((agent) => agent.id !== 'claude' && agent.matchesModel(model));
}

/** models 工具的完整 payload。1:1 還原 dist。 */
export function getModelsPayload() {
  const byAgent = modelsByAgent();
  // 整個 payload 共用同一份 snapshot：否則每個 alias 各讀一次設定檔，
  // 中途被改動就會回報出「不同 alias 來自不同版本設定」的畫面。
  const config = loadUserConfigSnapshot();
  return {
    aliases: getEffectiveAliasDetails(config).map((alias) => {
      // 只有支援 reasoning 的 agent 才回報 effective 值，避免 agy/kiro 顯示出
      // 實際上不會被送進 CLI 的 effort。alias 被重新指向到不支援 reasoning 的
      // agent 時，內建那筆 defaultReasoningEffort 也要一併拿掉，否則會回報一個
      // 實際上不會生效的值。
      if (!getAgent(alias.agent).reasoning.supported) {
        const { defaultReasoningEffort: _ignored, ...rest } = alias;
        return rest;
      }
      return {
        ...alias,
        defaultReasoningEffort: resolveConfiguredReasoningEffort(alias.name, config),
      };
    }),
    claude: byAgent.claude,
    codex: byAgent.codex,
    antigravity: byAgent.antigravity,
    kiro: byAgent.kiro,
    forge: byAgent.forge,
    'direct-api': byAgent['direct-api'],
    dynamicModelBackends: {
      'direct-api': DIRECT_API_DYNAMIC_BACKEND,
    },
    userConfig: {
      ...describeUserConfig(config),
      builtinAliasModel: MODEL_ALIASES,
    },
  };
}
