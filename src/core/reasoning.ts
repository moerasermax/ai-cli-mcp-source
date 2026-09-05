/** reasoning_effort 共用驗證。 */

import type { ReasoningSupport } from '../agents/types.js';

export const ALLOWED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  // ultra：2026-09-05 隨 gpt-6-astra 加入，目前只有 codex 吃（claude 到 max 為止）。
  'ultra',
]);

/**
 * 由設定檔／內建預設推導出的 effort，這個 agent 到底吃不吃。
 *
 * 兩個地方要用同一條規則：command-builder 決定「送不送」，models payload 決定「報不報」。
 * 規則若各寫一份，就會出現 codex-ultra 被重指到 opus 後、payload 回報 ultra、指令卻沒帶
 * --effort 的畫面（獨立稽核 @codex-gpt-6-astra 抓到：payload 那邊只看 supported、不看 allowed）。
 */
export function acceptsConfiguredEffort(support: ReasoningSupport, effort: string): boolean {
  if (!support.supported) return false;
  if (support.allowed && !support.allowed.has(effort)) return false;
  return true;
}

/**
 * 依 agent 的 reasoning 設定驗證/正規化 reasoning_effort。
 * 回傳正規化後的小寫值，或空字串（未提供）。不合法則丟錯。
 *
 * 行為 1:1 還原 dist/cli-builder.js 的 getReasoningEffort：
 * - 未提供 → ''
 * - 不在通用集合 → 通用錯誤
 * - agent 不支援 → agent 專屬錯誤
 * - agent 支援但值不在其子集 → agent 專屬子集錯誤
 */
export function resolveReasoningEffort(
  support: ReasoningSupport,
  rawValue: string | undefined
): string {
  if (typeof rawValue !== 'string') {
    return '';
  }
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return '';
  }
  const normalized = trimmed.toLowerCase();
  if (!ALLOWED_REASONING_EFFORTS.has(normalized)) {
    throw new Error(
      `Invalid reasoning_effort: ${rawValue}. Allowed values: low, medium, high, xhigh, max, ultra.`
    );
  }
  if (!support.supported) {
    throw new Error(
      support.unsupportedMessage || 'reasoning_effort is not supported for this agent.'
    );
  }
  if (support.allowed && !support.allowed.has(normalized)) {
    throw new Error(support.invalidMessage || 'Invalid reasoning_effort for this agent.');
  }
  return normalized;
}
