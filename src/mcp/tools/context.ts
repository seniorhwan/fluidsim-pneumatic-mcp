import type { CircuitDocument } from '../../contracts/circuit';
import type { AccessMode } from '../../safety/accessMode';
import type { WorkspaceGuard } from '../../safety/workspaceGuard';
import { parseCircuitBuffer } from '../../codec/ctParser';
import { serializeCircuitDocument } from '../../codec/ctSerializer';
import {
  verifyWrittenCircuitPostcondition,
  type PostconditionResult,
} from '../../authoring/postconditionVerifier';

export interface McpToolContext {
  guard: WorkspaceGuard;
  accessMode: AccessMode;
  maxPayloadBytes: number;
  serverVersion: string;
  repoRoot: string;
}

export function loadCircuitFromWorkspace(
  ctx: McpToolContext,
  filePath: string,
): { document: CircuitDocument; relativePath: string } {
  const abs = ctx.guard.resolveCircuitPath(filePath);
  const relativePath = ctx.guard.toRelativePath(abs);
  const buf = ctx.guard.readFileBuffer(relativePath);
  const { document } = parseCircuitBuffer(buf, relativePath);
  return { document, relativePath };
}

export function saveCircuitWithPostcondition(
  ctx: McpToolContext,
  filePath: string,
  document: CircuitDocument,
  options?: { backup?: boolean },
): { relativePath: string; backupPath?: string; postcondition: PostconditionResult } {
  const abs = ctx.guard.resolveCircuitPath(filePath);
  const relativePath = ctx.guard.toRelativePath(abs);
  const bytes = serializeCircuitDocument(document, { targetPath: relativePath });
  const written = ctx.guard.writeFileAtomic(relativePath, bytes, options);
  const postcondition = verifyWrittenCircuitPostcondition(ctx.guard, relativePath, document);
  return {
    relativePath: written.relativePath,
    ...(written.backupPath ? { backupPath: written.backupPath } : {}),
    postcondition,
  };
}
