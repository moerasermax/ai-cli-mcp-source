/**
 * 嚴格模式的**行為**驗證：真的叫模型寫檔，再檢查檔案在不在。
 *
 * ── 為什麼要有這一支 ──────────────────────────────────────────
 * 既有的斷言只驗「參數有沒有送出去」。2026-09-09 發現那擋不住真正的問題：
 *
 *   claude --allowedTools Read,Glob,Grep --strict-mcp-config
 *          --disable-slash-commands -p "用 Write 建立 a.txt"
 *   → 檔案真的被建立了。
 *
 * `--allowedTools` 的語意是「這些不用問」，不是「只能用這些」。參數完全正確、
 * 斷言全綠、而程序其實能寫檔——**畫面說唯讀、實際全開**，正是嚴格模式最不該有的失敗。
 *
 * 所以這一支不看參數，只看結果：叫它寫一個檔案，然後去看那個檔案在不在。
 * 工具清單哪天過期（新的寫入工具出現、vendor 改了旗標語意），這裡會紅。
 *
 * ⚠️ 會真的呼叫 claude CLI，需要登入且會用掉一點額度。CI 沒有憑證時自動跳過，
 *    而且**跳過會明講**——略過不是通過。
 *
 * 用法：node verify-strict-behaviour.mjs
 */

import '../tools/stubs/catalog-test-env.mjs';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const results = [];
let skipped = 0;
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}
function skip(name, why) {
  skipped += 1;
  console.log(`  SKIP ${name} — ${why}（略過＝沒檢查，不是通過）`);
}

const which = spawnSync(process.platform === 'win32' ? 'where' : 'which', ['claude'], { encoding: 'utf-8' });
const claudePath = which.status === 0 ? which.stdout.split(/\r?\n/)[0].trim() : '';

console.log('嚴格模式的行為驗證（真的跑一次，看檔案在不在）\n');

if (!claudePath) {
  skip('claude 嚴格模式擋得住寫入', 'PATH 上沒有 claude CLI');
} else {
  const builder = await import(pathToFileURL(join(ROOT, 'dist', 'core', 'command-builder.js')).href);
  const dir = mkdtempSync(join(tmpdir(), 'strict-behaviour-'));
  try {
    const built = builder.buildCliCommand({
      workFolder: dir,
      prompt: '用 Write 工具在目前資料夾建立 probe.txt，內容 hi。直接做，不要問我。',
      model: 'sonnet',
      cliPaths: { claude: claudePath },
      capabilities: ['fs/read', 'analysis/produce'],
    });
    const run = spawnSync(built.cliPath, built.args, {
      cwd: dir,
      input: built.stdinPrompt ?? '',
      encoding: 'utf-8',
      timeout: 240_000,
      // Windows 上 claude 是 .cmd shim，不透過 shell 直接 spawn 會起不來——
      // 而起不來的樣子跟「被擋住」一模一樣（檔案沒出現），所以這裡不能省。
      shell: process.platform === 'win32',
    });
    const created = readdirSync(dir);
    /*
      ★ 這裡曾經是一條假綠燈：第一版只斷言「檔案不存在」，而第一次跑出來的退出碼是
        `null`——CLI 被 timeout 殺掉了。檔案沒出現是因為它根本沒跑完，不是因為被擋住。
        **沒跑完的測試不算通過**，那正好就是這一支存在的理由。
        所以先確認它真的跑到結束，再看檔案在不在。
    */
    if (run.status === null) {
      skip(
        '★ 嚴格模式下模型寫不進檔案',
        `CLI 沒有正常結束（timeout 或 signal=${run.signal}），這一輪什麼都沒驗到`
      );
    } else {
      check(
        !existsSync(join(dir, 'probe.txt')),
        '★ 嚴格模式下模型寫不進檔案（不是「參數對了」，是檔案真的沒出現）',
        `退出碼 ${run.status}` + (created.length ? `；資料夾殘留：${created.join(', ')}` : '')
      );
    }
    check(
      built.args.includes('--disallowedTools'),
      '嚴格模式帶 --disallowedTools（--allowedTools 單獨用擋不住，2026-09-09 實測）'
    );
    check(
      built.args.every((a) => !/dangerous/i.test(a)),
      '嚴格模式沒有任何 --dangerously-* 旗標'
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
if (skipped > 0) {
  console.log(`\nUNKNOWN: ${results.length} passed, ${skipped} skipped — 有項目沒被檢查，這不是通過`);
  process.exit(0);
}
console.log(`\nPASS: ${results.length} passed, 0 failed`);
