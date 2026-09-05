#!/usr/bin/env node
import { clearNoticeOnStartup, runUpdateCli } from '../core/updater.js';

/**
 * ★ `exec` **不能**用立即的 `process.exit()`。
 *
 * stdout 是 pipe 時寫入是非同步的：`process.exit()` 會在緩衝區還有資料
 * 時就終止行程，最後一個 NDJSON frame（很可能就是 terminal frame）
 * 會消失。對呼叫端而言那等於「程序結束了但沒說結果」——它只能標
 * unknown，而那是本來可以避免的資訊遺失。
 *
 * update 也等 stdout 排空，以完整傳回 commit 清單與指令 log。
 * 其他子命令維持立即退出：它們印的是一次性的 JSON，且有些會有殘留的
 * 計時器/handle 讓事件迴圈不空（那正是當初加 `process.exit()` 的原因）。
 */
const isExec = process.argv[2] === 'exec';
const drainStdout = isExec || process.argv[2] === 'update';

async function main(): Promise<number> {
  // 更新 CLI 只載入 updater，避免在替換 dist 或 native addon 時再 import app。
  if (process.argv[2] === 'update') return runUpdateCli(process.argv.slice(3));
  const { runCli } = await import('../app/cli.js');
  // MCP 在 transport 連線後自行處理，不能把 git 放到 handshake 前面。
  if (process.argv[2] !== 'mcp') {
    const state = await clearNoticeOnStartup();
    if (state.reason?.startsWith('ai-cli 已是最新版')) process.stderr.write(`${state.reason}\n`);
  }
  return runCli(process.argv.slice(2));
}

main()
  .then((exitCode) => {
    if (drainStdout) {
      process.exitCode = exitCode;
      return;
    }
    process.exit(exitCode);
  })
  .catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    if (drainStdout) {
      process.exitCode = 1;
      return;
    }
    process.exit(1);
  });
