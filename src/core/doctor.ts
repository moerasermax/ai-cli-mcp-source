/**
 * doctor 與 CLI 路徑解析。從 registry 自動涵蓋所有 agent。
 * 對應 dist/cli-utils.js 的 getCliDoctorStatus + 各 findXxxCli。
 */

import type { AgentId } from '../agents/types.js';
import { listAgents, getAgent } from '../agents/registry.js';
import {
  buildDoctorStatus,
  resolveAgentCli,
  type CliDoctorStatus,
} from './binary-resolver.js';
import type { CliPaths } from './process-service.js';

/** doctor：所有 agent 的二進位可用性。 */
export function getCliDoctorStatus(): CliDoctorStatus {
  return buildDoctorStatus(
    listAgents()
      .filter((a) => a.binary)
      .map((a) => ({ id: a.id, config: a.binary! }))
  );
}

/** 解析每個 agent 的 CLI 路徑，組成 ProcessService 需要的 CliPaths。 */
export function resolveAllCliPaths(): CliPaths {
  const path = (id: Exclude<AgentId, 'direct-api'>) => resolveAgentCli(getAgent(id).binary!);
  return {
    claude: path('claude'),
    codex: path('codex'),
    antigravity: path('antigravity'),
    kiro: path('kiro'),
    forge: path('forge'),
  };
}
