/**
 * 記憶體版 process 管理服務（MCP 路徑使用）。
 * 對應 dist/process-service.js，但 spawn 決策改由 agent 定義驅動：
 *   - agent.win32SpawnMode === 'pty' 且 win32 → ConPTY（agy）
 *   - 否則一般 pipe spawn；win32 的 shell 由 agent.win32DirectExec 決定
 *
 * parser 改呼叫 agent.parseOutput；preserveRawOnFailure 由 process-result 處理。
 */

import { spawn, type ChildProcess } from 'node:child_process';
import type { AgentId } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { buildCliCommand, type BuildCliCommandOptions } from './command-builder.js';
import { buildProcessResult } from './process-result.js';
import {
  PeekEventExtractor,
} from './peek-extractor.js';
import {
  appendPeekEvents,
  buildNotFoundPeekProcess,
  observedDurationSec,
  validatePeekPids,
  validatePeekTimeSec,
  type PeekProcessResult,
} from './peek.js';
import { spawnPty, type PtyChild } from './pty-runner.js';
import { CircuitBreaker } from './circuit-breaker.js';

export interface CliPaths {
  claude: string;
  codex: string;
  antigravity: string;
  kiro: string;
  forge: string;
  opencode: string;
}

export interface StartProcessOptions {
  prompt?: string;
  prompt_file?: string;
  workFolder: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
}

type ManagedProcess = ChildProcess | PtyChild;

interface ProcessEntry {
  pid: number;
  process: ManagedProcess;
  prompt: string;
  workFolder: string;
  model?: string;
  toolType: AgentId;
  startTime: string;
  stdout: string;
  stderr: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}

export class ProcessService {
  private processManager = new Map<number, ProcessEntry>();
  private cliPaths: CliPaths;
  private breaker: CircuitBreaker;

  constructor(options: { cliPaths: CliPaths; breaker?: CircuitBreaker }) {
    this.cliPaths = options.cliPaths;
    this.breaker = options.breaker ?? new CircuitBreaker();
  }

  startProcess(options: StartProcessOptions): {
    pid: number;
    status: string;
    agent: AgentId;
    message: string;
  } {
    const cmd = buildCliCommand({
      ...options,
      cliPaths: this.cliPaths as Record<AgentId, string>,
    } as BuildCliCommandOptions);

    // 熔斷器：偵測框架迴圈造成的爆量/重複啟動，啟動前先攔截。
    this.breaker.check(cmd.agent, cmd.prompt);

    const agent = getAgent(cmd.agent);
    const isWin = process.platform === 'win32';
    const spawnMode = isWin && agent.win32SpawnMode ? agent.win32SpawnMode : agent.spawnMode || 'pipe';

    if (spawnMode === 'pty') {
      return this.startPtyProcess(cmd, options.model);
    }

    // 一般 pipe spawn
    const useStdinPrompt = typeof cmd.stdinPrompt === 'string';
    const needsShell = isWin && !agent.win32DirectExec;
    // Windows: 不用 shell:true（Node v24 DEP0190 + 沙盒 EFTYPE），
    // 改走明確 cmd.exe /c，跟 cross-spawn 相同策略。
    let spawnCmd: string;
    let spawnArgs: string[];
    if (needsShell) {
      const comSpec = process.env.ComSpec || process.env.COMSPEC || 'cmd.exe';
      spawnCmd = comSpec;
      spawnArgs = ['/d', '/s', '/c', `""${cmd.cliPath}" ${cmd.args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}"`];
    } else {
      spawnCmd = cmd.cliPath;
      spawnArgs = cmd.args;
    }
    const childProcess = spawn(spawnCmd, spawnArgs, {
      cwd: cmd.cwd,
      stdio: [useStdinPrompt ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: false,
      shell: false,
      windowsVerbatimArguments: needsShell,
      env: process.env,
    });

    // 立即掛 error listener，避免 async spawn error 變成 uncaughtException 殺掉 MCP server
    childProcess.on('error', (error) => {
      const entry = childProcess.pid ? this.processManager.get(childProcess.pid) : undefined;
      if (entry) {
        entry.status = 'failed';
        entry.stderr += `\nProcess error: ${error.message}`;
      }
    });

    if (useStdinPrompt && childProcess.stdin) {
      childProcess.stdin.on('error', () => {});
      try {
        childProcess.stdin.write(cmd.stdinPrompt as string);
        childProcess.stdin.end();
      } catch {
        /* child 可能已死；error/close handler 會處理 */
      }
    }

    const pid = childProcess.pid;
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process`);
    }

    const entry: ProcessEntry = {
      pid,
      process: childProcess,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      model: options.model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdout: '',
      stderr: '',
      status: 'running',
    };
    this.processManager.set(pid, entry);

    childProcess.stdout?.on('data', (data) => {
      const e = this.processManager.get(pid);
      if (e) e.stdout += data.toString();
    });
    childProcess.stderr?.on('data', (data) => {
      const e = this.processManager.get(pid);
      if (e) e.stderr += data.toString();
    });
    childProcess.on('close', (code) => {
      const e = this.processManager.get(pid);
      if (e) {
        e.status = code === 0 ? 'completed' : 'failed';
        e.exitCode = code !== null ? code : undefined;
      }
    });

    return { pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully` };
  }

