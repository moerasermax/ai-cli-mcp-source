/**
 * 突變測試：把每一個修補逐一改壞，確認「對應的斷言真的會 FAIL」。
 *
 * 這是在驗證**測試本身有沒有在測東西**。一個突變如果 SURVIVED（測試仍全過），
 * 代表那條斷言是假綠燈 —— 產品程式碼壞掉了它卻不吭聲。
 * 這個專案已經吃過三次假綠燈的虧（見 CHANGELOG 4.0.0 / 4.1.0），所以有這支工具。
 *
 * 用法：
 *   git worktree add --detach <某處>/mut HEAD
 *   # 建 node_modules junction（Windows）：
 *   #   New-Item -ItemType Junction -Path <某處>\mut\node_modules -Target <repo>\node_modules
 *   node tools/mutation-test.mjs <某處>/mut
 *
 * 突變清單在 tools/mutations.json。新增一項修補時，順手加一個對應突變 ——
 * 如果它 SURVIVED，代表你的測試沒有真的在保護那段程式碼。
 *
 * 在獨立的 git worktree 上跑，不碰主工作目錄。
 * 注意：verify-alias-config.mjs 會改寫真實的 ~/.local/share/ai-cli/config.json
 * （自帶 try/finally 還原），所以這支腳本不能與其他會動該檔的東西並行。
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const ROOT = process.argv[2];
if (!ROOT) throw new Error('usage: node mutation-test.mjs <worktree-path>');

const CONFIG = join(homedir(), '.local', 'share', 'ai-cli', 'config.json');
const CONFIG_BAK = join(ROOT, '..', 'config.json.mutbak');

/** 每個突變：改壞一處，期待某條斷言失敗。 */
const MUTATIONS = JSON.parse(readFileSync(new URL('./mutations.json', import.meta.url), 'utf-8'));

/**
 * 一律用 process.execPath 直接跑 .js/.mjs，**不要碰 npm.cmd**：
 * Node 20+ 之後 execFileSync 不能直接 spawn .cmd（EINVAL），
 * 那會讓每個突變都因為「指令根本沒跑起來」而回非零 → 全部被誤判成 KILLED。
 * （第一版 harness 就是這樣，12 個突變全是假 KILLED。）
 */
function run(args) {
  try {
    return {
      code: 0,
      out: execFileSync(process.execPath, args, { cwd: ROOT, encoding: 'utf-8', stdio: 'pipe' }),
    };
  } catch (error) {
    return { code: error.status ?? 1, out: `${error.stdout ?? ''}${error.stderr ?? ''}` };
  }
}

const TSC = join('node_modules', 'typescript', 'bin', 'tsc');
const results = [];

copyFileSync(CONFIG, CONFIG_BAK);
console.log(`使用者 config 已備份到 ${CONFIG_BAK}\n`);

// 先確認基準是綠的：基準就紅的話，後面每個突變都會「被殺」而毫無意義。
{
  const build = run([TSC]);
  const base = run(['verify-alias-config.mjs']);
  if (build.code !== 0 || base.code !== 0) {
    console.error('基準未通過，中止：', build.out.slice(-500), base.out.slice(-800));
    process.exit(1);
  }
  console.log('基準 verify-alias-config：PASS\n');
}

for (const [i, mutation] of MUTATIONS.entries()) {
  const path = join(ROOT, mutation.file);
  // worktree 的檔案是 CRLF（git autocrlf），比對前先正規化成 LF，
  // 否則多行片段永遠對不上（會被誤判成 ERROR 而不是真的跑了突變）。
  const original = readFileSync(path, 'utf-8').replace(/\r\n/g, '\n');
  if (!original.includes(mutation.from)) {
    results.push({ ...mutation, verdict: 'ERROR', detail: '找不到要替換的原始碼片段' });
    console.log(`[${i + 1}/${MUTATIONS.length}] ERROR   ${mutation.name} — 片段不存在`);
    continue;
  }

  writeFileSync(path, original.replace(mutation.from, mutation.to));
  const build = run([TSC]);
  const { code, out } =
    build.code !== 0 ? { code: -1, out: `BUILD FAILED\n${build.out}` } : run(['verify-alias-config.mjs']);
  writeFileSync(path, original);

  // 期待：這個突變讓測試失敗，而且失敗的是我們指定的那條斷言。
  const failedLines = out
    .split('\n')
    .filter((line) => line.includes('FAIL '))
    .join(' | ');
  const killedByExpected = failedLines.includes(mutation.expect);
  const verdict =
    code === -1
      ? 'BUILD_FAILED'
      : code === 0
        ? 'SURVIVED'
        : killedByExpected
          ? 'KILLED'
          : 'KILLED(其他斷言)';
  results.push({ ...mutation, verdict, detail: failedLines.slice(0, 200) });
  console.log(
    `[${i + 1}/${MUTATIONS.length}] ${verdict.padEnd(16)} ${mutation.name}` +
      (verdict.startsWith('KILLED') ? `\n${' '.repeat(23)}↳ ${failedLines.slice(0, 160)}` : '')
  );
}

// 每輪都還原了原始碼，最後再確認 worktree 是乾淨的。
const status = run('git', ['status', '--short']);
copyFileSync(CONFIG_BAK, CONFIG);

console.log('\n================ 突變測試結果 ================');
const survived = results.filter((r) => r.verdict === 'SURVIVED');
const errored = results.filter((r) => r.verdict === 'ERROR' || r.verdict === 'BUILD_FAILED');
const killedByOther = results.filter((r) => r.verdict === 'KILLED(其他斷言)');
console.log(`總計 ${results.length}：KILLED ${results.length - survived.length - errored.length}` +
  `（其中 ${killedByOther.length} 是被其他斷言抓到）、SURVIVED ${survived.length}、ERROR ${errored.length}`);
for (const r of survived) console.log(`  SURVIVED（假綠燈！）: ${r.name} — 期待 "${r.expect}" 失敗但測試全過`);
for (const r of errored) console.log(`  ERROR: ${r.name} — ${r.detail}`);
for (const r of killedByOther) console.log(`  KILLED(其他斷言): ${r.name} — 期待 "${r.expect}"，實際 ${r.detail}`);
console.log(`\nworktree git status（應為空）: ${JSON.stringify(status.out.trim())}`);
process.exitCode = survived.length > 0 || errored.length > 0 ? 1 : 0;
