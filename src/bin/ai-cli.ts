#!/usr/bin/env node
import { runCli } from '../app/cli.js';

/**
 * ★ `exec` **不能**用立即的 `process.exit()`。
 *
 * stdout 是 pipe 時寫入是非同步的：`process.exit()` 會在緩衝區還有資料
 * 時就終止行程，最後一個 NDJSON frame（很可能就是 terminal frame）
 * 會消失。對呼叫端而言那等於「程序結束了但沒說結果」——它只能標
 * unknown，而那是本來可以避免的資訊遺失。
 *
 * 其他子命令維持立即退出：它們印的是一次性的 JSON，且有些會有殘留的
 * 計時器/handle 讓事件迴圈不空（那正是當初加 `process.exit()` 的原因）。
 */
const isExec = process.argv[2] === 'exec';

runCli(process.argv.slice(2))
  .then((exitCode) => {
    if (isExec) {
      process.exitCode = exitCode;
      return;
    }
    process.exit(exitCode);
  })
  .catch((error: Error) => {
    process.stderr.write(`${error.message}\n`);
    if (isExec) {
      process.exitCode = 1;
      return;
    }
    process.exit(1);
  });
