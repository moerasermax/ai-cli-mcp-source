/**
 * alias 熱切換（config.json aliasModel + set_config 工具）回歸測試。
 *
 * 覆蓋兩層：
 *   1. 純邏輯：resolveModelAlias / isKnownModelTarget 的邊界（含稽核抓出的 prototype key、
 *      alias 當 target、direct-api 空 model 等案例）。
 *   2. 端到端：起一個真的 MCP server（stdio JSON-RPC），驗 set_config 的驗證、寫入、
 *      unset、未知欄位保留，以及「同一個 process 內改設定，組出的指令立刻跟著變」。
 *
 * 會暫時改寫 ~/.local/share/ai-cli/config.json，結束時還原。
 * 用法：node verify-alias-config.mjs
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const CONFIG = join(homedir(), '.local', 'share', 'ai-cli', 'config.json');

/**
 * fs 刻意走 createRequire 而**不是** `import ... from 'node:fs'`。
 *
 * 靜態 import 會讓 node:fs 的 ESM facade 在這一刻實體化並把 `readFileSync` 綁死；
 * 之後再換掉 `fs.readFileSync`，dist 裡的模組拿到的仍是原函式，計數器就永遠是 0。
 * （這個 0 會讓下面「只讀一次」的斷言直接 FAIL 而不是假通過 —— 是刻意的：
 * 計數器壞掉時要看得出來。）
 */
const fs = createRequire(import.meta.url)('node:fs');
const { copyFileSync, existsSync, mkdirSync, rmSync, utimesSync, writeFileSync } = fs;
/** 原始實作：測試自己的讀取不該被計進去。 */
const readFileSync = fs.readFileSync;
const configReadCount = { n: 0 };
fs.readFileSync = function (path, ...rest) {
  if (String(path) === CONFIG) configReadCount.n += 1;
  return readFileSync.call(this, path, ...rest);
};
const BACKUP = `${CONFIG}.verify-alias-backup`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  ok   ${name}`);
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
    console.log(`  FAIL ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

const load = (rel) => import(pathToFileURL(join(ROOT, rel)).href);
const writeConfig = (obj) => {
  mkdirSync(dirname(CONFIG), { recursive: true });
  writeFileSync(CONFIG, `${JSON.stringify(obj, null, 2)}\n`);
};

/** 這支測試會改寫使用者真實的 config.json，還原必須無條件發生（含拋例外的路徑）。 */
function restoreConfig(hadConfig) {
  if (hadConfig) {
    if (existsSync(BACKUP)) {
      copyFileSync(BACKUP, CONFIG);
      rmSync(BACKUP);
    }
  } else if (existsSync(CONFIG)) {
    // 原本沒有這個檔，就不能把測試寫出來的那份留在使用者機器上。
    rmSync(CONFIG);
  }
}

