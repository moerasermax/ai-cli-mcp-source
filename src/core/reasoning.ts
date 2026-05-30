/** reasoning_effort 共用驗證。 */

import type { ReasoningSupport } from '../agents/types.js';

export const ALLOWED_REASONING_EFFORTS: ReadonlySet<string> = new Set([
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
]);

/**
 * 依 agent 的 reasoning 設定驗證/正規化 reasoning_effort。
 * 回傳正規化後的小寫值，或空字串（未提供）。不合法則丟錯。
 *
 * 行為 1:1 還原 dist/cli-builder.js 的 getReasoningEffort：
 * - opencode 在 command-builder 層先擋掉（這裡不會收到 opencode）
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
      `Invalid reasoning_effort: ${rawValue}. Allowed values: low, medium, high, xhigh, max.`
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
