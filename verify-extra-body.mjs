/**
 * providers.json 的 extra_body / model_extra_body 驗證（純邏輯 + mock fetch，
 * 不打任何真實 provider）。
 *
 * 動機：ai-cli 送出去的 request body 原本只有 model/messages/stream/stream_options/tools，
 * 於是 NVIDIA 那批「預設 reasoning 全開」的模型只能被動吃預設值——實測
 * nemotron-3.5-lightning 開預設要 28.0 秒 / 318 token，傳 reasoning_effort="none"
 * 只要 6.1 秒 / 84 token。這支測試守的就是那個欄位真的送得出去，
 * 而且**不能**讓設定檔覆蓋框架自己組的欄位。
 *
 * 執行：npm run build && node verify-extra-body.mjs
 */
import assert from 'node:assert';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoot = mkdtempSync(join(tmpdir(), 'aicli-extra-body-'));
process.on('exit', () => {
  try {
    rmSync(tempRoot, { recursive: true, force: true });
  } catch {
    /* 清不掉就算了，不要蓋掉原本的失敗原因 */
  }
});

const providersPath = join(tempRoot, 'providers.json');
process.env.AI_CLI_PROVIDERS_PATH = providersPath;

function writeProviders(providers) {
  writeFileSync(providersPath, `${JSON.stringify({ providers }, null, 2)}\n`, 'utf-8');
}

// 動態 import 一律提到頂層用 top-level await：ok() 只吃同步函式，
// 在裡面 await 會讓斷言錯誤被吞掉而永遠 PASS（2026-09-08 的假綠燈教訓）。
const { loadProvidersConfig, resolveExtraBody, directApiAgent } = await import(
  './dist/agents/direct-api.js'
);

let failures = 0;
function ok(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      throw new Error('ok() 只接受同步函式；async 會讓斷言錯誤被吞掉而永遠通過');
    }
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

const BASE = { base_url: 'https://mock.nv.test/v1', api_key: 'test-key' };

// ---------------------------------------------------------------- 載入與驗證
console.log('\n[載入 providers.json]');

ok('沒有 extra_body 時，provider 不長出多餘欄位', () => {
  writeProviders({ nv: { ...BASE } });
  const cfg = loadProvidersConfig().providers.nv;
  assert.strictEqual(cfg.extra_body, undefined);
  assert.strictEqual(cfg.model_extra_body, undefined);
});

ok('provider 層 extra_body 讀得到', () => {
  writeProviders({ nv: { ...BASE, extra_body: { max_tokens: 8192 } } });
  assert.deepStrictEqual(loadProvidersConfig().providers.nv.extra_body, { max_tokens: 8192 });
});

ok('model_extra_body 讀得到', () => {
  writeProviders({
    nv: { ...BASE, model_extra_body: { 'nvidia/x': { reasoning_effort: 'none' } } },
  });
  assert.deepStrictEqual(loadProvidersConfig().providers.nv.model_extra_body, {
    'nvidia/x': { reasoning_effort: 'none' },
  });
});

ok('extra_body 不是物件 → 丟錯（不是靜默丟棄）', () => {
  writeProviders({ nv: { ...BASE, extra_body: [1, 2] } });
  assert.throws(() => loadProvidersConfig(), /extra_body must be an object/);
});

ok('model_extra_body 不是物件 → 丟錯', () => {
  writeProviders({ nv: { ...BASE, model_extra_body: 'nope' } });
  assert.throws(() => loadProvidersConfig(), /model_extra_body must be an object/);
});

// 保留欄位：這是主要防線。逐一測，不要只測一個代表。
for (const key of ['model', 'messages', 'stream', 'stream_options', 'tools']) {
  ok(`保留欄位 "${key}" 在 provider 層被擋下`, () => {
    writeProviders({ nv: { ...BASE, extra_body: { [key]: 'x' } } });
    assert.throws(() => loadProvidersConfig(), new RegExp(`may not set "${key}"`));
  });
  ok(`保留欄位 "${key}" 在 model_extra_body 也被擋下`, () => {
    writeProviders({ nv: { ...BASE, model_extra_body: { 'nvidia/x': { [key]: 'x' } } } });
    assert.throws(() => loadProvidersConfig(), new RegExp(`may not set "${key}"`));
  });
}

ok('錯誤訊息要點名是哪個 provider 的哪個 model', () => {
  writeProviders({ nv: { ...BASE, model_extra_body: { 'nvidia/x': { stream: false } } } });
  assert.throws(() => loadProvidersConfig(), (err) => {
    assert.ok(err.message.includes('"nv"'), `訊息要有 provider 名，實際：${err.message}`);
    assert.ok(err.message.includes('nvidia/x'), `訊息要有 model 名，實際：${err.message}`);
    return true;
  });
});

// ---------------------------------------------------------------- 合併規則
console.log('\n[合併規則]');

ok('兩層都沒有 → undefined（不要回空物件）', () => {
  assert.strictEqual(resolveExtraBody({}, 'nvidia/x'), undefined);
});

ok('只有 provider 層 → 直接套用', () => {
  assert.deepStrictEqual(resolveExtraBody({ extra_body: { max_tokens: 1 } }, 'nvidia/x'), {
    max_tokens: 1,
  });
});

ok('model 專屬覆蓋 provider 層的同名欄位', () => {
  const merged = resolveExtraBody(
    {
      extra_body: { max_tokens: 1, temperature: 0.5 },
      model_extra_body: { 'nvidia/x': { max_tokens: 999 } },
    },
    'nvidia/x'
  );
  assert.deepStrictEqual(merged, { max_tokens: 999, temperature: 0.5 });
});

