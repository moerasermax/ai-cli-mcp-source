/**
 * 驗證判定的落地記錄（第 1 層）。
 *
 * 跟 plugin 的 Stop hook **寫同一份檔案**，用 `source` 區分是誰記的：
 * 派工出去的工作是 `ai-cli`，自己回合裡做的是 `hook`。兩層合起來才是完整的
 * 一台機器上的品質基線——分開存會變成兩份互不相干、誰也代表不了整體的數字。
 *
 * 這一層只負責「記下來」，不做彙總，也不往外送。跨機器基線需要明確的同步端與
 * 隱私政策，那是另一件事；在那之前，資料留在本機。
 *
 * 寫入失敗一律靜默：記錄不到是遺憾，但不能因此影響工具回傳。
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 與 file-process-service、plugin hook 同一個慣例。 */
function stateDir(): string {
  return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
}

export interface VerificationLogEntry {
  pid: number;
  agent: string;
  model?: string | null;
  status: string;
  workFolder?: string;
  lastCodeChange?: string | null;
}

/**
 * 同一個 pid 只記一次。`getProcessResult` 每次被呼叫都會重新 parse，
 * 而 wait 會反覆呼叫它——不去重的話一個工作會被記上幾十筆。
 */
const recorded = new Set<number>();

export function recordVerification(entry: VerificationLogEntry): void {
  if (recorded.has(entry.pid)) return;
  recorded.add(entry.pid);
  try {
    const dir = stateDir();
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(dir, 'verification-gate.jsonl'),
      JSON.stringify({ at: new Date().toISOString(), source: 'ai-cli', ...entry }) + '\n'
    );
  } catch {
    /* 記錄失敗不影響工具回傳 */
  }
}

/** 只給測試用：清掉去重狀態。 */
export function resetVerificationLog(): void {
  recorded.clear();
}
