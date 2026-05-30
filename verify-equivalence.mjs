// 行為等價驗證：新 build (dist) vs 舊 patched dist
// 比對 getModelsPayload() 與 buildCliCommand() 在多種情境下的輸出。
import assert from 'node:assert';

const NEW = 'file:///' + 'C:/Users/Moera/ai-cli-mcp-source/dist'.replace(/\\/g, '/');
const OLD = 'file:///' + 'C:/Users/Moera/ai-cli-mcp-patched/node_modules/ai-cli-mcp/dist'.replace(/\\/g, '/');

const newCatalog = await import(`${NEW}/models/catalog.js`);
const newBuilder = await import(`${NEW}/core/command-builder.js`);
const oldCatalog = await import(`${OLD}/model-catalog.js`);
const oldBuilder = await import(`${OLD}/cli-builder.js`);

let pass = 0;
let fail = 0;
const failures = [];

// 正規化：遞迴排序物件 key，讓比對只看「值」不看「欄位順序」
function sortKeys(v) {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    return Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])]));
  }
  return v;
}

function check(name, a, b) {
  const sa = JSON.stringify(sortKeys(a));
  const sb = JSON.stringify(sortKeys(b));
  if (sa === sb) {
    pass++;
  } else {
    fail++;
    failures.push({ name, new: sa, old: sb });
  }
}

// 1. models payload
check('getModelsPayload', newCatalog.getModelsPayload(), oldCatalog.getModelsPayload());
check('getSupportedModelsDescription', newCatalog.getSupportedModelsDescription(), oldCatalog.getSupportedModelsDescription());
check('getModelParameterDescription', newCatalog.getModelParameterDescription(), oldCatalog.getModelParameterDescription());

// 2. resolveModelAlias（新版在 catalog，舊版在 cli-builder）
for (const m of ['claude-ultra', 'codex-ultra', 'agy-ultra', 'antigravity-ultra', 'kiro-ultra', 'sonnet', 'gpt-5.5', 'unknown-x']) {
  check(`resolveModelAlias(${m})`, newCatalog.resolveModelAlias(m), oldBuilder.resolveModelAlias(m));
}

// 3. buildCliCommand 多情境
const cliPaths = {
  claude: 'CLAUDE',
  codex: 'CODEX',
  antigravity: 'AGY',
  kiro: 'KIRO',
  forge: 'FORGE',
  opencode: 'OPENCODE',
};
const cwd = 'C:\\Users\\Moera'; // 必須是存在的資料夾
const cases = [
  { model: 'sonnet', prompt: 'hello world' },
  { model: 'opus', prompt: 'x', reasoning_effort: 'high' },
  { model: 'claude-ultra', prompt: 'x' },
  { model: 'haiku', prompt: 'multi\nline\nprompt 123' },
  { model: 'gpt-5.5', prompt: 'codex test' },
  { model: 'codex-ultra', prompt: 'codex ultra' },
  { model: 'gpt-5.3-codex', prompt: 'x', reasoning_effort: 'xhigh', session_id: 'sess-1' },
  { model: 'agy', prompt: 'agy prompt' },
  { model: 'agy-default', prompt: 'x', session_id: 'conv-9' },
  { model: 'Gemini 3.5 Flash (High)', prompt: 'gemini-name test' },
  { model: 'kiro', prompt: 'kiro test' },
  { model: 'kiro-glm-5', prompt: 'kiro model test' },
  { model: 'forge', prompt: 'forge test', session_id: 'fc-1' },
  { model: 'opencode', prompt: 'oc test' },
  { model: 'oc-openai/gpt-5.4', prompt: 'oc explicit', session_id: 's' },
  { model: '', prompt: 'default fallback' },
];

for (const c of cases) {
  const opts = { ...c, workFolder: cwd, cliPaths };
  let newRes, oldRes, newErr, oldErr;
  try { newRes = newBuilder.buildCliCommand(opts); } catch (e) { newErr = e.message; }
  try { oldRes = oldBuilder.buildCliCommand(opts); } catch (e) { oldErr = e.message; }
  check(`buildCliCommand(${c.model || 'EMPTY'})`, newRes ?? { error: newErr }, oldRes ?? { error: oldErr });
}

// 4. 錯誤情境
const errCases = [
  { model: 'opencode', prompt: 'x', reasoning_effort: 'high' },
  { model: 'forge', prompt: 'x', reasoning_effort: 'high' },
  { model: 'agy', prompt: 'x', reasoning_effort: 'high' },
  { model: 'kiro', prompt: 'x', reasoning_effort: 'high' },
  { model: 'gpt-5.5', prompt: 'x', reasoning_effort: 'max' }, // codex 不支援 max
  { model: 'oc-badformat', prompt: 'x' },
  { model: 'sonnet' }, // 沒 prompt
];
for (const c of errCases) {
  const opts = { ...c, workFolder: cwd, cliPaths };
  let newErr = 'NO_ERROR', oldErr = 'NO_ERROR';
  try { newBuilder.buildCliCommand(opts); } catch (e) { newErr = e.message; }
  try { oldBuilder.buildCliCommand(opts); } catch (e) { oldErr = e.message; }
  check(`error:${c.model}:${c.reasoning_effort || 'noprompt'}`, newErr, oldErr);
}

console.log(`\n=== 等價驗證結果 ===`);
console.log(`PASS: ${pass}  FAIL: ${fail}`);
if (failures.length) {
  console.log('\n--- 差異 ---');
  for (const f of failures) {
    console.log(`\n[${f.name}]`);
    console.log(`  NEW: ${f.new}`);
    console.log(`  OLD: ${f.old}`);
  }
  process.exit(1);
}
console.log('全部等價 ✓');
