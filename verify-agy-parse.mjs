/**
 * antigravity（agy）輸出解析的回歸測試——重點是 **conversation_id 有沒有被帶出來**。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-09-10 實測：`--conversation` 只認 agy 自己發的 id。呼叫端自編一個傳進去，
 * agy 印 `warning: conversation "<id>" not found`，然後**開一個新的對話**——
 * 回答看起來正常，但每一回合都是新的。
 *
 * 在這之前 ai-cli 解析的是 `--print` 的 text 格式，那個格式**沒有 conversation_id**，
 * 所以 agy 這條路等於完全無法續接，而且失敗方式是靜默的。改吃
 * `--output-format json` 之後才拿得到 id（順帶拿到 usage）。
 *
 * 這一支守三件事：
 *   1. json 格式要解得出 session_id / message / tokens
 *   2. JSON **前面**那行 warning 不能被吞掉——它是 resume 失敗的唯一訊號
 *   3. text 格式仍要能拿到本文（fallback 不能因為換格式而壞掉）
 *
 * 另外釘住兩個 builder 都有帶 `--output-format json`：漏掉任何一個，
 * 那條路就會靜默退回「拿不到 id」的舊行為。
 *
 * 純解析，不呼叫真實 vendor。
 *
 * 用法：node verify-agy-parse.mjs
 */

import './tools/stubs/catalog-test-env.mjs';
import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  ${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
}

const mod = await import(
  pathToFileURL(join(ROOT, 'dist', 'agents', 'antigravity.js')).href
);
const agent = mod.antigravityAgent;
const parse = (stdout) => agent.parseOutput(stdout, '', 0);

console.log('agy 輸出解析（conversation_id 是續接的唯一鑰匙）\n');

// ── 1. json 格式：實測原文（v1.1.9，2026-09-10）──────────────
const JSON_LINE = JSON.stringify({
  conversation_id: '80a644dd-0e69-494e-9fee-0283babfdd58',
  status: 'SUCCESS',
  response: '致 User\n---\nZEBRA-4471\n---\n',
  duration_seconds: 8.3564975,
  num_turns: 2,
  usage: { input_tokens: 31227, output_tokens: 545, thinking_tokens: 523, total_tokens: 31772 },
});

const parsed = parse(JSON_LINE);
check(
  parsed?.session_id === '80a644dd-0e69-494e-9fee-0283babfdd58',
  '★ json 格式解得出 session_id（沒有它 agy 就完全無法續接）',
  `得到 ${JSON.stringify(parsed?.session_id)}`
);
check(parsed?.message === 'ZEBRA-4471', 'response 的「致 User / --- / body / ---」信封有剝掉', `得到 ${JSON.stringify(parsed?.message)}`);
check(parsed?.tokens?.input_tokens === 31227, 'usage 有帶出來（text 格式拿不到這個）');
check(parsed?.num_turns === 2, 'num_turns 有帶出來');

// ── 2. warning 在 JSON 前面，不能被吞掉 ────────────────────────
const withWarning = `warning: conversation "wp0agy1" not found\r\n${JSON_LINE}`;
const warned = parse(withWarning);
check(
  warned?.session_id === '80a644dd-0e69-494e-9fee-0283babfdd58',
  'JSON 前面有 warning 時仍解得出 session_id（不能對整段 JSON.parse）'
);
check(
  Array.isArray(warned?.warnings) && warned.warnings.some((w) => w.includes('not found')),
  '★ resume 失敗的 warning 有保留（吞掉它＝把 unknown 折進 ok）',
  `得到 ${JSON.stringify(warned?.warnings)}`
);
check(
  !String(warned?.message).includes('warning:'),
  'warning 沒有混進本文（舊的 text 解析會把它當內容的一部分）'
);

// ── 3. text 格式的 fallback 不能壞 ─────────────────────────────
const textOnly = '致 User\r\n---\r\n收到\r\n---';
const fell = parse(textOnly);
check(fell?.message === '收到', 'text 格式仍拿得到本文（fallback）', `得到 ${JSON.stringify(fell?.message)}`);
check(fell?.session_id === undefined, 'text 格式不得憑空生出 session_id');
check(parse('') === null && parse('   ') === null, '空輸入回 null');

// ── 4. 兩個 builder 都要帶 --output-format json ────────────────
const baseInput = {
  cliPath: 'agy',
  cwd: process.cwd(),
  prompt: 'hi',
  resolvedModel: 'gemini-3.8-flash-low',
};
function hasJsonFormat(args) {
  const i = args.indexOf('--output-format');
  return i >= 0 && args[i + 1] === 'json';
}
check(
  hasJsonFormat(agent.buildCommand(baseInput).args),
  '★ buildCommand 帶 --output-format json（漏掉就靜默退回拿不到 id）'
);
check(
  hasJsonFormat(agent.buildStrictCommand(baseInput, ['fs/read', 'analysis/produce']).args),
  '★ buildStrictCommand 帶 --output-format json'
);
check(
  agent.buildCommand({ ...baseInput, sessionId: 'abc-123' }).args.includes('--conversation'),
  'sessionId 走 --conversation'
);

const failed = results.filter(([ok]) => !ok).length;
if (failed > 0) {
  console.log(`\nFAIL: ${results.length - failed} passed, ${failed} failed`);
  process.exit(1);
}
console.log(`\nPASS: ${results.length} passed, 0 failed`);
