/**
 * Forge agent。行為 1:1 還原 dist。
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentDefinition, BuildCommandInput, BuiltCommand } from './types.js';

const FORGE_MODELS = ['forge'] as const;

function buildCommand(input: BuildCommandInput): BuiltCommand {
  const { cliPath, cwd, prompt, resolvedModel, sessionId } = input;
  const args = ['-C', cwd];
  if (sessionId) {
    args.push('--conversation-id', sessionId);
  }
  args.push('-p', prompt);
  return { cliPath, args, cwd, agent: 'forge', prompt, resolvedModel };
}

function parseOutput(stdout: string): unknown {
  if (!stdout) return null;
  const lines = stdout.split('\n');
  const markerPattern = /^● \[[^\]]+\] (Initialize|Continue|Finished) (\S+)\s*$/;
  let collecting = false;
  let currentConversationId: string | null = null;
  let currentBody: string[] = [];
  let lastConversationId: string | null = null;
  let lastMessage: string | null = null;
  for (const line of lines) {
    const match = line.match(markerPattern);
    if (match) {
      const [, action, conversationId] = match;
      lastConversationId = conversationId;
      if (action === 'Initialize' || action === 'Continue') {
        collecting = true;
        currentConversationId = conversationId;
        currentBody = [];
      } else if (collecting && currentConversationId === conversationId) {
        const message = currentBody.join('\n').trim();
        if (message) {
          lastMessage = message;
        }
        collecting = false;
        currentConversationId = null;
        currentBody = [];
      }
      continue;
    }
    if (collecting) {
      currentBody.push(line);
    }
  }
  if (collecting) {
    const message = currentBody.join('\n').trim();
    if (message) {
      lastMessage = message;
    }
    if (currentConversationId) {
      lastConversationId = currentConversationId;
    }
  }
  if (!lastMessage && !lastConversationId) {
    return null;
  }
  return { message: lastMessage, session_id: lastConversationId };
}

export const forgeAgent: AgentDefinition = {
  id: 'forge',
  models: FORGE_MODELS,
  matchesModel: (model) => model === 'forge',
  binary: {
    envVarName: 'FORGE_CLI_NAME',
    defaultCliName: 'forge',
    localInstallPath: join(homedir(), '.forge', 'local', 'forge'),
  },
  reasoning: {
    supported: false,
    unsupportedMessage: 'reasoning_effort is not supported for forge.',
  },
  buildCommand,
  parseOutput,
};
