/**
 * 第 2 層 Stop hook 的行為驗證（不啟動 Claude Code，直接餵假 transcript 與假 hook 事件）。
 * 重點在「該擋的擋、不該擋的一次都不擋、而且永遠不會擋第二次」。
 * 狀態目錄用 AI_CLI_STATE_DIR 隔離到 dist 底下，完全不碰使用者目錄。
 * 執行：npm run build && node verify-gate-hook.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, cpSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
mkdirSync(join(ROOT, 'dist'), { recursive: true });
const TEMP = mkdtempSync(join(ROOT, 'dist', 'verify-gate-'));
const HOOK = join(ROOT, 'plugin', 'hooks', 'verification-gate.mjs');

let failures = 0;
function check(name, condition, detail = '') {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${name}`);
  if (!condition) {
    failures++;
    if (detail) console.log(`        ${String(detail).replace(/\s+/g, ' ').slice(0, 500)}`);
  }
}

// ---- 造假 transcript ----
const userPrompt = (text) => ({ type: 'user', message: { role: 'user', content: text } });
const assistantTools = (...tools) => ({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: tools.map((t, i) => ({ type: 'tool_use', id: `t${i}`, name: t.name, input: t.input })),
  },
});
const toolResults = (...results) => ({
  type: 'user',
  message: {
    role: 'user',
    content: results.map((r) => ({
      type: 'tool_result',
      tool_use_id: r.id,
      content: r.content ?? 'ok',
      ...(r.is_error ? { is_error: true } : {}),
    })),
  },
});
const edit = (p) => ({ name: 'Edit', input: { file_path: p } });
const bash = (cmd) => ({ name: 'Bash', input: { command: cmd } });

function writeTranscript(name, lines) {
  const p = join(TEMP, `${name}.jsonl`);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

function runHookAt(hookPath, payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [hookPath], {
      env: { ...process.env, AI_CLI_STATE_DIR: join(TEMP, 'state'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // hook 的 JSON reason 全是中文，跨 chunk 切斷會讓 JSON.parse 失敗或內容變形。
    child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
  });
}

/** 跑 repo 內的那份 hook（大多數測試用這個）。 */
const runHook = (payload, env = {}) => runHookAt(HOOK, payload, env);

/** 讀 hook 寫下的判定紀錄。多個測試共用同一份，用 session id 過濾。 */
function readLog() {
  const p = join(TEMP, 'state', 'verification-gate.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return {};
      }
    });
}

function decisionOf(stdout) {
  if (!stdout.trim()) return null;
  try {
    return JSON.parse(stdout.trim());
  } catch {
    return { parseError: stdout };
  }
}

const tests = [];
const test = (name, fn) => tests.push([name, fn]);