  private startPtyProcess(
    cmd: ReturnType<typeof buildCliCommand>,
    model?: string
  ): { pid: number; status: string; agent: AgentId; message: string } {
    const { pid, child } = spawnPty(cmd.cliPath, cmd.args, cmd.cwd, (code, killedByUser) => {
      const entryRef = this.processManager.get(pid);
      if (entryRef) {
        // 在 emit('close') 前同步更新狀態，避免 waitForProcesses 漏接
        entryRef.status = killedByUser ? 'failed' : code === 0 ? 'completed' : 'failed';
        entryRef.exitCode = code ?? undefined;
        if (killedByUser && !entryRef.stderr.includes('Process terminated by user')) {
          entryRef.stderr += '\nProcess terminated by user';
        }
      }
    });

    const entry: ProcessEntry = {
      pid,
      process: child,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdout: '',
      stderr: '',
      status: 'running',
    };
    this.processManager.set(pid, entry);

    child.stdout.on('data', (chunk) => {
      const e = this.processManager.get(pid);
      if (e) e.stdout += chunk.toString();
    });

    return {
      pid,
      status: 'started',
      agent: cmd.agent,
      message: `${cmd.agent} process started successfully (pty mode)`,
    };
  }

  listProcesses(): Array<{ pid: number; agent: AgentId; status: string }> {
    const processes: Array<{ pid: number; agent: AgentId; status: string }> = [];
    for (const [pid, proc] of this.processManager.entries()) {
      processes.push({ pid, agent: proc.toolType, status: proc.status });
    }
    return processes;
  }

  getProcessResult(pid: number, verbose = false): Record<string, unknown> {
    const proc = this.processManager.get(pid);
    if (!proc) {
      throw new Error(`Process with PID ${pid} not found`);
    }
    const agent = getAgent(proc.toolType);
    const agentOutput = agent.parseOutput(proc.stdout, proc.stderr, proc.exitCode);
    return buildProcessResult(
      {
        pid,
        agent: proc.toolType,
        status: proc.status,
        exitCode: proc.exitCode,
        startTime: proc.startTime,
        workFolder: proc.workFolder,
        prompt: proc.prompt,
        model: proc.model,
        stdout: proc.stdout,
        stderr: proc.stderr,
      },
      agentOutput,
      verbose
    );
  }

  async waitForProcesses(
    pids: number[],
    timeoutSeconds = 180,
    verbose = false
  ): Promise<Array<Record<string, unknown>>> {
    for (const pid of pids) {
      if (!this.processManager.has(pid)) {
        throw new Error(`Process with PID ${pid} not found`);
      }
    }
    const waitPromises = pids.map((pid) => {
      const entry = this.processManager.get(pid)!;
      if (entry.status !== 'running') {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        entry.process.once('close', () => resolve());
      });
    });

