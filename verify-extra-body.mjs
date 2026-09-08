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


// ---------------------------------------------------------------- 重試
console.log('\n[429 / 5xx 的退避重試]');

ok('retry 設定讀得到', () => {
  writeProviders({ nv: { ...BASE, retry: { max_retries: 5, initial_delay_ms: 200 } } });
  assert.deepStrictEqual(loadProvidersConfig().providers.nv.retry, {
    maxRetries: 5,
    initialDelayMs: 200,
  });
});

ok('max_retries: 0 是合法的（明確要求關掉重試）', () => {
  // 0 是 falsy，用「值的真假」判斷會把它當成沒設而退回預設 2 次。
  writeProviders({ nv: { ...BASE, retry: { max_retries: 0 } } });
  assert.strictEqual(loadProvidersConfig().providers.nv.retry.maxRetries, 0);
});

ok('沒寫 retry 時不長出這個欄位（由執行端套內建預設）', () => {
  writeProviders({ nv: { ...BASE } });
  assert.strictEqual(loadProvidersConfig().providers.nv.retry, undefined);
});

for (const [label, bad] of [
  ['不是物件', 'nope'],
  ['max_retries 是負數', { max_retries: -1 }],
  ['max_retries 不是整數', { max_retries: 1.5 }],
  ['max_retries 超過上限', { max_retries: 99 }],
  ['initial_delay_ms 超過上限', { initial_delay_ms: 999999 }],
]) {
  ok(`retry ${label} → 丟錯（不靜默退回預設）`, () => {
    writeProviders({ nv: { ...BASE, retry: bad } });
    assert.throws(() => loadProvidersConfig(), /retry/);
  });
}

/** 依序回傳排定好的狀態碼，記錄實際打了幾次。 */
function scriptedFetch(statuses) {
  let n = 0;
  globalThis.fetch = async () => {
    const status = statuses[Math.min(n, statuses.length - 1)];
    n += 1;
    if (status === 200) {
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
    }
    return new Response(JSON.stringify({ error: { message: 'boom', code: status } }), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  };
  return () => n;
}

async function runWith(statuses, retry) {
  writeProviders({ nv: { ...BASE, ...(retry ? { retry } : {}) } });
  const count = scriptedFetch(statuses);
  const cmd = directApiAgent.buildCommand({
    cliPath: '',
    cwd: tempRoot,
    prompt: 'hi',
    resolvedModel: 'nvidia/x',
    rawModel: 'nv-nvidia/x',
    reasoningEffort: '',
    providerName: 'nv',
    providerModel: 'nvidia/x',
  });
  const events = [];
  const io = { stdout: (c) => events.push(c), stderr: () => {}, signal: undefined };
  let threw = null;
  try {
    await directApiAgent.runDirect(cmd, io);
  } catch (err) {
    threw = err;
  }
  return { calls: count(), threw, events: events.join('') };
}

// 退避要真的很短，否則測試會為了等指數退避而跑好幾秒。
const FAST = { max_retries: 3, initial_delay_ms: 1 };

const r503 = await runWith([503, 503, 200], FAST);
ok('503 之後重試，第三次成功', () => {
  assert.strictEqual(r503.calls, 3, '應該打三次');
  assert.strictEqual(r503.threw, null, '最終成功就不該丟錯');
});

const r429 = await runWith([429, 200], FAST);
ok('429 也重試（速率限制是「等一下再來」不是「你錯了」）', () => {
  assert.strictEqual(r429.calls, 2);
  assert.strictEqual(r429.threw, null);
});

const r400 = await runWith([400, 200], FAST);
ok('★ 400 不重試（送錯的東西重送幾次都一樣錯）', () => {
  assert.strictEqual(r400.calls, 1, '400 只該打一次');
  assert.ok(r400.threw, '不重試的錯誤要往上丟');
});

const r401 = await runWith([401, 200], FAST);
ok('401 不重試（金鑰無效，重試只是白等）', () => {
  assert.strictEqual(r401.calls, 1);
  assert.ok(r401.threw);
});

const rGiveUp = await runWith([500], FAST);
ok('一直失敗時會放棄，不是無限重試', () => {
  assert.strictEqual(rGiveUp.calls, 4, '初次 + 重試 3 次 = 4');
  assert.ok(rGiveUp.threw, '用完重試次數就要丟錯');
});

const rOff = await runWith([500, 200], { max_retries: 0 });
ok('max_retries: 0 真的關掉重試', () => {
  assert.strictEqual(rOff.calls, 1);
  assert.ok(rOff.threw);
});

const rDefault = await runWith([500, 500, 200], null);
ok('沒設 retry 時用內建預設（2 次）', () => {
  assert.strictEqual(rDefault.calls, 3, '初次 + 預設重試 2 次');
  assert.strictEqual(rDefault.threw, null);
});

ok('★ 重試要被看見，不能靜默', () => {
  // 呼叫端是 AI，只看得到工具回傳。靜默重試會讓「很慢」與「卡住」長得一樣。
  const lines = r503.events.split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const retries = lines.filter((e) => e.type === 'retry');
  assert.strictEqual(retries.length, 2, '兩次重試要有兩個 retry 事件');
  assert.strictEqual(retries[0].status, 503, '事件要說出是什麼狀態碼');
  assert.ok(retries[0].delay_ms > 0, '事件要說出等了多久');
});

const rOnlySuccess = await runWith([200], FAST);
ok('一次就成功時不發 retry 事件', () => {
  assert.strictEqual(rOnlySuccess.calls, 1);
  assert.ok(!rOnlySuccess.events.includes('"type":"retry"'));
});

console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
process.exit(failures === 0 ? 0 : 1);
