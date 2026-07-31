/**
 * 模型目錄的**出處標示**回歸測試。
 *
 * ── 為什麼有這一支 ────────────────────────────────────────────
 * 2026-07-31 發生過一次具體的誤導：有人照 `agents/antigravity.ts` 的
 * 註解斷定「agy 不支援 --model」並當成事實轉述。實測 v1.1.9 早就支援，
 * 而且模型從 4 個變成 11 個。
 *
 * 根因不是註解沒更新，而是**硬編清單沒有標明自己是硬編的**。
 * 這一支守的就是那個標示：
 *
 *   1. 每一筆目錄項目都必須有 source / verifiedAt / billingRoute
 *   2. 查不到 vendor 時**必須降級成 builtin-fallback**，不得靜默沿用
 *      舊值卻宣稱是 vendor-cli
 *   3. doctor 不得再輸出「看起來像答案的非答案」
 *
 * 用法：node verify-catalog-source.mjs
 */

import { pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const results = [];
function check(ok, name, detail = '') {
  results.push([ok, name, detail]);
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
}

const load = (rel) => import(pathToFileURL(join(ROOT, 'dist', rel)).href);

console.log('== 模型目錄的出處標示 ==');

const { buildCatalogV2, clearCatalogCache } = await load('models/catalog-v2.js');
const { getModelsPayload } = await load('models/catalog.js');
const registry = await load('agents/registry.js');
const { buildDoctorStatus } = await load('core/binary-resolver.js');

// ── 1. 每一筆都要說得出出處 ───────────────────────────────────
{
  const catalog = buildCatalogV2();
  check(catalog.entries.length > 0, '目錄不是空的', `${catalog.entries.length} 筆`);

  const missing = catalog.entries.filter(
    (e) =>
      !e.id ||
      !e.displayName ||
      !['vendor-cli', 'builtin-fallback'].includes(e.source) ||
      !['subscription-cli', 'metered-api'].includes(e.billingRoute) ||
      typeof e.verifiedAt !== 'string' ||
      Number.isNaN(Date.parse(e.verifiedAt))
  );
  check(
    missing.length === 0,
    '★ 每一筆都有 source / verifiedAt / billingRoute（缺一就不該出現在目錄裡）',
    missing.length ? JSON.stringify(missing[0]) : ''
  );

  const bad = catalog.entries.filter((e) => e.id !== `${e.agent}/${e.model}`);
  check(bad.length === 0, 'id 是穩定的 {agent}/{model}，不是顯示名', bad.length ? bad[0].id : '');

  // agents 摘要與 entries 的 source 必須一致——分開講會讓兩者漂移
  const bySummary = new Map(catalog.agents.map((a) => [a.agent, a.source]));
  const inconsistent = catalog.entries.filter((e) => bySummary.get(e.agent) !== e.source);
  check(
    inconsistent.length === 0,
    'agents 摘要與每一筆 entry 的 source 一致',
    inconsistent.length ? inconsistent[0].id : ''
  );
}

// ── 2. 計費路徑必須分得出來 ───────────────────────────────────
{
  const catalog = buildCatalogV2();
  const metered = catalog.entries.filter((e) => e.billingRoute === 'metered-api');
  check(
    metered.length > 0 && metered.every((e) => e.agent === 'direct-api'),
    '★ direct-api 標成 metered-api（按量計費的 API 金鑰，與訂閱額度是不同的錢）',
    `${metered.length} 筆`
  );
  const subs = catalog.entries.filter((e) => e.agent !== 'direct-api');
  check(
    subs.every((e) => e.billingRoute === 'subscription-cli'),
    '走各自 CLI 登入的標成 subscription-cli',
    ''
  );
}

// ── 3. ★ 查不到就必須降級，不得靜默沿用舊值 ───────────────────
{
  const agy = registry.getAgent('antigravity');
  const realDiscover = agy.discoverModels;
  check(typeof realDiscover === 'function', 'antigravity 有 discoverModels（動態查詢能力）');

  // 先拿一次真實結果當基準
  clearCatalogCache();
  const before = buildCatalogV2();
  const agyBefore = before.agents.find((a) => a.agent === 'antigravity');

  // 讓查詢失敗（模擬 CLI 換版、輸出格式改變、逾時）
  agy.discoverModels = () => null;
  clearCatalogCache();
  const after = buildCatalogV2();
  const agyAfter = after.agents.find((a) => a.agent === 'antigravity');
  const entriesAfter = after.entries.filter((e) => e.agent === 'antigravity');

  check(
    agyAfter.source === 'builtin-fallback',
    '★ 查不到 vendor → 降級成 builtin-fallback（不得繼續宣稱 vendor-cli）',
    agyAfter.source
  );
  check(
    entriesAfter.every((e) => e.source === 'builtin-fallback'),
    '★ 降級要落到每一筆 entry，不是只改摘要',
    ''
  );
  check(
    typeof agyAfter.discoveryNote === 'string' && agyAfter.discoveryNote.length > 0,
    '★ 降級時要說出為什麼（discoveryNote 非空）',
    agyAfter.discoveryNote ?? '(null)'
  );

  agy.discoverModels = realDiscover;
  clearCatalogCache();

  // 只在機器上真的有 agy 時才斷言「有問到」——沒有 agy 的機器上
  // 這個環境本來就給不出 vendor-cli，硬斷言會是假紅燈。
  if (agyBefore.binaryFound) {
    check(
      agyBefore.source === 'vendor-cli',
      '★ 有 agy 時真的去問了 CLI（不是照抄靜態清單）',
      agyBefore.source
    );
    const restored = buildCatalogV2().agents.find((a) => a.agent === 'antigravity');
    check(restored.source === 'vendor-cli', '還原後回到 vendor-cli', restored.source);
  } else {
    console.log('  [SKIP] 這台機器沒有 agy，跳過「真的問到 vendor」的斷言');
  }
}

// ── 3b. ★ 加了 --model 之後，既有 alias 不得因此壞掉 ──────────
//
// 這條差點變成「修一個誤會、製造另一個」：alias `agy-ultra` 解析成
// `Gemini 3.1 Pro (High)`（agy settings.json 的顯示寫法），而 CLI 的
// --model 只吃 `gemini-3.1-pro-high`。原樣傳會讓每一次 agy 呼叫都失敗。
{
  const agy = registry.getAgent('antigravity');
  const build = (model) =>
    agy.buildCommand({
      cliPath: 'agy.exe',
      cwd: '.',
      prompt: 'hi',
      resolvedModel: model,
      rawModel: model,
      reasoningEffort: '',
    });
  const modelArg = (model) => {
    const args = build(model).args;
    const i = args.indexOf('--model');
    return i >= 0 ? args[i + 1] : null;
  };

  check(
    modelArg('Gemini 3.1 Pro (High)') === 'gemini-3.1-pro-high',
    '★ 舊顯示寫法要正規化成 CLI 吃得下的 id（否則既有 alias 全部失效）',
    String(modelArg('Gemini 3.1 Pro (High)'))
  );
  check(modelArg('gemini-3.6-flash-high') === 'gemini-3.6-flash-high', '真實 id 原樣傳');
  check(modelArg('agy') === null, "'agy' 是框架 alias 不是模型名 → 不傳 --model");
  check(
    modelArg('這不是模型名') === null,
    '★ 認不出來就不傳（寧可回到 CLI 預設，也不要送一個必定失敗的值）'
  );
  check(
    agy.matchesModel('gemini-3.6-flash-high') && agy.matchesModel('Gemini 3.1 Pro (High)'),
    '新舊兩種寫法都路由到 antigravity'
  );
  check(
    !agy.matchesModel('claude-sonnet-4-6') && !agy.matchesModel('gpt-oss-120b-medium'),
    '★ agy 代理的 claude/gpt 模型**不**靠名字認領（會把人送到錯的 CLI）'
  );
}

// ── 4. 既有形狀不得被破壞 ─────────────────────────────────────
{
  const payload = getModelsPayload();
  for (const key of ['aliases', 'claude', 'codex', 'antigravity', 'direct-api', 'userConfig']) {
    check(payload[key] !== undefined, `models payload 保留既有欄位：${key}`);
  }
  check(payload.catalogV2 !== undefined, 'catalogV2 以新欄位加上去（不取代舊欄位）');
}

// ── 5. doctor 不得輸出看起來像答案的非答案 ────────────────────
{
  const configs = registry
    .listAgents()
    .filter((a) => a.binary)
    .map((a) => ({ id: a.id, config: a.binary }));
  const doctor = buildDoctorStatus(configs);
  check(
    doctor.checks.loginState === null && doctor.checks.termsAcceptance === null,
    '★ 沒檢查的項目回 null，不是 false（false 讀起來像「檢查過而且是否定的」）',
    JSON.stringify(doctor.checks)
  );
  const everyAvailable = configs.every((c) => doctor[c.id].available);
  check(
    doctor.checks.binaryAvailability === everyAvailable,
    '★ binaryAvailability 由實際結果推導，不是寫死的 true',
    `${doctor.checks.binaryAvailability} vs 實際 ${everyAvailable}`
  );
}

const passed = results.filter(([ok]) => ok).length;
console.log(`\n=== ${passed}/${results.length} passed ===`);
if (passed !== results.length) {
  for (const [ok, name] of results) if (!ok) console.log(`  FAILED: ${name}`);
  process.exitCode = 1;
}
