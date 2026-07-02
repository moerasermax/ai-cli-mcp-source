/**
 * 檔案版 process 管理服務（`ai-cli` CLI 的 detached 路徑使用）。
 * 對應 dist/cli-process-service.js。
 *
 * 與記憶體版的差異：process 用 detached 方式啟動，stdout/stderr 寫入檔案，
 * 狀態存在 meta.json / exit-status.json，因此可跨 CLI 行程查詢（run 後另一個
 * 行程 result/wait）。非 agy 的 detached 走 sh wrapper（POSIX；Windows 需有 sh，
 * 例如 git-bash）。agy/win32 走 ConPTY，輸出寫入檔案。
 *
 * spawn/parser 決策改由 registry 驅動。
 */

import { spawn } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { homedir } from 'node:os';
import { createRequire } from 'node:module';
import type { AgentId } from '../agents/types.js';
import { getAgent } from '../agents/registry.js';
import { buildCliCommand, type BuildCliCommandOptions } from './command-builder.js';
import { resolveAllCliPaths } from './doctor.js';
import { buildProcessResult } from './process-result.js';
import { stripAnsi } from './ansi.js';
import { CircuitBreaker } from './circuit-breaker.js';
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

const SIGTERM_EXIT_CODE = 143;

const patchRequire = createRequire(import.meta.url);
let ptyModule: any = null;
function loadPtyModule(): any {
  if (ptyModule) return ptyModule;
  ptyModule = patchRequire('@homebridge/node-pty-prebuilt-multiarch');
  return ptyModule;
}

function resolveDefaultStateDir(): string {
  return process.env.AI_CLI_STATE_DIR || join(homedir(), '.local', 'state', 'ai-cli');
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return true;
    return false;
  }
}

function normalizeCwdForStorage(cwd: string): string {
  return cwd
    .split('')
    .map((char) =>
      /^[A-Za-z0-9.-]$/.test(char) ? char : `_${char.charCodeAt(0).toString(16).padStart(2, '0')}`
    )
    .join('');
}

interface StoredProcess {
  pid: number;
  prompt: string;
  workFolder: string;
  cwdKey: string;
  model?: string;
  toolType: AgentId;
  startTime: string;
  stdoutPath: string;
  stderrPath: string;
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}

export interface FileStartOptions {
  prompt?: string;
  prompt_file?: string;
  cwd: string;
  model?: string;
  session_id?: string;
  reasoning_effort?: string;
}

export class FileProcessService {
  private stateDir: string;
  private cliPaths: Partial<Record<AgentId, string>>;
  private ptyManagedPids = new Set<number>();
  private breaker: CircuitBreaker;
  private directPidSequence = 0;

  constructor(
    options: { stateDir?: string; cliPaths?: Partial<Record<AgentId, string>>; breaker?: CircuitBreaker } = {}
  ) {
    this.stateDir = options.stateDir || resolveDefaultStateDir();
    this.cliPaths = options.cliPaths || resolveAllCliPaths();
    this.breaker = options.breaker ?? new CircuitBreaker();
    mkdirSync(this.stateDir, { recursive: true });
  }

  async startProcess(options: FileStartOptions) {
    const cmd = buildCliCommand({
      prompt: options.prompt,
      prompt_file: options.prompt_file,
      workFolder: options.cwd,
      model: options.model,
      session_id: options.session_id,
      reasoning_effort: options.reasoning_effort,
      cliPaths: this.cliPaths,
    } as BuildCliCommandOptions);
    // 熔斷器：偵測同一行程內框架迴圈造成的爆量/重複啟動。
    this.breaker.check(cmd.agent, cmd.prompt);
    return this.startDetachedTracked(cmd, options.model);
  }

