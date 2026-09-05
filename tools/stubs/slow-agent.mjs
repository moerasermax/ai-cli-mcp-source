#!/usr/bin/env node
/** 不連供應商的 Codex NDJSON stub；故意慢回覆，供 wait/liveness 回歸測試。 */
process.stdin.resume(); // 忽略所有參數，讀完 stdin 後直接丟掉。
const emit = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const total = Number(process.env.SLOW_AGENT_TOTAL_SEC ?? 6);
emit({ type: 'thread.started', thread_id: 'stub' });
let tick = 0;
const interval = setInterval(() => {
  emit({ type: 'item.completed', item: { type: 'reasoning', text: `tick ${++tick}` } });
}, 1000);
setTimeout(() => {
  clearInterval(interval);
  emit({ type: 'item.completed', item: { type: 'agent_message', text: 'PONG' } });
  emit({ type: 'turn.completed' });
  process.stdin.destroy();
  process.exitCode = 0;
}, (Number.isFinite(total) && total >= 0 ? total : 6) * 1000);
