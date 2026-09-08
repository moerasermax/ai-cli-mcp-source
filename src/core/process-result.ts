/** 組裝對外回傳的 process result。1:1 還原 dist/process-result.js。 */

import type { AgentId } from '../agents/types.js';
import type { ProcessLiveness } from './liveness.js';
import { verificationFromAgentOutput, type VerificationReport } from './verification.js';

/**
 * 哪些 agent 的終局 parser 會留下結構化工具紀錄。
 * antigravity 只有純文字輸出，「沒看到驗證」不等於「沒驗證」，只能回 not_observed。
 */
const STRUCTURED_TOOL_HISTORY: Record<string, boolean> = {
  claude: true,
  codex: true,
  'direct-api': true,
  antigravity: false,
};

export interface ProcessResultContext {
  pid: number;
  agent: AgentId;
  status: string;
  exitCode?: number;
  startTime: string;
  workFolder: string;
  prompt: string;
  model?: string;
  stdout: string;
  stderr: string;
  liveness?: ProcessLiveness;
}

function compactAgentOutput(agentOutput: any): any {
  if (!agentOutput || typeof agentOutput !== 'object') {
    return null;
  }
  const { tools: _tools, ...rest } = agentOutput;
  const compact = Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined && value !== null)
  );
  return Object.keys(compact).length > 0 ? compact : null;
}

function shapeAgentOutput(agent: AgentId, agentOutput: any, verbose: boolean): any {
  return verbose ? agentOutput : compactAgentOutput(agentOutput);
}

function hasMeaningfulParsedOutput(agentOutput: any): boolean {
  if (!agentOutput || typeof agentOutput !== 'object') {
    return false;
  }
  return Object.entries(agentOutput).some(([key, value]) => {
    if (value === undefined || value === null) {
      return false;
    }
    if (key === 'session_id') {
      return false;
    }
    if (key === 'tools') {
      return Array.isArray(value) ? value.length > 0 : true;
    }
    return true;
  });
}

function shouldPreserveRawFailureOutput(context: ProcessResultContext): boolean {
  return context.status === 'failed' && false;
}

/**
 * 還在跑的程序只能回 pending——工具紀錄還沒完整，這時候說 passed 會是謊話。
 * 終局狀態才交給 classifyVerification 依事件順序判定。
 */
function buildVerification(
  context: ProcessResultContext,
  agentOutput: any
): (VerificationReport & { status: string }) | { status: 'pending'; reason: string } | null {
  if (context.status === 'running') {
    return {
      status: 'pending',
      reason: 'the agent is still running; verification can only be judged once it finishes',
    };
  }
  const structured = STRUCTURED_TOOL_HISTORY[context.agent] ?? true;
  return verificationFromAgentOutput(agentOutput, { structured });
}

export function buildProcessResult(
  context: ProcessResultContext,
  agentOutput: any,
  verbose = false
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    pid: context.pid,
    agent: context.agent,
    status: context.status,
    exitCode: context.exitCode ?? null,
    model: context.model ?? null,
  };
  if (context.status === 'running' && context.liveness) {
    response.liveness = context.liveness;
  }
  /*
    驗證狀態一律回報，compact 也不拿掉。

    呼叫端是 AI，它只看得到工具回傳；回傳沒說「這次改了程式碼但沒驗證」，
    它就會把子 agent 的「我做完了」當成做完了。這是 2026-09-08 量到的最大
    品質缺口（有改到程式碼的工作段有 31.7% 完全沒跑 test/build），所以這欄
    的存在意義就是被看見——放進 verbose-only 等於沒做。
  */
  const verification = buildVerification(context, agentOutput);
  if (verification) {
    response.verification = verification;
  }
  if (verbose) {
    response.startTime = context.startTime;
    response.workFolder = context.workFolder;
    response.prompt = context.prompt;
  }
  if (agentOutput?.session_id) {
    response.session_id = agentOutput.session_id;
  }
  const shapedAgentOutput = shapeAgentOutput(context.agent, agentOutput, verbose);
  const preserveRawFailureOutput = shouldPreserveRawFailureOutput(context);
  if (hasMeaningfulParsedOutput(shapedAgentOutput) && (verbose || !preserveRawFailureOutput)) {
    response.agentOutput = shapedAgentOutput;
  }
  if (!response.agentOutput || preserveRawFailureOutput) {
    response.stdout = context.stdout;
    response.stderr = context.stderr;
  }
  if (verbose && preserveRawFailureOutput && hasMeaningfulParsedOutput(shapedAgentOutput)) {
    response.agentOutput = shapedAgentOutput;
  }
  return response;
}