  private async startDetachedTracked(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const agent = getAgent(cmd.agent);
    const isWin = process.platform === 'win32';
    const spawnMode = isWin && agent.win32SpawnMode ? agent.win32SpawnMode : agent.spawnMode || 'pipe';
    if (spawnMode === 'direct') {
      return this.startDirectTracked(cmd, model);
    }
    if (spawnMode === 'pty') {
      return this.startPtyTracked(cmd, model);
    }

    const cwdKey = this.resolveCwdKey(cmd.cwd);
    if (isWin) {
      return this.startDetachedWin32(cmd, cwdKey, model);
    }
    const wrapperPath = this.ensureDetachedWrapperScript();
    const childProcess = spawn(wrapperPath, [this.stateDir, cwdKey, cmd.cliPath, ...cmd.args], {
      cwd: cmd.cwd,
      detached: true,
      stdio: 'ignore',
    });
    const pid = childProcess.pid;
    childProcess.unref();
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process`);
    }
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    const stored: StoredProcess = {
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);
    return { pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully` };
  }

  private allocateDirectPid(): number {
    return Date.now() * 1000 + ++this.directPidSequence;
  }

  private async startDirectTracked(
    cmd: ReturnType<typeof buildCliCommand>,
    model?: string
  ): Promise<{ pid: number; status: string; agent: AgentId; message: string }> {
    const agent = getAgent(cmd.agent);
    if (!agent.runDirect) {
      throw new Error(`${cmd.agent} does not implement direct execution`);
    }
    const cwdKey = this.resolveCwdKey(cmd.cwd);
    const pid = this.allocateDirectPid();
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    const stored: StoredProcess = {
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);

    try {
      await agent.runDirect(cmd, {
        stdout: (chunk) => this.appendTextFileSafe(stdoutPath, chunk),
        stderr: (chunk) => this.appendTextFileSafe(stderrPath, chunk),
      });
      stored.status = 'completed';
      stored.exitCode = 0;
      this.writeExitStatus(stored, { status: 'completed', exitCode: 0 });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.appendTextFileSafe(stderrPath, `\nDirect API error: ${message}`);
      stored.status = 'failed';
      stored.exitCode = 1;
      this.writeExitStatus(stored, { status: 'failed', exitCode: 1 });
    }
    this.writeProcess(stored);
    return {
      pid,
      status: stored.status,
      agent: cmd.agent,
      message: `${cmd.agent} request ${stored.status}`,
    };
  }

  /**
   * Windows detached spawn：用 Node 腳本當 wrapper（避開 batch 引號地獄）。
   * Node 子程序可取得自己的 PID，對齊 FileProcessService 的 PID→目錄映射。
   */
  private startDetachedWin32(
    cmd: ReturnType<typeof buildCliCommand>,
    cwdKey: string,
    model?: string
  ): { pid: number; status: string; agent: AgentId; message: string } {
    const wrapperPath = this.ensureDetachedWrapperNodeWin32();
    const hasStdinPrompt = typeof cmd.stdinPrompt === 'string';

    // 把 spawn 資訊寫入暫存 JSON，wrapper 讀這個檔即可
    const specPath = join(this.stateDir, `spec_${Date.now()}_${Math.random().toString(36).slice(2, 6)}.json`);
    writeFileSync(specPath, JSON.stringify({
      stateDir: this.stateDir,
      cwdKey,
      cliPath: cmd.cliPath,
      args: cmd.args,
      cwd: cmd.cwd,
      stdinPrompt: hasStdinPrompt ? cmd.stdinPrompt : null,
    }), 'utf-8');

    const childProcess = spawn(process.execPath, [wrapperPath, specPath], {
      cwd: cmd.cwd,
      detached: true,
      stdio: 'ignore',
    });
    const pid = childProcess.pid;
    childProcess.unref();
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process`);
    }
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    const stored: StoredProcess = {
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);
    return { pid, status: 'started', agent: cmd.agent, message: `${cmd.agent} process started successfully` };
  }

  private async startPtyTracked(cmd: ReturnType<typeof buildCliCommand>, model?: string) {
    const pty = loadPtyModule();
    const cwdKey = this.resolveCwdKey(cmd.cwd);
    const ptyProc = pty.spawn(cmd.cliPath, cmd.args, {
      name: 'xterm-color',
      cols: 200,
      rows: 50,
      cwd: cmd.cwd,
      env: process.env,
    });
    const pid: number | undefined = ptyProc.pid;
    if (!pid) {
      throw new Error(`Failed to start ${cmd.agent} CLI process (pty.spawn returned no pid)`);
    }
    const processDir = this.resolveProcessDir(cmd.cwd, pid);
    mkdirSync(processDir, { recursive: true });
    const stdoutPath = this.resolveStdoutPath(processDir);
    const stderrPath = this.resolveStderrPath(processDir);
    const exitStatusPath = this.resolveExitStatusPath(processDir);
    this.touchFile(stdoutPath);
    this.touchFile(stderrPath);
    this.ptyManagedPids.add(pid);
    ptyProc.onData((d: string) => {
      try {
        appendFileSync(stdoutPath, stripAnsi(d));
      } catch {
        /* ignore */
      }
    });
    ptyProc.onExit(({ exitCode }: { exitCode: number }) => {
      const code = exitCode ?? 0;
      const status = code === 0 ? 'completed' : 'failed';
      try {
        const tmp = exitStatusPath + '.' + pid;
        writeFileSync(tmp, JSON.stringify({ status, exitCode: code }, null, 2));
        renameSync(tmp, exitStatusPath);
      } catch {
        /* ignore */
      }
      this.ptyManagedPids.delete(pid);
    });
    const stored: StoredProcess = {
      pid,
      prompt: cmd.prompt,
      workFolder: cmd.cwd,
      cwdKey,
      model,
      toolType: cmd.agent,
      startTime: new Date().toISOString(),
      stdoutPath,
      stderrPath,
      status: 'running',
    };
    this.writeProcess(stored);
    return {
      pid,
      status: 'started',
      agent: cmd.agent,
      message: `${cmd.agent} process started successfully (pty mode)`,
    };
  }

  async listProcesses() {
    return this.readAllProcesses().map((proc) => ({
      pid: proc.pid,
      agent: proc.toolType,
      status: this.refreshStatus(proc).status,
    }));
  }

  async getProcessResult(pid: number, verbose = false) {
    const stored = this.readProcess(pid);
    const refreshed = this.refreshStatus(stored);
    const stdout = this.readTextFileSafe(refreshed.stdoutPath);
    const stderr = this.readTextFileSafe(refreshed.stderrPath);
    const agent = getAgent(refreshed.toolType);
    const agentOutput = agent.parseOutput(stdout, stderr, refreshed.exitCode, {
      workFolder: refreshed.workFolder,
      status: refreshed.status,
    });
    return buildProcessResult(
      {
        pid,
        agent: refreshed.toolType,
        status: refreshed.status,
        exitCode: refreshed.exitCode,
        startTime: refreshed.startTime,
        workFolder: refreshed.workFolder,
        prompt: refreshed.prompt,
        model: refreshed.model,
        stdout,
        stderr,
      },
      agentOutput,
      verbose
    );
  }

  async waitForProcesses(pids: number[], timeoutSeconds = 180, verbose = false) {
    const start = Date.now();
    for (const pid of pids) this.readProcess(pid);
    for (;;) {
      const statuses = pids.map((pid) => this.refreshStatus(this.readProcess(pid)).status);
      if (statuses.every((status) => status !== 'running')) {
        return Promise.all(pids.map((pid) => this.getProcessResult(pid, verbose)));
      }
      if (Date.now() - start >= timeoutSeconds * 1000) {
        throw new Error(`Timed out after ${timeoutSeconds} seconds waiting for processes`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  async peekProcesses(pids: number[], peekTimeSec = 10, includeToolCalls = false) {
    const targetPids = validatePeekPids(pids);
    const targetPeekTimeSec = validatePeekTimeSec(peekTimeSec);
    const processes: PeekProcessResult[] = [];
    const observers: Array<{
      process: StoredProcess;
      result: PeekProcessResult;
      stdoutExtractor: PeekEventExtractor;
      stderrExtractor: PeekEventExtractor;
      stdoutOffset: number;
      stderrOffset: number;
    }> = [];

    for (const pid of targetPids) {
      let proc: StoredProcess;
      try {
        proc = this.refreshStatus(this.readProcess(pid));
      } catch {
        processes.push(buildNotFoundPeekProcess(pid));
        continue;
      }
      const result: PeekProcessResult = {
        pid,
        agent: proc.toolType,
        status: proc.status,
        events: [],
        truncated: false,
        error: null,
      };
      processes.push(result);
      observers.push({
        process: proc,
        result,
        stdoutExtractor: new PeekEventExtractor(proc.toolType, { includeToolCalls, source: 'stdout' }),
        stderrExtractor: new PeekEventExtractor(proc.toolType, { includeToolCalls, source: 'stderr' }),
        stdoutOffset: this.fileSizeSafe(proc.stdoutPath),
        stderrOffset: this.fileSizeSafe(proc.stderrPath),
      });
    }

    const startedAt = new Date();
    const startedAtMs = Date.now();
    const deadlineMs = startedAtMs + targetPeekTimeSec * 1000;
    while (Date.now() <= deadlineMs) {
      const observedAt = new Date().toISOString();
      let allTerminal = true;
      for (const observer of observers) {
        const stdoutRead = this.readTextFromOffset(observer.process.stdoutPath, observer.stdoutOffset);
        observer.stdoutOffset = stdoutRead.offset;
        appendPeekEvents(observer.result, observer.stdoutExtractor.push(stdoutRead.text, observedAt));
        const stderrRead = this.readTextFromOffset(observer.process.stderrPath, observer.stderrOffset);
        observer.stderrOffset = stderrRead.offset;
        appendPeekEvents(observer.result, observer.stderrExtractor.push(stderrRead.text, observedAt));
        observer.process = this.refreshStatus(this.readProcess(observer.process.pid));
        observer.result.status = observer.process.status;
        if (observer.process.status === 'running') allTerminal = false;
      }
      if (allTerminal) break;
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) break;
      await new Promise((resolve) => setTimeout(resolve, Math.min(50, remainingMs)));
    }

    const flushTs = new Date().toISOString();
    for (const observer of observers) {
      observer.process = this.refreshStatus(this.readProcess(observer.process.pid));
      observer.result.status = observer.process.status;
      const terminal = observer.process.status !== 'running';
      appendPeekEvents(observer.result, observer.stdoutExtractor.flush(flushTs, { terminal }));
      appendPeekEvents(observer.result, observer.stderrExtractor.flush(flushTs, { terminal }));
    }
    return {
      peek_started_at: startedAt.toISOString(),
      observed_duration_sec: observedDurationSec(startedAtMs),
      processes,
    };
  }

  async killProcess(pid: number) {
    const proc = this.readProcess(pid);
    const refreshed = this.refreshStatus(proc);
    if (refreshed.status !== 'running') {
      return { pid, status: refreshed.status, message: 'Process already terminated' };
    }
    this.killPidOrGroup(pid, 'SIGTERM');
    await this.waitForProcessExit(pid, 250);
    if (isProcessRunning(pid)) {
      return { pid, status: 'running', message: 'Signal sent but process is still running' };
    }
    const exitStatus = this.readExitStatus(refreshed);
    if (exitStatus) {
      refreshed.status = exitStatus.status;
      refreshed.exitCode = exitStatus.exitCode;
    } else {
      refreshed.status = 'failed';
      refreshed.exitCode = SIGTERM_EXIT_CODE;
      this.writeExitStatus(refreshed, { status: 'failed', exitCode: SIGTERM_EXIT_CODE });
    }
    this.writeProcess(refreshed);
    return { pid, status: 'terminated', message: 'Process terminated successfully' };
  }

  async cleanupProcesses() {
    let removed = 0;
    for (const proc of this.readAllProcesses()) {
      const refreshed = this.refreshStatus(proc);
      if (refreshed.status === 'running') continue;
      const processDir = this.resolveStoredProcessDir(refreshed);
      if (existsSync(processDir)) {
        rmSync(processDir, { recursive: true, force: true });
        removed++;
      }
    }
    this.removeEmptyCwdDirs();
    return { removed, message: `Removed ${removed} processes` };
  }

  // ---- 內部：儲存/狀態 ----

  private readAllProcesses(): StoredProcess[] {
    const cwdsDir = this.resolveCwdsDir();
    if (!existsSync(cwdsDir)) return [];
    const processes: StoredProcess[] = [];
    for (const cwdEntry of readdirSync(cwdsDir)) {
      const cwdDir = join(cwdsDir, cwdEntry);
      for (const pidEntry of readdirSync(cwdDir)) {
        const metaPath = join(cwdDir, pidEntry, 'meta.json');
        if (existsSync(metaPath)) processes.push(this.parseProcessFile(metaPath));
      }
    }
    return processes;
  }

  private readProcess(pid: number): StoredProcess {
    const proc = this.readAllProcesses().find((entry) => entry.pid === pid);
    if (!proc) throw new Error(`Process with PID ${pid} not found`);
    return proc;
  }

  private parseProcessFile(metaPath: string): StoredProcess {
    const proc = JSON.parse(readFileSync(metaPath, 'utf-8')) as StoredProcess;
    if (!proc.cwdKey) proc.cwdKey = basename(dirname(dirname(metaPath)));
    return proc;
  }

  private writeProcess(proc: StoredProcess): void {
    const processDir = this.resolveStoredProcessDir(proc);
    mkdirSync(processDir, { recursive: true });
    writeFileSync(this.resolveMetaPath(processDir), JSON.stringify(proc, null, 2));
  }

  private refreshStatus(proc: StoredProcess): StoredProcess {
    if (proc.status !== 'running') return proc;
    const persisted = this.readExitStatus(proc);
    if (persisted) {
      proc.status = persisted.status;
      proc.exitCode = persisted.exitCode;
      this.writeProcess(proc);
      return proc;
    }
    if (!isProcessRunning(proc.pid)) {
      // pty-managed：OS 報告 pid 消失可能早於 onExit 寫 exit-status，先維持 running
      if (this.ptyManagedPids.has(proc.pid)) return proc;
      proc.status = 'failed';
      this.appendTextFileSafe(
        proc.stderrPath,
        '\nProcess exited without exit-status metadata; marking as failed.\n'
      );
      this.writeProcess(proc);
    }
    return proc;
  }

  private readExitStatus(proc: StoredProcess): { status: 'completed' | 'failed'; exitCode: number } | null {
    const exitMetaPath = this.resolveExitStatusPath(this.resolveStoredProcessDir(proc));
    if (!existsSync(exitMetaPath)) return null;
    try {
      const parsed = JSON.parse(readFileSync(exitMetaPath, 'utf-8'));
      if (parsed.status === 'completed' || parsed.status === 'failed') return parsed;
    } catch {
      return null;
    }
    return null;
  }

  private writeExitStatus(proc: StoredProcess, exitStatus: { status: string; exitCode: number }): void {
    const exitStatusPath = this.resolveExitStatusPath(this.resolveStoredProcessDir(proc));
    const tempPath = `${exitStatusPath}.${proc.pid}.${Date.now()}.tmp`;
    writeFileSync(tempPath, JSON.stringify(exitStatus, null, 2) + '\n');
    renameSync(tempPath, exitStatusPath);
  }

  private readTextFileSafe(filePath: string): string {
    if (!existsSync(filePath)) return '';
    return readFileSync(filePath, 'utf-8');
  }

  private touchFile(filePath: string): void {
    closeSync(openSync(filePath, 'a'));
  }

  private appendTextFileSafe(filePath: string, text: string): void {
    try {
      appendFileSync(filePath, text);
    } catch {
      /* ignore */
    }
  }

  private fileSizeSafe(filePath: string): number {
    if (!existsSync(filePath)) return 0;
    return statSync(filePath).size;
  }

  private readTextFromOffset(filePath: string, offset: number): { text: string; offset: number } {
    if (!existsSync(filePath)) return { text: '', offset };
    const size = statSync(filePath).size;
    if (size <= offset) return { text: '', offset: size };
    const fd = openSync(filePath, 'r');
    try {
      const length = size - offset;
      const buffer = Buffer.alloc(length);
      const bytesRead = readSync(fd, buffer, 0, length, offset);
      return { text: buffer.subarray(0, bytesRead).toString('utf-8'), offset: size };
    } finally {
      closeSync(fd);
    }
  }

  private resolveCwdsDir(): string {
    return join(this.stateDir, 'cwds');
  }
  private resolveProcessDir(cwd: string, pid: number): string {
    return join(this.resolveCwdsDir(), this.resolveCwdKey(cwd), String(pid));
  }
  private resolveStoredProcessDir(proc: StoredProcess): string {
    if (!proc.cwdKey) proc.cwdKey = this.resolveCwdKey(proc.workFolder);
    return join(this.resolveCwdsDir(), proc.cwdKey, String(proc.pid));
  }
  private resolveCwdKey(cwd: string): string {
    return normalizeCwdForStorage(realpathSync(cwd));
  }
  private resolveMetaPath(processDir: string): string {
    return join(processDir, 'meta.json');
  }
  private resolveStdoutPath(processDir: string): string {
    return join(processDir, 'stdout.log');
  }
  private resolveStderrPath(processDir: string): string {
    return join(processDir, 'stderr.log');
  }
  private resolveExitStatusPath(processDir: string): string {
    return join(processDir, 'exit-status.json');
  }
  private resolveDetachedWrapperNodeWin32Path(): string {
    return join(this.stateDir, 'detached-runner-win32.cjs');
  }

  private ensureDetachedWrapperNodeWin32(): string {
    const wrapperPath = this.resolveDetachedWrapperNodeWin32Path();
    if (existsSync(wrapperPath)) return wrapperPath;
    writeFileSync(wrapperPath, `"use strict";
const{readFileSync,writeFileSync,unlinkSync,appendFileSync,statSync,mkdirSync}=require("node:fs");
const{spawn}=require("node:child_process");
const{join}=require("node:path");
const spec=JSON.parse(readFileSync(process.argv[2],"utf-8"));
try{unlinkSync(process.argv[2]);}catch{}
const dir=join(spec.stateDir,"cwds",spec.cwdKey,String(process.pid));
const out=join(dir,"stdout.log");
const errP=join(dir,"stderr.log");
const ext=join(dir,"exit-status.json");
function waitDir(cb){const p=()=>{try{statSync(dir);cb();}catch{setTimeout(p,50);}};p();}
waitDir(()=>{
const child=spawn(spec.cliPath,spec.args,{cwd:spec.cwd,stdio:[spec.stdinPrompt?"pipe":"ignore","pipe","pipe"],shell:false,windowsVerbatimArguments:true});
if(spec.stdinPrompt&&child.stdin){child.stdin.on("error",()=>{});try{child.stdin.write(spec.stdinPrompt);child.stdin.end();}catch{}}
child.stdout.on("data",d=>{try{appendFileSync(out,d);}catch{}});
child.stderr.on("data",d=>{try{appendFileSync(errP,d);}catch{}});
child.on("close",code=>{
const s=code===0?"completed":"failed";
try{writeFileSync(ext,JSON.stringify({status:s,exitCode:code??-1}));}catch{}
process.exit(code??1);
});
child.on("error",e=>{
try{appendFileSync(errP,"\\nProcess error: "+e.message);}catch{}
try{writeFileSync(ext,JSON.stringify({status:"failed",exitCode:-1}));}catch{}
process.exit(1);
});
});
`);
    return wrapperPath;
  }

  private resolveDetachedWrapperPath(): string {
    return join(this.stateDir, 'detached-runner-v2.sh');
  }

  private ensureDetachedWrapperScript(): string {
    const wrapperPath = this.resolveDetachedWrapperPath();
    this.removeLegacyDetachedWrappers();
    if (existsSync(wrapperPath)) return wrapperPath;
    writeFileSync(
      wrapperPath,
      `#!/bin/sh
set +e
state_dir="$1"
cwd_key="$2"
shift 2
pid="$$"
process_dir="$state_dir/cwds/$cwd_key/$pid"
stdout_path="$process_dir/stdout.log"
stderr_path="$process_dir/stderr.log"
exit_meta_path="$process_dir/exit-status.json"
mkdir -p "$process_dir"
: > "$stdout_path"
: > "$stderr_path"
write_exit_status() {
  status="$1"
  exit_code="$2"
  tmp_exit_meta_path="$exit_meta_path.$$"
  printf '{\\n  "status": "%s",\\n  "exitCode": %s\\n}\\n' "$status" "$exit_code" > "$tmp_exit_meta_path"
  mv "$tmp_exit_meta_path" "$exit_meta_path"
}
handle_signal() {
  signal="$1"
  exit_code="$2"
  if [ -n "\${child_pid:-}" ]; then
    kill "-$signal" "$child_pid" 2>/dev/null || true
    wait "$child_pid" 2>/dev/null
  fi
  write_exit_status "failed" "$exit_code"
  exit "$exit_code"
}
trap 'handle_signal TERM 143' TERM
trap 'handle_signal INT 130' INT
trap 'handle_signal HUP 129' HUP
"$@" >> "$stdout_path" 2>> "$stderr_path" &
child_pid="$!"
wait "$child_pid"
exit_code="$?"
trap - TERM INT HUP
status="completed"
if [ "$exit_code" -ne 0 ]; then
  status="failed"
fi
write_exit_status "$status" "$exit_code"
exit "$exit_code"
`
    );
    chmodSync(wrapperPath, 0o755);
    return wrapperPath;
  }

  private removeLegacyDetachedWrappers(): void {
    for (const fileName of ['detached-runner-v1.sh', 'detached-runner-v2.cmd']) {
      const legacyPath = join(this.stateDir, fileName);
      if (!existsSync(legacyPath)) continue;
      try {
        rmSync(legacyPath, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  private killPidOrGroup(pid: number, signal: NodeJS.Signals): void {
    try {
      process.kill(-pid, signal);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ESRCH' || code === 'EINVAL') {
        process.kill(pid, signal);
        return;
      }
      if (code === 'EPERM') throw error;
      process.kill(pid, signal);
    }
  }

  private async waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const startedAt = Date.now();
    while (isProcessRunning(pid) && Date.now() - startedAt < timeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }

  private removeEmptyCwdDirs(): void {
    const cwdsDir = this.resolveCwdsDir();
    if (!existsSync(cwdsDir)) return;
    for (const cwdEntry of readdirSync(cwdsDir)) {
      const cwdDir = join(cwdsDir, cwdEntry);
      if (readdirSync(cwdDir).length === 0) {
        rmSync(cwdDir, { recursive: true, force: true });
      }
    }
  }
}
