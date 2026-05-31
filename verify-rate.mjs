// 純邏輯驗證：直接餵 33 次不同 prompt 給已編譯的 CircuitBreaker，
// 確認 rate 門檻（maxStarts=30）在第 31 次觸發。不啟動任何 AI 子程序。
import { CircuitBreaker, loadCircuitBreakerConfig } from './dist/core/circuit-breaker.js';

const cfg = loadCircuitBreakerConfig();
console.log('loaded config =', cfg);

// 注入固定時鐘：全部視為同一毫秒 → 全落在同一 60s 視窗。
let clock = 1_000_000;
const breaker = new CircuitBreaker({ now: () => clock, warn: () => {} });

let firstTrip = null;
for (let i = 1; i <= 33; i++) {
  try {
    breaker.check('claude', `RATE_SIM_${i}: reply OK`); // 每個 prompt 不同 → 不該觸發 duplicate
    // console.log(`#${i} passed`);
  } catch (e) {
    firstTrip = { i, reason: e.reason, retryAfterSec: e.retryAfterSec };
    console.log(`#${i} BLOCKED → reason=${e.reason} retryAfter=${e.retryAfterSec}s`);
    break;
  }
}

console.log('firstTrip =', firstTrip);
console.log(firstTrip && firstTrip.i === 31 && firstTrip.reason === 'rate'
  ? 'PASS: 第 31 次以 rate 觸發，dist 邏輯正確'
  : 'UNEXPECTED: 與預期不符');
