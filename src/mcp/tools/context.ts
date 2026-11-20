import fs from 'node:fs';
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
  const existedBefore = fs.existsSync(abs);
  const previousBytes = existedBefore ? fs.readFileSync(abs) : null;

  const bytes = serializeCircuitDocument(document, { targetPath: relativePath });
  const written = ctx.guard.writeFileAtomic(relativePath, bytes, options);

  try {
    const postcondition = verifyWrittenCircuitPostcondition(ctx.guard, relativePath, document);
    return {
      relativePath: written.relativePath,
      ...(written.backupPath ? { backupPath: written.backupPath } : {}),
      postcondition,
    };
  } catch (err) {
    // Transactional rollback: restore prior file bytes (or remove newly created file) on postcondition failure
    try {
      if (existedBefore && previousBytes !== null) {
        ctx.guard.writeFileAtomic(relativePath, previousBytes, { backup: false });
      } else if (!existedBefore && fs.existsSync(abs)) {
        fs.unlinkSync(abs);
      }
    } catch {
      // Best-effort rollback; preserve original postcondition error
    }
    throw err;
  }
}
