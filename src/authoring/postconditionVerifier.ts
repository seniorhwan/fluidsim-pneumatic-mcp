import type { CircuitDocument } from '../contracts/circuit';
import type { StaticValidationReport } from '../contracts/simulation';
import { verifyCodecRoundtrip } from '../codec/ctRoundtripGuard';
import { parseCircuitBuffer } from '../codec/ctParser';
import { validateCircuitStatic } from '../simulator/validator';
import type { WorkspaceGuard } from '../safety/workspaceGuard';

export interface PostconditionResult {
  passed: boolean;
  roundtripPassed: boolean;
  validation: StaticValidationReport;
  reparsedDocument: CircuitDocument;
}

/**
 * Re-reads written file from disk, verifies lossless codec roundtrip invariants,
 * and runs static engineering validation.
 */
export function verifyWrittenCircuitPostcondition(
  guard: WorkspaceGuard,
  relativePath: string,
  expectedDoc: CircuitDocument,
): PostconditionResult {
  const diskBytes = guard.readFileBuffer(relativePath);
  const roundtrip = verifyCodecRoundtrip(expectedDoc, diskBytes, relativePath);
  const { document: reparsedDocument } = parseCircuitBuffer(diskBytes, relativePath);
  const validation = validateCircuitStatic(reparsedDocument);

  return {
    passed: roundtrip.passed,
    roundtripPassed: roundtrip.passed,
    validation,
    reparsedDocument,
  };
}
