/**
 * `ai-cli exec` — **前景**執行契約。
 *
 * ── 與既有 `run` 的關係 ───────────────────────────────────────
 * `run` 不動：它是「背景啟動、之後回來拿結果」，那是它的功能。
 * `exec` 是給**監督者**用的：呼叫端要自己擁有這個程序、自己收 stdout、
 * 自己判斷終態。兩者共用 catalog / binary resolver / command builder。
 *
 * ── 三條不可協商的規則 ────────────────────────────────────────
 * 1. **能力 fail-closed**：agent 沒有 `buildStrictCommand` 就拒絕啟動，
 *    **不退回** `buildCommand`（那會帶著 `--dangerously-*` 全開權限跑，
 *    而呼叫端以為有限制）。
 * 2. **terminal frame 必須等三件事齊全**：child close、stdout EOF、
 *    stderr EOF。少等任何一個，最後幾個 byte 會在「已完成」之後才到，
 *    而呼叫端已經把那次執行封存了——那就是無聲的資料遺失。
 * 3. **不得用立即 `process.exit()`**：stdout 是 pipe 時非同步，
 *    最後一個 frame 可能還在緩衝區。設 `exitCode` 讓事件迴圈自然收乾淨。
 *
 * ── 為什麼 stdout 走 base64 ───────────────────────────────────
 * vendor 的 stdout 是**位元組流**，不是字串。從任意位置切開再
 * `toString('utf-8')` 會把跨界的多位元字元切壞（既有的觀察介面就有
 * 這個 bug）。base64 讓呼叫端拿回原封不動的 bytes。
 */

import { spawn } from 'node:child_process';
import { buildCliCommand } from '../core/command-builder.js';
import { inspectCliBinary } from '../core/binary-resolver.js';
import { listAgents, selectAgentForModel } from '../agents/registry.js';
import { resolveModelAlias } from '../models/catalog.js';
import type { AgentDefinition } from '../agents/types.js';

export interface ExecRequest {
  cwd: string;
  model: string;
  prompt: string;
  reasoningEffort?: string;
  /** 這次執行允許的能力。空陣列 = 什麼都不准，仍會啟動（純問答）。 */
  capabilities?: string[];
  sessionId?: string;
}

/** 一個 NDJSON frame。`v` 是協定版本，呼叫端必須檢查。 */
type Frame =
  | {
      v: 1;
      type: 'started';
      vendor: string;
      requestedModel: string;
      resolvedModel: string;
      command: string;
      args: string[];
    }
  | { v: 1; type: 'stdout'; seq: number; encoding: 'base64'; data: string }
  | {
      v: 1;
      type: 'terminal';
      status: 'succeeded' | 'failed' | 'spawn-failed';
      exitCode: number | null;
      signal: string | null;
      detail: string | null;
    };

function writeFrame(frame: Frame): void {
  process.stdout.write(`${JSON.stringify(frame)}\n`);
}

