/**
 * 第 2 層 Stop hook 的行為驗證（不啟動 Claude Code，直接餵假 transcript 與假 hook 事件）。
 * 重點在「該擋的擋、不該擋的一次都不擋、而且永遠不會擋第二次」。
 * 狀態目錄用 AI_CLI_STATE_DIR 隔離到 dist 底下，完全不碰使用者目錄。
 * 執行：npm run build && node verify-gate-hook.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
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

function runHook(payload, env = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, AI_CLI_STATE_DIR: join(TEMP, 'state'), ...env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(JSON.stringify(payload));
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

test('驗證失敗 → 不重複擋（模型自己看得到失敗）', async () => {
  const t = writeTranscript('failed', [
    userPrompt('幫我修一下'),
    assistantTools(edit('src/a.ts'), bash('npm test')),
    toolResults({ id: 't0' }, { id: 't1', content: '2 failed', is_error: true }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's3' });
  check('驗證失敗時不再擋一次', decisionOf(r.stdout) === null, r.stdout);
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
  const log = join(TEMP, 'state', 'verification-gate.jsonl');
  const lines = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  check(
    '放行時記成 waived',
    lines.some((l) => l.session === 's7' && l.status === 'waived'),
    JSON.stringify(lines.slice(-3))
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
  child.stdout.on('data', (d) => (stdout += d));
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

test('shell 改程式碼也算數（sed -i）', async () => {
  const t = writeTranscript('shell', [
    userPrompt('用 sed 改一下'),
    assistantTools(bash('sed -i s/a/b/ src/a.ts')),
    toolResults({ id: 't0' }),
  ]);
  const r = await runHook({ transcript_path: t, session_id: 's11' });
  check('sed -i 改程式碼會被擋', decisionOf(r.stdout)?.decision === 'block', r.stdout);
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