ok('對不上的 model 不會拿到別人的覆寫', () => {
  const merged = resolveExtraBody(
    { extra_body: { max_tokens: 1 }, model_extra_body: { 'nvidia/x': { max_tokens: 999 } } },
    'nvidia/y'
  );
  assert.deepStrictEqual(merged, { max_tokens: 1 });
});

ok('prototype key 不會被當成命中的設定', () => {
  /*
    'constructor' in map 為 true，且 map['constructor'] 回傳的是函式而不是 undefined。

    ★ 斷言要挑在「沒有 provider 層」的情況：有 provider 層時，展開一個函式
      （{...Object}）剛好得到空物件，正確與錯誤的結果一模一樣，那條斷言分不出差別。
      沒有 provider 層時差別才看得見——正確回 undefined，命中 prototype 的話
      perModel 是個 truthy 的函式，會回一個空物件 {}。
  */
  const byModel = JSON.parse('{"nvidia/x":{"a":1}}');
  assert.strictEqual(
    resolveExtraBody({ model_extra_body: byModel }, 'constructor'),
    undefined,
    'model 名叫 constructor 時不可命中 prototype 上的東西'
  );
  assert.strictEqual(resolveExtraBody({ model_extra_body: byModel }, 'toString'), undefined);
  // 真的有這個 model 時仍然要拿得到，別為了擋 prototype 把正常路徑一起擋掉。
  assert.deepStrictEqual(resolveExtraBody({ model_extra_body: byModel }, 'nvidia/x'), { a: 1 });
});

// ---------------------------------------------------------------- 真的送出去
console.log('\n[實際送出的 request body]');

const realFetch = globalThis.fetch;
process.on('exit', () => {
  globalThis.fetch = realFetch;
});

const noop = { stdout: () => {}, stderr: () => {}, signal: undefined };

/**
 * 送一次 run 並回傳實際打出去的 request body。
 *
 * ★ 這支是 async，所以**只能在頂層 await**，不可以塞進 ok()——ok() 只吃同步函式，
 *   async 進去等於斷言錯誤被吞掉、那條測試永遠 PASS。
 */
async function captureBody({ providers, model, mutateCmd }) {
  writeProviders(providers);
  let captured = null;
  globalThis.fetch = async (_url, init = {}) => {
    captured = JSON.parse(String(init.body));
    const encoder = new TextEncoder();
    return new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({
                choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }],
              })}\n\ndata: [DONE]\n\n`
            )
          );
          c.close();
        },
      }),
      { status: 200, headers: { 'content-type': 'text/event-stream' } }
    );
  };
  const cmd = directApiAgent.buildCommand({
    cliPath: '',
    cwd: tempRoot,
    prompt: 'hi',
    resolvedModel: model,
    rawModel: `nv-${model}`,
    reasoningEffort: '',
    providerName: 'nv',
    providerModel: model,
  });
  if (mutateCmd) mutateCmd(cmd);
  await directApiAgent.runDirect(cmd, noop);
  return captured;
}

const bodyWithExtra = await captureBody({
  providers: { nv: { ...BASE, extra_body: { max_tokens: 8192 } } },
  model: 'nvidia/x',
});
ok('extra_body 真的出現在 request body 裡', () => {
  assert.strictEqual(bodyWithExtra.max_tokens, 8192);
});

const bodyWithModelExtra = await captureBody({
  providers: {
    nv: {
      ...BASE,
      extra_body: { max_tokens: 8192 },
      model_extra_body: { 'nvidia/x': { reasoning_effort: 'none' } },
    },
  },
  model: 'nvidia/x',
});
ok('model 專屬的 reasoning_effort 送得出去，且不吃掉 provider 層的欄位', () => {
  assert.strictEqual(bodyWithModelExtra.reasoning_effort, 'none');
  assert.strictEqual(bodyWithModelExtra.max_tokens, 8192);
});

const bodyPlain = await captureBody({ providers: { nv: { ...BASE } }, model: 'nvidia/x' });
ok('沒設 extra_body 時 request body 維持原樣（只有五個框架欄位）', () => {
  assert.deepStrictEqual(Object.keys(bodyPlain).sort(), [
    'messages',
    'model',
    'stream',
    'stream_options',
    'tools',
  ]);
});

// 第二層防護：正常路徑上 normalizeExtraBody 會先擋掉保留欄位，這裡刻意跳過設定檔，
// 直接把它們塞進 directApi.extraBody，驗證展開順序本身也擋得住。
const bodyForced = await captureBody({
  providers: { nv: { ...BASE } },
  model: 'nvidia/x',
  mutateCmd: (cmd) => {
    cmd.directApi.extraBody = {
      model: 'evil/model',
      stream: false,
      tools: [],
      messages: [],
      stream_options: null,
    };
  },
});
ok('框架欄位永遠贏：即使繞過載入驗證直接塞，也覆蓋不掉', () => {
  assert.strictEqual(bodyForced.model, 'nvidia/x', 'model 不可被覆蓋');
  assert.strictEqual(bodyForced.stream, true, 'stream 不可被覆蓋（會打爆 SSE 解析）');
  assert.deepStrictEqual(bodyForced.stream_options, { include_usage: true });
  assert.ok(Array.isArray(bodyForced.tools) && bodyForced.tools.length > 0, 'tools 不可被清空');
  assert.ok(
    Array.isArray(bodyForced.messages) && bodyForced.messages.length > 0,
    'messages 不可被清空'
  );
});

console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
process.exit(failures === 0 ? 0 : 1);