function parseRequest(raw: string): ExecRequest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`stdin 不是合法的 JSON：${(error as Error).message}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('stdin 必須是一個 JSON 物件');
  }
  const row = parsed as Record<string, unknown>;
  for (const key of ['cwd', 'model', 'prompt'] as const) {
    if (typeof row[key] !== 'string' || (row[key] as string).trim() === '') {
      throw new Error(`缺少必要欄位或不是非空字串：${key}`);
    }
  }
  const capabilities = row['capabilities'];
  if (capabilities !== undefined && !Array.isArray(capabilities)) {
    throw new Error('capabilities 必須是陣列');
  }
  return {
    cwd: row['cwd'] as string,
    model: row['model'] as string,
    prompt: row['prompt'] as string,
    ...(typeof row['reasoningEffort'] === 'string'
      ? { reasoningEffort: row['reasoningEffort'] }
      : {}),
    ...(Array.isArray(capabilities) ? { capabilities: capabilities.map(String) } : {}),
    ...(typeof row['sessionId'] === 'string' ? { sessionId: row['sessionId'] } : {}),
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    process.stdin.on('data', (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    process.stdin.on('error', reject);
  });
}

function resolveCliPaths(): Record<string, string> {
  const paths: Record<string, string> = {};
  for (const agent of listAgents()) {
    if (!agent.binary) continue;
    const status = inspectCliBinary(agent.binary);
    if (status.resolvedPath !== null) paths[agent.id] = status.resolvedPath;
  }
  return paths;
}

export async function runExec(): Promise<number> {
  let request: ExecRequest;
  try {
    request = parseRequest(await readStdin());
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: (error as Error).message,
    });
    return 2;
  }

  let agent: AgentDefinition;
  let built: ReturnType<typeof buildCliCommand>;
  try {
    const resolvedModel = resolveModelAlias(request.model);
    agent = selectAgentForModel(resolvedModel);
    /*
      ★ fail-closed 的那一行。沒有嚴格模式就拒絕——**不退回**
        buildCommand，那會帶著 --dangerously-* 全開權限跑。
    */
    if (typeof agent.buildStrictCommand !== 'function') {
      throw new Error(
        `agent「${agent.id}」沒有嚴格模式（buildStrictCommand），exec 拒絕啟動。` +
          '退回一般模式會帶著權限旁路執行，而呼叫端以為有限制——不做這件事。'
      );
    }
    built = buildCliCommand({
      workFolder: request.cwd,
      prompt: request.prompt,
      model: request.model,
      cliPaths: resolveCliPaths(),
      ...(request.reasoningEffort !== undefined
        ? { reasoning_effort: request.reasoningEffort }
        : {}),
      ...(request.sessionId !== undefined ? { session_id: request.sessionId } : {}),
      // buildCliCommand 會呼叫 agent.buildCommand；我們只借它的模型/prompt 解析，
      // 指令本身下面用 buildStrictCommand 重組。
    });
    built = agent.buildStrictCommand(
      {
        cliPath: built.cliPath,
        cwd: built.cwd,
        prompt: built.prompt,
        resolvedModel: built.resolvedModel,
        rawModel: request.model,
        reasoningEffort: request.reasoningEffort ?? '',
        ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
      },
      request.capabilities ?? []
    );
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: (error as Error).message,
    });
    return 2;
  }

  if (built.cliPath.trim() === '') {
    /*
      解析不到二進位檔。**在 started 之前**就回報——送出 started 再失敗，
      呼叫端會以為程序真的起來過。
    */
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: `找不到 agent「${built.agent}」的 CLI 二進位檔，無法啟動。`,
    });
    return 2;
  }

  writeFrame({
    v: 1,
    type: 'started',
    vendor: built.agent,
    requestedModel: request.model,
    resolvedModel: built.resolvedModel,
    command: built.cliPath,
    args: [...built.args],
  });

  const usesStdin = typeof built.stdinPrompt === 'string';
  /*
    `detached: false` 是**刻意**的，而且是 exec 的核心：呼叫端要能
    把這個程序放進自己的程序群／Job 管起來。背景路徑走 `run`。
  */
  /*
    ★ `spawn()` 會**同步丟例外**（例如 argv 含 NUL、命令列過長）。
      不接住的話這個行程會直接死掉，而呼叫端只收到 started、沒有
      terminal——它只能標 unknown，卻是我們本來說得出原因的。
  */
  let child: ReturnType<typeof spawn>;
  try {
    child = spawn(built.cliPath, built.args, {
      cwd: built.cwd,
      stdio: [usesStdin ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
      windowsHide: true,
    });
  } catch (error) {
    writeFrame({
      v: 1,
      type: 'terminal',
      status: 'spawn-failed',
      exitCode: null,
      signal: null,
      detail: `spawn 同步失敗：${(error as Error).message}`,
    });
    return 2;
  }

  let seq = 0;
  let stdoutEnded = false;
  let stderrEnded = false;
  let closed = false;
  let exitCode: number | null = null;
  let signal: string | null = null;
  let spawnError: string | null = null;

  const finish = (resolve: (code: number) => void): void => {
    // ★ 三件事都齊全才送 terminal。少等任何一個 = 無聲的資料遺失。
    if (!(stdoutEnded && stderrEnded && closed)) return;
    if (spawnError !== null) {
      writeFrame({
        v: 1,
        type: 'terminal',
        status: 'spawn-failed',
        exitCode: null,
        signal: null,
        detail: spawnError,
      });
      resolve(2);
      return;
    }
    writeFrame({
      v: 1,
      type: 'terminal',
      status: exitCode === 0 ? 'succeeded' : 'failed',
      exitCode,
      signal,
      detail: null,
    });
    // vendor 的 exit code 原樣透傳，不吃掉、不一律回 0。
    resolve(exitCode ?? 1);
  };

  const code = await new Promise<number>((resolve) => {
    child.on('error', (error) => {
      spawnError = error.message;
      stdoutEnded = true;
      stderrEnded = true;
      closed = true;
      finish(resolve);
    });
    child.stdout?.on('data', (chunk: Buffer) => {
      seq += 1;
      writeFrame({ v: 1, type: 'stdout', seq, encoding: 'base64', data: chunk.toString('base64') });
    });
    child.stdout?.on('end', () => {
      stdoutEnded = true;
      finish(resolve);
    });
    // vendor 的 stderr 原樣轉送到我們自己的 stderr——不進 frame，
    // 也不由我們加工。診斷訊息混進 stdout 會汙染協定。
    child.stderr?.on('data', (chunk: Buffer) => process.stderr.write(chunk));
    child.stderr?.on('end', () => {
      stderrEnded = true;
      finish(resolve);
    });
    child.on('close', (childCode, childSignal) => {
      exitCode = childCode;
      signal = childSignal;
      closed = true;
      finish(resolve);
    });
    if (usesStdin && child.stdin) {
      child.stdin.end(built.stdinPrompt);
    }
  });

  return code;
}
