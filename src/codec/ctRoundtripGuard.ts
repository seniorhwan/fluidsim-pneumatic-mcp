import type { CircuitDocument } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { parseCircuitBuffer } from './ctParser';
import { computeSemanticFingerprint, type PreservedCtSections } from './ctTextCodec';

export interface RoundtripCheckResult {
  passed: boolean;
  componentCount: number;
  connectionCount: number;
  preservedRawAst: boolean;
}

function checkRawAstPreserved(expected: CircuitDocument, reparsed: CircuitDocument): boolean {
  if (expected.rawAst === undefined) {
    return true;
  }

  const expSec = expected.rawAst.preservedSections as Partial<PreservedCtSections> | undefined;
  const repSec = reparsed.rawAst?.preservedSections as Partial<PreservedCtSections> | undefined;

  if (expSec?.kind === 'fluidsim-4.5-ct') {
    if (repSec?.kind !== 'fluidsim-4.5-ct') return false;
    if (JSON.stringify(repSec.headerLinesB64) !== JSON.stringify(expSec.headerLinesB64)) return false;
    if (repSec.previewBlockB64 !== expSec.previewBlockB64) return false;
    if ((repSec.fsPreviewBlock ?? '') !== (expSec.fsPreviewBlock ?? '')) return false;

    const isUnmodified =
      Boolean(expSec.originalSemanticFingerprint) &&
      computeSemanticFingerprint(expected) === expSec.originalSemanticFingerprint;
    if (isUnmodified) {
      if (repSec.trailerText !== expSec.trailerText) return false;
      if (repSec.originalCtBody !== expSec.originalCtBody) return false;
    } else {
      const repTrailer = repSec.trailerText ?? '';
      if (!repTrailer.includes('ENDCT') || !repTrailer.includes('BEGINSYM') || !repTrailer.includes('ENDSYM')) {
        return false;
      }
    }
    return true;
  }

  return JSON.stringify(reparsed.rawAst) === JSON.stringify(expected.rawAst);
}

/**
 * Re-parses serialized circuit bytes and verifies structural & lossless invariants.
 */
export function verifyCodecRoundtrip(
  expected: CircuitDocument,
  serializedBytes: Buffer,
  filePath = '<memory>',
): RoundtripCheckResult {
  const { document: reparsed } = parseCircuitBuffer(serializedBytes, filePath);

  if (reparsed.components.length !== expected.components.length) {
    throw new EngineeringError({
      category: 'PostconditionFailed',
      code: 'ROUNDTRIP_COMPONENT_COUNT_MISMATCH',
      message: `Roundtrip re-parse yielded ${reparsed.components.length} components, expected ${expected.components.length}.`,
      offendingIds: [filePath],
      suggestedFix: 'Inspect serializer output and retry the write transaction.',
    });
  }

  if (reparsed.connections.length !== expected.connections.length) {
    throw new EngineeringError({
      category: 'PostconditionFailed',
      code: 'ROUNDTRIP_CONNECTION_COUNT_MISMATCH',
      message: `Roundtrip re-parse yielded ${reparsed.connections.length} connections, expected ${expected.connections.length}.`,
      offendingIds: [filePath],
      suggestedFix: 'Inspect edge serialization and retry the write transaction.',
    });
  }

  const expectedIds = new Set(expected.components.map((c) => c.id));
  for (const comp of reparsed.components) {
    if (!expectedIds.has(comp.id)) {
      throw new EngineeringError({
        category: 'PostconditionFailed',
        code: 'ROUNDTRIP_COMPONENT_ID_MISMATCH',
        message: `Unexpected component ID "${comp.id}" after roundtrip re-parse.`,
        offendingIds: [comp.id],
        suggestedFix: 'Verify serializer preserves component IDs verbatim.',
      });
    }
  }

  const expectedEdgeIds = new Set(expected.connections.map((e) => e.id));
  for (const edge of reparsed.connections) {
    if (!expectedEdgeIds.has(edge.id)) {
      throw new EngineeringError({
        category: 'PostconditionFailed',
        code: 'ROUNDTRIP_EDGE_ID_MISMATCH',
        message: `Unexpected connection ID "${edge.id}" after roundtrip re-parse.`,
        offendingIds: [edge.id],
        suggestedFix: 'Verify serializer preserves connection IDs verbatim.',
      });
    }
  }

  const preservedRawAst = checkRawAstPreserved(expected, reparsed);

  if (!preservedRawAst) {
    throw new EngineeringError({
      category: 'PostconditionFailed',
      code: 'ROUNDTRIP_RAW_AST_LOST',
      message: `Lossless rawAst preservation failed during roundtrip for "${filePath}".`,
      offendingIds: [filePath],
      suggestedFix: 'Ensure ctSerializer writes rawAst untouched.',
    });
  }

  return {
    passed: true,
    componentCount: reparsed.components.length,
    connectionCount: reparsed.connections.length,
    preservedRawAst,
  };
}
