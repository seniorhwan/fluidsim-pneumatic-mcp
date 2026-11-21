import type { CircuitDocument } from '../contracts/circuit';
import type { StaticValidationFinding, StaticValidationReport } from '../contracts/simulation';
import { decodeCtContainer, isFluidSimCtBuffer } from '../codec/ctBinaryCodec';
import { verifyCodecRoundtrip } from '../codec/ctRoundtripGuard';
import { parseCircuitBuffer } from '../codec/ctParser';
import { verifyCtVisualLayoutInvariants } from '../codec/ctTextCodec';
import { validateCircuitStatic } from '../simulator/validator';
import type { WorkspaceGuard } from '../safety/workspaceGuard';

export interface PostconditionResult {
  passed: boolean;
  roundtripPassed: boolean;
  visualLayoutOk: boolean;
  validation: StaticValidationReport;
  reparsedDocument: CircuitDocument;
}

/**
 * Inspects a binary FluidSIM 4.5 `.ct` buffer for F6 superficial visual & wire geometry issues.
 */
export function collectCtVisualFindings(
  diskBytes: Buffer,
  sheetWidthMm?: number,
  sheetHeightMm?: number,
): { ok: boolean; findings: StaticValidationFinding[] } {
  if (!isFluidSimCtBuffer(diskBytes)) {
    return { ok: true, findings: [] };
  }
  const dec = decodeCtContainer(diskBytes);
  const report = verifyCtVisualLayoutInvariants(dec.ctBody, dec.trailerText, {
    sheetWidthMm,
    sheetHeightMm,
  });
  const findings: StaticValidationFinding[] = [];
  const wg = report.wireGeometry;

  if (wg.outOfBoundsObjects.length > 0 || wg.outOfBoundsSegments.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'InvalidTopology',
      code: 'CT_OBJECTS_OUTSIDE_DRAWING_AREA',
      message: `${wg.outOfBoundsObjects.length} objects and ${wg.outOfBoundsSegments.length} wire segments lie outside the FluidSIM drawing area.`,
      offendingIds: wg.outOfBoundsObjects.map((o) => `${o.cls}#O${o.objId}`),
      suggestedFix: 'Run circuit_auto_layout to re-route cleanly.',
    });
  }
  if (wg.linesThroughComponents.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'InvalidTopology',
      code: 'CT_LINES_THROUGH_COMPONENTS',
      message: `${wg.linesThroughComponents.length} wire segments pass through component bodies.`,
      offendingIds: wg.linesThroughComponents.map((l) => `${l.cls}#O${l.ownerId}`),
      suggestedFix: 'Run circuit_auto_layout to re-route cleanly.',
    });
  }
  if (wg.linesThroughConnections.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'InvalidTopology',
      code: 'CT_LINES_THROUGH_CONNECTIONS',
      message: `${wg.linesThroughConnections.length} wire segments pass through non-endpoint connection ports.`,
      offendingIds: wg.linesThroughConnections.map((l) => `P#O${l.hitPortObjId}`),
      suggestedFix: 'Run circuit_auto_layout to re-route cleanly.',
    });
  }
  if (wg.superimposedLines.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'InvalidTopology',
      code: 'CT_SUPERIMPOSED_LINES',
      message: `${wg.superimposedLines.length} pairs of wire segments are superimposed.`,
      offendingIds: wg.superimposedLines.map((s) => `P#O${s.portObjA}`),
      suggestedFix: 'Run circuit_auto_layout to re-route cleanly.',
    });
  }
  if (report.overlaps.length > 0) {
    findings.push({
      severity: 'warning',
      category: 'InvalidTopology',
      code: 'CT_OBJECT_OVERLAP',
      message: `${report.overlaps.length} non-port object bounding boxes overlap.`,
      offendingIds: report.overlaps.map((o) => `${o.a}<->${o.b}`),
      suggestedFix: 'Run circuit_auto_layout to re-route cleanly.',
    });
  }

  return { ok: report.ok, findings };
}

/**
 * Re-reads written file from disk, verifies lossless codec roundtrip invariants,
 * runs static engineering validation, and checks FluidSIM 4.5 visual/F6 geometry invariants.
 */
export function verifyWrittenCircuitPostcondition(
  guard: WorkspaceGuard,
  relativePath: string,
  expectedDoc: CircuitDocument,
): PostconditionResult {
  const diskBytes = guard.readFileBuffer(relativePath);
  const roundtrip = verifyCodecRoundtrip(expectedDoc, diskBytes, relativePath);
  const { document: reparsedDocument } = parseCircuitBuffer(diskBytes, relativePath);
  const baseValidation = validateCircuitStatic(reparsedDocument);
  const visual = collectCtVisualFindings(
    diskBytes,
    reparsedDocument.metadata.sheetWidthMm,
    reparsedDocument.metadata.sheetHeightMm,
  );
  const findings = [...baseValidation.findings, ...visual.findings];
  const validation: StaticValidationReport = {
    valid: baseValidation.valid,
    errorCount: baseValidation.errorCount,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };

  return {
    passed: roundtrip.passed,
    roundtripPassed: roundtrip.passed,
    visualLayoutOk: visual.ok,
    validation,
    reparsedDocument,
  };
}