test('改了程式碼卻沒驗證 → 擋下來', async () => {
  const t = writeTranscript('unverified', [
    userPrompt('幫我修一下這個 bug'),
    assistantTools(edit('src/a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's1' });
  const d = decisionOf(r.stdout);
  check('擋下未驗證的程式碼修改', d?.decision === 'block', r.stdout || r.stderr);
  check('擋下時說明是哪個檔案', /src\/a\.ts/.test(d?.reason ?? ''), d?.reason);
  check('擋下時 exit code 仍為 0', r.code === 0, `code=${r.code}`);
});

test('改了程式碼且驗證通過 → 放行', async () => {
  const t = writeTranscript('verified', [
    userPrompt('幫我修一下'),
    assistantTools(edit('src/a.ts'), bash('npm test')),
    toolResults({ id: 't0' }, { id: 't1', content: 'All tests passed' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's2' });
  check('驗證過就不擋', decisionOf(r.stdout) === null, r.stdout);
});

test('驗證失敗 → 也要擋一次，並如實記成 failed', async () => {
  // 輸出文字刻意不含任何失敗字樣：這樣 is_error 是判定失敗的**唯一**資訊來源。
  // 若 hook 沒把 is_error 轉成 exit_code，這裡會被誤判成 passed，於是不擋。
  const t = writeTranscript('failed', [
    userPrompt('幫我修一下'),
    assistantTools(edit('src/a.ts'), bash('npm test')),
    toolResults({ id: 't0' }, { id: 't1', content: 'done', is_error: true }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's3' });
  const d = decisionOf(r.stdout);
  // 這是完成閘門，不是提醒：模型看得到測試失敗，仍可能回一句「改好了」就結束。
  check('驗證失敗也要擋一次', d?.decision === 'block', r.stdout);
  check('擋下時說明是驗證失敗', /失敗了/.test(d?.reason ?? ''), d?.reason);
  const entry = readLog().find((l) => l.session === 's3');
  check(
    '如實記成 failed 而不是 passed',
    entry?.status === 'failed',
    `實際記到 ${JSON.stringify(entry)}`
  );
});

test('只改文件 → 不擋', async () => {
  const t = writeTranscript('docs', [
    userPrompt('更新 README'),
    assistantTools(edit('README.md')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's4' });
  check('只改文件不擋', decisionOf(r.stdout) === null, r.stdout);
});

test('只是問問題 → 不擋', async () => {
  const t = writeTranscript('qa', [
    userPrompt('這段程式在做什麼？'),
    assistantTools({ name: 'Read', input: { file_path: 'src/a.ts' } }),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's5' });
  check('純問答不擋', decisionOf(r.stdout) === null, r.stdout);
});

test('先驗證再改程式碼 → 仍要擋（順序陷阱）', async () => {
  const t = writeTranscript('stale', [
    userPrompt('幫我改一下'),
    assistantTools(bash('npm test'), edit('src/a.ts')),
    toolResults({ id: 't0', content: 'All tests passed' }, { id: 't1' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's6' });
  const d = decisionOf(r.stdout);
  check('修改前跑的測試不算數', d?.decision === 'block', r.stdout);
  check('說明有過期的驗證', /不算數/.test(d?.reason ?? ''), d?.reason);
});

test('stop_hook_active → 一律放行（防無限迴圈）', async () => {
  const t = writeTranscript('loop', [
    userPrompt('幫我改一下'),
    assistantTools(edit('src/a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's7', stop_hook_active: true });
  check('第二次不再擋', decisionOf(r.stdout) === null, r.stdout);
  const entry = readLog().find((l) => l.session === 's7');
  // 不可記成 waived：waived 的定義是「有明確記錄的豁免理由」，而 hook 無法
  // 可靠判斷模型是否真的寫了理由。照記 waived 會讓紀錄說謊。
  check(
    '放行時誠實記下原狀態，不謊稱 waived',
    entry?.status === 'not_observed',
    `實際記到 ${JSON.stringify(entry)}`
  );
  check(
    '標明是擋過之後才放行的',
    entry?.gate === 'allow-after-block',
    `實際 gate=${entry?.gate}`
  );
});

test('回合邊界：只看最後一個使用者指令之後的事件', async () => {
  const t = writeTranscript('turns', [
    userPrompt('第一輪：改程式'),
    assistantTools(edit('src/a.ts')),
    toolResults({ id: 't0' }),
    userPrompt('第二輪：只是問個問題'),
    assistantTools({ name: 'Read', input: { file_path: 'src/a.ts' } }),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's8' });
  check('上一輪的未驗證修改不會擋住這一輪', decisionOf(r.stdout) === null, r.stdout);
});

test('transcript 不存在 → 不擋、exit 0', async () => {
  const r = await runHook({ transcript_path: join(TEMP, 'nope.jsonl'), session_id: 's9' });
  check('讀不到 transcript 不擋', decisionOf(r.stdout) === null, r.stdout);
  check('讀不到 transcript 仍 exit 0', r.code === 0, `code=${r.code}`);
});

test('壞掉的 stdin → 不擋、exit 0', async () => {
  const child = spawn(process.execPath, [HOOK], {
    env: { ...process.env, AI_CLI_STATE_DIR: join(TEMP, 'state') },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  child.stdout.setEncoding('utf8').on('data', (d) => (stdout += d));
  child.stdin.end('{ this is not json');
  const code = await new Promise((res) => child.on('close', res));
  check('壞 JSON 不擋', stdout.trim() === '', stdout);
  check('壞 JSON 仍 exit 0', code === 0, `code=${code}`);
});

test('沒有 transcript_path → 不擋、exit 0', async () => {
  const r = await runHook({ session_id: 's10' });
  check('缺欄位不擋', decisionOf(r.stdout) === null, r.stdout);
  check('缺欄位仍 exit 0', r.code === 0, `code=${r.code}`);
});

test('★ 只改工作目錄外的暫存腳本 → 不擋', async () => {
  // 真實 transcript 實測抓到的誤報：分析用的一次性 .mjs 寫在暫存目錄，
  // 被當成專案程式碼而要求驗證。那種腳本本來就沒有測試可跑。
  const t = writeTranscript('scratch', [
    userPrompt('幫我算一下這批資料'),
    assistantTools(edit('D:\\Temp\\scratch\\probe.mjs')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({
    transcript_path: t,
    session_id: 's12',
    cwd: 'C:\\Users\\Moera\\ai-cli-mcp-source',
  });
  check('暫存腳本不擋', decisionOf(r.stdout) === null, r.stdout);
});

test('工作目錄內的程式碼修改 → 照擋', async () => {
  const t = writeTranscript('inproject', [
    userPrompt('改一下'),
    assistantTools(edit('C:\\Users\\Moera\\ai-cli-mcp-source\\src\\a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({
    transcript_path: t,
    session_id: 's13',
    cwd: 'C:\\Users\\Moera\\ai-cli-mcp-source',
  });
  check('專案內的修改仍會被擋', decisionOf(r.stdout)?.decision === 'block', r.stdout);
});

test('shell 改程式碼也算數（sed -i）', async () => {
  const t = writeTranscript('shell', [
    userPrompt('用 sed 改一下'),
    assistantTools(bash('sed -i s/a/b/ src/a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's11' });
  check('sed -i 改程式碼會被擋', decisionOf(r.stdout)?.decision === 'block', r.stdout);
});

test('★ 模擬 marketplace 安裝：複製到沒有 dist 的位置後仍要能擋', async () => {
  /*
    Claude Code 安裝 plugin 的方式是把 marketplace.json 指定的 source 目錄
    （我們是 ./plugin）完整複製到 ~/.claude/plugins/cache/<mkt>/<plugin>/<ver>/。
    那個位置沒有 repo 的 dist/，也回溯不到 ai-cli 的安裝。

    2026-09-08 codex 稽核抓到：hook 原本 import ../../dist/core/verification.js，
    在真實安裝條件下必然找不到，而「找不到就放行」讓它不留痕跡地永久失效。
    這條測試就是守這件事——它是整個第 2 層最容易無聲回歸的地方。
  */
  const installed = join(TEMP, 'fake-cache', 'ai-cli-mcp', 'ai-cli-verification-gate', '1.0.0');
  mkdirSync(installed, { recursive: true });
  cpSync(join(ROOT, 'plugin'), installed, { recursive: true });

  check('判定核心有跟著被複製', existsSync(join(installed, 'hooks', 'verification-core.mjs')));
  check('安裝位置沒有 dist/', !existsSync(join(installed, 'dist')));
  check('上兩層也沒有 dist/', !existsSync(join(installed, '..', '..', 'dist')));

  const t = writeTranscript('installed', [
    userPrompt('幫我改一下'),
    assistantTools(edit('C:\\proj\\src\\a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const hookPath = join(installed, 'hooks', 'verification-gate.mjs');
  const r = await runHookAt(hookPath, { transcript_path: t, session_id: 'inst', cwd: 'C:\\proj' });
  check('★ 安裝後的 hook 仍會擋', decisionOf(r.stdout)?.decision === 'block',
    `exit=${r.code} out=${r.stdout.slice(0, 200)} err=${r.stderr.slice(0, 200)}`);

  // 對照組：改回舊寫法，確認它在同樣環境下靜默失效——證明這條保護不是多餘的。
  const oldHook = join(installed, 'hooks', 'old-style.mjs');
  const src = readFileSync(hookPath, 'utf8');
  const reverted = src.replace(
    "    return await import(pathToFileURL(join(HERE, 'verification-core.mjs')).href);",
    "    return await import(pathToFileURL(join(HERE, '..', '..', 'dist', 'core', 'verification.js')).href);"
  );
  check('對照組確實改到 import 路徑', reverted !== src);
  writeFileSync(oldHook, reverted);
  const r2 = await runHookAt(oldHook, { transcript_path: t, session_id: 'inst2', cwd: 'C:\\proj' });
  check('舊寫法在安裝後靜默失效（所以上面那條保護是必要的）',
    decisionOf(r2.stdout) === null && r2.code === 0, r2.stdout);
});

test('★ marketplace/plugin manifest 必要欄位齊全（缺了會安裝靜默失敗）', async () => {
  /*
    2026-09-08 實際踩到：marketplace.json 少了 id，plugins[0] 少了 version，
    `/plugin install` 完全沒有輸出也沒有安裝——不報錯、不提示，就是沒發生。
    補齊欄位後才裝得起來。這條測試守住那些欄位，避免同樣的靜默失敗重演。
  */
  const mkt = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'marketplace.json'), 'utf8'));
  for (const field of ['name', 'id', 'owner', 'plugins']) {
    check(`marketplace.json 有 ${field}`, mkt[field] !== undefined, JSON.stringify(Object.keys(mkt)));
  }
  const entry = (mkt.plugins ?? [])[0];
  for (const field of ['name', 'source', 'description', 'version']) {
    check(`marketplace.json plugins[0] 有 ${field}`, entry?.[field] !== undefined,
      JSON.stringify(Object.keys(entry ?? {})));
  }

  const manifest = JSON.parse(
    readFileSync(join(ROOT, 'plugin', '.claude-plugin', 'plugin.json'), 'utf8')
  );
  for (const field of ['name', 'version', 'description']) {
    check(`plugin.json 有 ${field}`, manifest[field] !== undefined, JSON.stringify(Object.keys(manifest)));
  }
  check('marketplace 與 plugin 的名稱一致', entry?.name === manifest.name,
    `${entry?.name} vs ${manifest.name}`);
  check('marketplace 與 plugin 的版本一致', entry?.version === manifest.version,
    `${entry?.version} vs ${manifest.version}`);
  check('source 指向 plugin 子目錄', entry?.source === './plugin', String(entry?.source));
});

test('★ plugin 自動跟上 ai-cli：自帶的核心舊了也要用安裝裡的最新判定', async () => {
  /*
    Claude Code 安裝 plugin 是把 source 目錄複製到 cache，之後 git pull 不會動它。
    2026-09-08 連續三次被自己的閘門誤擋，就是因為判定修好、push 了，本機仍跑安裝
    當下那份；而重裝完又被下一次修改超車。所以 hook 優先讀 ai-cli 安裝裡的 dist，
    讀不到才退回自帶的——有裝 ai-cli 的機器從此不必為了修 bug 重裝 plugin。
  */
  const base = join(TEMP, 'autofollow');
  const installed = join(base, 'cache', '1.0.0');
  const state = join(base, 'state');
  mkdirSync(installed, { recursive: true });
  mkdirSync(state, { recursive: true });
  cpSync(join(ROOT, 'plugin'), installed, { recursive: true });

  // 把自帶的核心換成一份「會誤擋純讀取指令」的舊行為
  writeFileSync(join(installed, 'hooks', 'verification-core.mjs'), [
    "export function normalizeToolEvent(entry) {",
    "  const cmd = String(entry?.input?.command ?? '');",
    "  return />\\s*[^\\s>|&]+/.test(cmd) && /[^\\s]+\\.ts/.test(cmd)",
    "    ? { kind: 'code_change', label: cmd.slice(0, 60) } : { kind: 'other', label: 'x' };",
    "}",
    "export function classifyVerification(events) {",
    "  const i = events.map((e) => e.kind).lastIndexOf('code_change');",
    "  const evidence = { lastCodeChange: i < 0 ? null : events[i].label,",
    "    verificationsAfterChange: [], failedVerifications: [], staleVerifications: 0 };",
    "  return { status: i < 0 ? 'not_applicable' : 'not_observed', reason: '', evidence };",
    "}",
  ].join('\n'));

  // 純讀取、但含 2>/dev/null 與 .ts 路徑——舊核心會誤擋，新判定不會
  const t = writeTranscript('autofollow', [
    userPrompt('看一下狀態'),
    assistantTools(bash('grep -rn "a" src/app/mcp.ts src/core/updater.ts 2>/dev/null')),
    toolResults({ id: 't0' }),
  ]);
  const hookPath = join(installed, 'hooks', 'verification-gate.mjs');
  const payload = { transcript_path: t, session_id: 'af', cwd: join(base, 'proj') };

  const stale = await runHookAt(hookPath, payload, { AI_CLI_STATE_DIR: state });
  check('前置：自帶的舊核心確實會誤擋（證明這條測試有效）',
    decisionOf(stale.stdout)?.decision === 'block', stale.stdout || '(沒擋)');

  writeFileSync(join(state, 'install.json'), JSON.stringify({ repoRoot: ROOT }));
  const fresh = await runHookAt(hookPath, payload, { AI_CLI_STATE_DIR: state });
  check('★ 有 install marker 就改用 ai-cli 的最新判定，不再誤擋',
    decisionOf(fresh.stdout) === null, fresh.stdout || '(仍被擋)');

  writeFileSync(join(state, 'install.json'), JSON.stringify({ repoRoot: 'D:/nope/nothing' }));
  const broken = await runHookAt(hookPath, payload, { AI_CLI_STATE_DIR: state });
  check('marker 指向不存在的路徑時退回自帶核心，不當機',
    decisionOf(broken.stdout)?.decision === 'block', broken.stdout);
});

const run = async () => {
  for (const [name, fn] of tests) {
    console.log(`\n${name}`);
    try {
      await fn();
    } catch (error) {
      failures++;
      console.log(`  FAIL  ${name} 拋出例外: ${error.message}`);
    }
  }
  rmSync(TEMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
  process.exit(failures === 0 ? 0 : 1);
};

run();
