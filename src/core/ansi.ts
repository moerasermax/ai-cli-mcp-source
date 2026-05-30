/**
 * ANSI 控制序列清理。
 * 用於 PTY 輸出（agy print mode 會吐 CSI/OSC/DCS 等序列）與 kiro 純文字輸出。
 * 1:1 還原自 dist 的 strip 邏輯（process-service.js + peek.js 用的較完整版本）。
 */

const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_STR_DCS = /\x1b[PX^_][^\x1b]*\x1b\\/g; // DCS / SOS / PM / APC
const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const ANSI_TWO_CHAR = /\x1b[()][AB012]|\x1b[=>78cDEHMZ]/g;

export function stripAnsi(value: unknown): string {
  return String(value ?? '')
    .replace(ANSI_OSC, '')
    .replace(ANSI_STR_DCS, '')
    .replace(ANSI_CSI, '')
    .replace(ANSI_TWO_CHAR, '');
}
