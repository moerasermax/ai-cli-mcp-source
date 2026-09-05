/**
 * MCP 與 CLI 共用的存活資訊與輪詢提示。
 * alive 只代表程序尚在，不代表模型一定有進展；無輸出不能推論失敗。
 */

export interface ProcessOutputStats {
  lastOutputAt: string | null;
  stdoutBytes: number;
  stderrBytes: number;
  lastEvent: string | null;
  eventCount: number;
}

export interface ProcessLiveness {
  alive: boolean;
  elapsedSec: number;
  sinceLastOutputSec: number | null;
  stdoutBytes: number;
  stderrBytes: number;
  lastEvent: string | null;
  eventCount: number;
  hint: string;
}

export function emptyOutputStats(): ProcessOutputStats {
  return { lastOutputAt: null, stdoutBytes: 0, stderrBytes: 0, lastEvent: null, eventCount: 0 };
}

export function elapsedSeconds(startTime: string, endTime: string | number = Date.now()): number {
  const end = typeof endTime === 'number' ? endTime : Date.parse(endTime);
  return Math.max(0, (end - Date.parse(startTime)) / 1000);
}

export function buildLiveness(
  stats: ProcessOutputStats,
  startTime: string,
  alive: boolean,
  now = Date.now()
): ProcessLiveness {
  const elapsedSec = elapsedSeconds(startTime, now);
  const sinceLastOutputSec = stats.lastOutputAt === null ? null : elapsedSeconds(stats.lastOutputAt, now);
  let hint: string;
  if (!alive) {
    hint = 'process is no longer alive; awaiting exit-status metadata (lost if no terminal report arrives)';
  } else if (sinceLastOutputSec !== null) {
    const seconds = Math.floor(sinceLastOutputSec);
    hint = sinceLastOutputSec < 120
      ? `still working; last output ${seconds}s ago — keep waiting`
      : `no output for ${seconds}s but the process is alive; codex/claude emit nothing while reasoning — keep waiting or peek`;
  } else {
    hint = elapsedSec < 30
      ? 'starting up'
      : `alive but silent for ${Math.floor(elapsedSec)}s since start — keep waiting or peek`;
  }
  return {
    alive,
    elapsedSec,
    sinceLastOutputSec,
    stdoutBytes: stats.stdoutBytes,
    stderrBytes: stats.stderrBytes,
    lastEvent: stats.lastEvent,
    eventCount: stats.eventCount,
    hint,
  };
}

/** list 的扁平摘要與完整 liveness 使用同一份時間快照。 */
export function listProcessTiming(startTime: string, endTime?: string, liveness?: ProcessLiveness) {
  if (liveness) {
    return {
      liveness,
      elapsedSec: liveness.elapsedSec,
      sinceLastOutputSec: liveness.sinceLastOutputSec,
      lastEvent: liveness.lastEvent,
    };
  }
  return endTime ? { elapsedSec: elapsedSeconds(startTime, endTime) } : {};
}