async function main(baseConfig) {
  const catalog = await load('dist/models/catalog.js');
  const { buildCliCommand } = await load('dist/core/command-builder.js');

  // ---- 1. 純邏輯：isKnownModelTarget ----
  console.log('\n[1] isKnownModelTarget 邊界');
  check('接受既有 model', catalog.isKnownModelTarget('gpt-5.6-terra'));
  check('接受 pattern 命中的新 model', catalog.isKnownModelTarget('gpt-9-future'));
  check('接受 direct-api provider-prefixed', catalog.isKnownModelTarget('or-qwen/qwen3-max'));
  check('拒絕完全不認得的名稱', !catalog.isKnownModelTarget('totally-bogus'));
  // 以下三項是獨立稽核（@codex）抓出來的洞：
  check('拒絕 alias 名稱當 target', !catalog.isKnownModelTarget('kiro-ultra'));
  check('拒絕空 direct-api model（or-）', !catalog.isKnownModelTarget('or-'));
  check('拒絕空 direct-api model（ds-）', !catalog.isKnownModelTarget('ds-'));

  // ---- 2. 純邏輯：resolveModelAlias ----
  console.log('\n[2] resolveModelAlias 邊界');
  writeConfig(baseConfig);
  check('無覆寫時走內建表', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-sol');
  check('非 alias 原樣回傳', catalog.resolveModelAlias('opus') === 'opus');
  const proto = catalog.resolveModelAlias('constructor');
  check('prototype key 不會回傳函式', typeof proto === 'string' && proto === 'constructor',
    `got ${typeof proto}`);

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });
  check('config 覆寫優先於內建表', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-terra');

  // 快取不可以用 mtime 當鍵：同一毫秒內的兩次寫入 mtime 會相同，讀到的就是過期設定。
  // 這裡把兩次寫入的 mtime 直接鎖成同一個值，讓「同毫秒」這個競態變成必然而非碰運氣。
  const PINNED_MTIME = 1_700_000_000;
  utimesSync(CONFIG, PINNED_MTIME, PINNED_MTIME);
  catalog.resolveModelAlias('codex-ultra'); // 讓這個 mtime 進快取
  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.5' } });
  utimesSync(CONFIG, PINNED_MTIME, PINNED_MTIME);
  check(
    'mtime 相同也要讀到新內容',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.5',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });

  // 讀檔失敗（不是「檔案不存在」）必須沿用上一次成功的設定，不能靜默退回內建值 ——
  // 否則 Windows 上撞到別人 rename / 防毒鎖檔的那一瞬間，這次 run 就會悄悄換成別的 model。
  // 這裡把 config.json 換成一個「同名目錄」來製造穩定的非 ENOENT 讀取錯誤（EISDIR）。
  check('先確認覆寫已生效', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-terra');
  rmSync(CONFIG);
  mkdirSync(CONFIG);
  try {
    check(
      '讀檔失敗時維持 last-good 設定',
      catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-terra',
      `got ${catalog.resolveModelAlias('codex-ultra')}`
    );
  } finally {
    rmSync(CONFIG, { recursive: true });
  }

  // 相對地，「檔案真的不存在」是使用者的意思，必須退回內建值而不是沿用 last-good。
  check(
    '檔案不存在時退回內建值',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-sol',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  // UTF-8 BOM：Windows 記事本與 PowerShell 5.1 的 Set-Content 都會寫出帶 BOM 的檔案，
  // JSON.parse 看到開頭的 U+FEFF 會直接丟 SyntaxError → 整份設定靜默失效。
  writeFileSync(
    CONFIG,
    `﻿${JSON.stringify({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.4' } }, null, 2)}\n`
  );
  check(
    '帶 UTF-8 BOM 的設定檔仍然生效',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.4',
    `got ${catalog.resolveModelAlias('codex-ultra')}`
  );

  // 解析失敗之後，cache 必須被清掉：否則接下來一次讀檔失敗會把這份「使用者已經改壞、
  // 語意上作廢」的舊設定當成 last-good 復活。
  writeFileSync(CONFIG, '{ this is not json');
  check('壞掉的 JSON 退回內建值', catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-sol');
  rmSync(CONFIG);
  mkdirSync(CONFIG);
  try {
    check(
      '壞掉的 JSON 之後讀檔失敗，不會復活舊設定',
      catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-sol',
      `got ${catalog.resolveModelAlias('codex-ultra')}`
    );
  } finally {
    rmSync(CONFIG, { recursive: true });
  }

  // 陣列的 typeof 也是 'object'：不擋的話 Object.entries 會解出 "0"/"1" 這種垃圾 alias。
  writeConfig({ ...baseConfig, aliasModel: ['gpt-5.4', 'opus'] });
  check(
    'aliasModel 是陣列時整個忽略',
    catalog.resolveModelAlias('codex-ultra') === 'gpt-5.6-sol' &&
      catalog.resolveModelAlias('0') === '0',
    `got ${catalog.resolveModelAlias('0')}`
  );

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'gpt-5.6-terra' } });

  // ---- 3. 熱切換真的影響組出來的指令 ----
  console.log('\n[3] 同一個 process 內熱切換');
  const build = () =>
    buildCliCommand({
      prompt: 'hi',
      workFolder: ROOT,
      model: 'codex-ultra',
      cliPaths: { codex: 'codex', claude: 'claude', kiro: 'kiro' },
    });

  let cmd = build();
  check('切換後帶新 --model', cmd.args.includes('gpt-5.6-terra'), JSON.stringify(cmd.args));

  // 一次高階操作只准讀一次設定檔。讀兩次的話，中間被改動就會組出
  // 「A 版 alias + B 版 reasoning」這種兩邊都不對的指令 —— 讀取次數就是這件事的代理指標。
  const countConfigReads = (fn) => {
    const before = configReadCount.n;
    fn();
    return configReadCount.n - before;
  };
  const buildReads = countConfigReads(build);
  check('一次 buildCliCommand 只讀一次設定檔', buildReads === 1, `read ${buildReads} times`);
  const payloadReads = countConfigReads(() => catalog.getModelsPayload());
  check('一次 getModelsPayload 只讀一次設定檔', payloadReads === 1, `read ${payloadReads} times`);

  writeConfig({ ...baseConfig, aliasModel: { 'codex-ultra': 'opus' } });
  cmd = build();
  check('跨 agent 重指會換 agent', cmd.agent === 'claude', `agent=${cmd.agent}`);

  writeConfig(baseConfig);
  cmd = build();
  check('移除覆寫後退回內建', cmd.agent === 'codex' && cmd.args.includes('gpt-5.6-sol'));

  // ---- 4. 端到端 set_config ----
  console.log('\n[4] set_config 端到端（真的起一個 MCP server）');
  // 這一段刻意不沿用使用者的 baseConfig：斷言會比對「退回內建值」，
  // 沿用的話結果會被使用者自己的 defaultReasoningEffort 影響而變得不可預期。
  writeConfig({ myCustomThing: { keep: 'me' } });
  await mcpChecks();

  console.log(`\n${failures.length === 0 ? 'PASS' : 'FAIL'}: ${passed} passed, ${failures.length} failed`);
  if (failures.length > 0) {
    for (const f of failures) console.log(`  - ${f}`);
    process.exitCode = 1;
  }
}

async function mcpChecks() {
  const child = spawn(process.execPath, [join(ROOT, 'dist/bin/ai-cli-mcp.js')], {
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let buf = '';
  const pending = new Map();
  child.stdout.on('data', (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id && pending.has(msg.id)) {
          pending.get(msg.id)(msg);
          pending.delete(msg.id);
        }
      } catch {
        /* 非 JSON 行（啟動訊息）略過 */
      }
    }
  });

  let nextId = 1;
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  const call = (name, args) => send('tools/call', { name, arguments: args });
  const aliasOf = (res, name) =>
    JSON.parse(res.result.content[0].text).aliases.find((a) => a.name === name);

  try {
    await send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'verify', version: '0' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const tools = await send('tools/list', {});
    check('set_config 已註冊', tools.result.tools.some((t) => t.name === 'set_config'));

    let res = await call('set_config', { alias_model: { 'codex-ultra': 'gpt-5.6-terra' } });
    const row = aliasOf(res, 'codex-ultra');
    check('set_config 寫入生效', row.resolvesTo === 'gpt-5.6-terra' && row.source === 'config');
    check('回報內建原值', row.builtinResolvesTo === 'gpt-5.6-sol');

    const onDisk = JSON.parse(readFileSync(CONFIG, 'utf-8'));
    check('保留設定檔中的未知欄位', onDisk.myCustomThing?.keep === 'me');

    res = await call('set_config', { alias_model: { 'codex-ultra': 'totally-bogus' } });
    check('拒絕未知 model', !!res.error);
    res = await call('set_config', { alias_model: { 'codex-ultra': 'or-' } });
    check('拒絕空 direct-api model', !!res.error);
    res = await call('set_config', { alias_model: { 'codex-ultra': 'kiro-ultra' } });
    check('拒絕 alias 當 target', !!res.error);
    res = await call('set_config', { alias_model: { 'nope-ultra': 'gpt-5.4' } });
    check('拒絕未知 alias', !!res.error);
    res = await call('set_config', { alias_model: { constructor: 'opus' } });
    check('拒絕 prototype key 當 alias', !!res.error);
    // __proto__ 與 constructor 不同：普通 {} 的 out['__proto__'] = 字串會被 Object.prototype
    // 的 setter 無聲吃掉，key 根本不會出現在 own properties，驗證迴圈掃不到 → 假成功。
    res = await call('set_config', { alias_model: { __proto__: 'opus' } });
    check('拒絕 __proto__ 當 alias', !!res.error, JSON.stringify(res.error ?? res.result)?.slice(0, 120));
    res = await call('set_config', { alias_model: {} });
    check('拒絕空的 alias_model（假成功）', !!res.error);
    res = await call('set_config', {});
    check('拒絕空的變更', !!res.error);
    res = await call('set_config', { alias_reasoning_effort: { 'codex-ultra': 'nonsense' } });
    check('拒絕不合法的 reasoning effort', !!res.error);

    // 設定檔已經壞掉時，set_config 絕對不能拿空基底套上 patch 寫回去 ——
    // 那會把使用者原本的內容整份吃掉。必須明確失敗、原檔一個 byte 都不許動。
    const corrupted = '{ "aliasModel": { "codex-ultra": "gpt-5.4" }, oops';
    writeFileSync(CONFIG, corrupted);
    res = await call('set_config', { alias_model: { 'claude-ultra': 'haiku' } });
    check('設定檔壞掉時 set_config 明確失敗', !!res.error);
    check(
      '設定檔壞掉時不覆寫原檔',
      readFileSync(CONFIG, 'utf-8') === corrupted,
      `file changed to: ${readFileSync(CONFIG, 'utf-8').slice(0, 60)}`
    );
    writeConfig({ myCustomThing: { keep: 'me' } });

    // alias 指到不支援 reasoning 的 agent 時，不該回報一個不會生效的 effort
    res = await call('set_config', { alias_model: { 'codex-ultra': 'kiro-default' } });
    const kiroRow = aliasOf(res, 'codex-ultra');
    check('跨 agent 後 agent 欄位跟著變', kiroRow.agent === 'kiro', `agent=${kiroRow.agent}`);
    check(
      '不支援 reasoning 就不回報 effort',
      kiroRow.defaultReasoningEffort === undefined,
      `got ${kiroRow.defaultReasoningEffort}`
    );

    // unset 一個 alias 必須同時清掉 model 與 reasoning 兩種覆寫（README 這樣寫）：
    // 先把兩種都設起來，再 unset，然後檢查兩者都回到內建值。
    res = await call('set_config', {
      alias_model: { 'codex-ultra': 'gpt-5.4' },
      alias_reasoning_effort: { 'codex-ultra': 'low' },
    });
    check(
      'unset 前兩種覆寫都生效',
      aliasOf(res, 'codex-ultra').resolvesTo === 'gpt-5.4' &&
        aliasOf(res, 'codex-ultra').defaultReasoningEffort === 'low',
      JSON.stringify(aliasOf(res, 'codex-ultra'))
    );

    res = await call('set_config', { unset: ['codex-ultra'] });
    const back = aliasOf(res, 'codex-ultra');
    check('unset 退回內建', back.resolvesTo === 'gpt-5.6-sol' && back.source === 'builtin');
    check(
      'unset 同時清掉 reasoning 覆寫',
      back.defaultReasoningEffort === 'xhigh',
      `got ${back.defaultReasoningEffort}`
    );
  } finally {
    child.kill();
  }
}

// 備份與還原包在 try/finally 外層：任何一步拋例外（import 失敗、spawn 失敗、
// JSON parse 失敗）都不能把使用者的 config.json 留在測試中途的狀態。
const hadConfig = existsSync(CONFIG);
if (hadConfig) copyFileSync(CONFIG, BACKUP);
const baseConfig = hadConfig ? JSON.parse(readFileSync(CONFIG, 'utf-8')) : {};
try {
  await main(baseConfig);
} finally {
  restoreConfig(hadConfig);
}
