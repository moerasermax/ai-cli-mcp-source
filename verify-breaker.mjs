/**
 * 熔斷器行為驗證（不啟動任何真實 AI，純邏輯）。
 * 用注入的假時鐘驅動，確認 rate / duplicate 觸發、冷卻恢復、disabled / warn 模式。
 * 執行：npm run build && node verify-breaker.mjs
 */
import { CircuitBreaker } from './dist/core/circuit-breaker.js';
import assert from 'node:assert';

let failures = 0;
function ok(name, fn) {
  try {
    fn();
    console.log(`  PASS  ${name}`);
  } catch (err) {
    failures++;
    console.log(`  FAIL  ${name}: ${err.message}`);
  }
}

// 可控的假時鐘
function makeClock(start = 0) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const baseConfig = {
  disabled: false,
  mode: 'block',
  windowMs: 60_000,
  maxStarts: 5,
  dupLimit: 3,
  cooldownMs: 30_000,
};

function silentWarn() {}

ok('rate：視窗內超過 maxStarts 即熔斷', () => {
  const clock = makeClock();
  const b = new CircuitBreaker({ config: baseConfig, now: clock.now, warn: silentWarn });
  // 5 次不同 prompt 都應放行（達上限但未超過）
  for (let i = 0; i < 5; i++) b.check('codex', `prompt-${i}`);
  // 第 6 次超過 maxStarts → 應丟錯
  assert.throws(() => b.check('codex', 'prompt-6'), /熔斷器攔截/);
  assert.strictEqual(b.isOpen(), true, '應進入開路狀態');
});

ok('duplicate：同一 prompt 超過 dupLimit 即熔斷', () => {
  const clock = makeClock();
  const b = new CircuitBreaker({ config: baseConfig, now: clock.now, warn: silentWarn });
  b.check('claude', '一樣的請求');
  b.check('claude', '一樣的請求');
  b.check('claude', '一樣的請求'); // 第 3 次，達 dupLimit
  assert.throws(() => b.check('claude', '一樣的請求'), /重複/);
});

ok('冷卻期內持續擋下，冷卻結束後恢復', () => {
  const clock = makeClock();
  const b = new CircuitBreaker({ config: baseConfig, now: clock.now, warn: silentWarn });
  for (let i = 0; i < 5; i++) b.check('codex', `p-${i}`);
  assert.throws(() => b.check('codex', 'trip'));        // 觸發開路
  clock.advance(10_000);
  assert.throws(() => b.check('codex', 'still-open'));  // 冷卻中仍擋
  clock.advance(30_000);                                 // 超過 cooldownMs(30s)
  assert.doesNotThrow(() => b.check('codex', 'recovered')); // 應恢復
  assert.strictEqual(b.isOpen(), false);
});

ok('滑動視窗：舊事件過期後不再累計', () => {
  const clock = makeClock();
  const b = new CircuitBreaker({ config: baseConfig, now: clock.now, warn: silentWarn });
  for (let i = 0; i < 5; i++) b.check('codex', `p-${i}`);
  clock.advance(61_000); // 整個視窗(60s)過期
  // 視窗清空後，連續啟動不應立刻熔斷
  assert.doesNotThrow(() => {
    for (let i = 0; i < 5; i++) b.check('codex', `q-${i}`);
  });
});

ok('disabled=true 永不熔斷', () => {
  const clock = makeClock();
  const cfg = { ...baseConfig, disabled: true };
  const b = new CircuitBreaker({ config: cfg, now: clock.now, warn: silentWarn });
  assert.doesNotThrow(() => {
    for (let i = 0; i < 100; i++) b.check('codex', 'same');
  });
});

ok('warn 模式：偵測到迴圈仍放行，但會警告', () => {
  const clock = makeClock();
  const cfg = { ...baseConfig, mode: 'warn' };
  let warned = 0;
  const b = new CircuitBreaker({ config: cfg, now: clock.now, warn: () => warned++ });
  for (let i = 0; i < 10; i++) b.check('codex', 'loop');
  assert.ok(warned > 0, '應至少警告一次');
  assert.strictEqual(b.isOpen(), false, 'warn 模式不開路');
});

console.log(failures === 0 ? '\n全部通過 ✅' : `\n有 ${failures} 項失敗 ❌`);
process.exit(failures === 0 ? 0 : 1);