    const timeoutMs = timeoutSeconds * 1000;
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => {
        reject(new Error(`Timed out after ${timeoutSeconds} seconds waiting for processes`));
      }, timeoutMs);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([Promise.all(waitPromises), timeoutPromise]);
      return pids.map((pid) => this.getProcessResult(pid, verbose));
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  async peekProcesses(
    pids: number[],
    peekTimeSec = 10,
    includeToolCalls = false
  ): Promise<{ peek_started_at: string; observed_duration_sec: number; processes: PeekProcessResult[] }> {
    const targetPids = validatePeekPids(pids);
    const targetPeekTimeSec = validatePeekTimeSec(peekTimeSec);
    const processes: PeekProcessResult[] = [];
    const observers: Array<{
      entry: ProcessEntry;
      result: PeekProcessResult;
      stdoutExtractor: PeekEventExtractor;
      stderrExtractor: PeekEventExtractor;
      onStdout: (data: Buffer | string) => void;
      onStderr: (data: Buffer | string) => void;
    }> = [];

    for (const pid of targetPids) {
      const entry = this.processManager.get(pid);
      if (!entry) {
        processes.push(buildNotFoundPeekProcess(pid));
        continue;
      }
      const result: PeekProcessResult = {
        pid,
        agent: entry.toolType,
        status: entry.status,
        events: [],
        truncated: false,
        error: null,
      };
      processes.push(result);
      const stdoutExtractor = new PeekEventExtractor(entry.toolType, { includeToolCalls, source: 'stdout' });
      const stderrExtractor = new PeekEventExtractor(entry.toolType, { includeToolCalls, source: 'stderr' });
      const onStdout = (data: Buffer | string) => {
        appendPeekEvents(result, stdoutExtractor.push(data.toString(), new Date().toISOString()));
      };
      const onStderr = (data: Buffer | string) => {
        appendPeekEvents(result, stderrExtractor.push(data.toString(), new Date().toISOString()));
      };
      if (entry.status === 'running') {
        entry.process.stdout?.on('data', onStdout);
        entry.process.stderr?.on('data', onStderr);
      }
      observers.push({ entry, result, stdoutExtractor, stderrExtractor, onStdout, onStderr });
    }

    const startedAt = new Date();
    const startedAtMs = Date.now();
    const runningObservers = observers.filter((o) => o.entry.status === 'running');
    const terminalPromise = Promise.all(
      runningObservers.map((o) => this.waitForProcessTerminal(o.entry))
    );
    let timeoutHandle: NodeJS.Timeout | undefined;
    const timeoutPromise = new Promise<void>((resolve) => {
      timeoutHandle = setTimeout(resolve, targetPeekTimeSec * 1000);
      timeoutHandle.unref?.();
    });

    try {
      await Promise.race([terminalPromise, timeoutPromise]);
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      const flushTs = new Date().toISOString();
      for (const o of observers) {
        o.entry.process.stdout?.off('data', o.onStdout);
        o.entry.process.stderr?.off('data', o.onStderr);
        const terminal = o.entry.status !== 'running';
        appendPeekEvents(o.result, o.stdoutExtractor.flush(flushTs, { terminal }));
        appendPeekEvents(o.result, o.stderrExtractor.flush(flushTs, { terminal }));
        o.result.status = o.entry.status;
      }
    }

    return {
      peek_started_at: startedAt.toISOString(),
      observed_duration_sec: observedDurationSec(startedAtMs),
      processes,
    };
  }

  private waitForProcessTerminal(entry: ProcessEntry): Promise<void> {
    if (entry.status !== 'running') {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      const done = () => {
        entry.process.off('close', done);
        entry.process.off('error', done);
        resolve();
      };
      entry.process.once('close', done);
      entry.process.once('error', done);
    });
  }

  killProcess(pid: number): { pid: number; status: string; message: string } {
    const entry = this.processManager.get(pid);
    if (!entry) {
      throw new Error(`Process with PID ${pid} not found`);
    }
    if (entry.status !== 'running') {
      return { pid, status: entry.status, message: 'Process already terminated' };
    }
    entry.process.kill('SIGTERM');
    entry.status = 'failed';
    entry.stderr += '\nProcess terminated by user';
    return { pid, status: 'terminated', message: 'Process terminated successfully' };
  }

  cleanupProcesses(): { removed: number; removedPids: number[]; message: string } {
    const removedPids: number[] = [];
    for (const [pid, proc] of this.processManager.entries()) {
      if (proc.status === 'completed' || proc.status === 'failed') {
        removedPids.push(pid);
        this.processManager.delete(pid);
      }
    }
    return {
      removed: removedPids.length,
      removedPids,
      message: `Cleaned up ${removedPids.length} finished process(es)`,
    };
  }
}
