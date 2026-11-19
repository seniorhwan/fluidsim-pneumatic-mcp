import { EngineeringError } from '../contracts/errors';

export type AccessMode = 'read-only' | 'authoring';

export function parseAccessMode(raw?: string): AccessMode {
  if (!raw || raw === 'read-only') return 'read-only';
  if (raw === 'authoring') return 'authoring';
  throw new EngineeringError({
    category: 'AccessDenied',
    code: 'INVALID_ACCESS_MODE',
    message: `Unsupported access mode "${raw}". Expected "read-only" or "authoring".`,
    offendingIds: [],
    suggestedFix: 'Pass --mode read-only or --mode authoring when starting fluidsim-mcp.',
  });
}

export function assertCanMutate(mode: AccessMode, toolName: string): void {
  if (mode !== 'authoring') {
    throw new EngineeringError({
      category: 'AccessDenied',
      code: 'READ_ONLY_MODE',
      message: `Tool "${toolName}" requires authoring mode, but server is running in "${mode}" mode.`,
      offendingIds: [toolName],
      suggestedFix: 'Restart fluidsim-mcp with "--mode authoring" to permit circuit modifications.',
    });
  }
}
