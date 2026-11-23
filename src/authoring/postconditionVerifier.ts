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
  f9SolverOk: boolean;
  validation: StaticValidationReport;
  reparsedDocument: CircuitDocument;
}

/**
 * Inspects a binary FluidSIM 4.5 `.ct` buffer for BOTH F6 visual/wire geometry issues
 * AND F9 solver state-machine invariants (`CV_ID`, `VALUECLASS`, `POS`, `PILOT_L/R`, 3-gate `PTriconnection`).
 */
export function collectCtVisualFindings(
  diskBytes: Buffer,
  sheetWidthMm?: number,
  sheetHeightMm?: number,
): { ok: boolean; f9SolverOk: boolean; findings: StaticValidationFinding[] } {
  if (!isFluidSimCtBuffer(diskBytes)) {
    return { ok: true, f9SolverOk: true, findings: [] };
  }
  const dec = decodeCtContainer(diskBytes);
  const report = verifyCtVisualLayoutInvariants(dec.ctBody, dec.trailerText, {
    sheetWidthMm,
    sheetHeightMm,
  });
  const findings: StaticValidationFinding[] = [];
  const wg = report.wireGeometry;

  if (!report.f9Solver.ok) {
    for (const ve of report.f9Solver.valveErrors) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'CT_F9_VALVE_SOLVER_DEFECT',
        message: `FluidSIM 4.5 F9 solver invariant violation on ${ve.cls}#O${ve.objId}: ${ve.reason}`,
        offendingIds: [`${ve.cls}#O${ve.objId}`],
        suggestedFix: 'Re-compile valve via v2 FluidSIM 4.5 valve compiler.',
      });
    }
    for (const je of report.f9Solver.junctionErrors) {
      findings.push({
        severity: 'error',
        category: 'InvalidTopology',
        code: 'CT_F9_JUNCTION_GATE_DEFECT',
        message: `FluidSIM 4.5 junction invariant violation on ${je.cls}#O${je.objId} (${je.gateCount} gates): ${je.reason}`,
        offendingIds: [`${je.cls}#O${je.objId}`],
        suggestedFix: 'Ensure PTriconnection/ETriconnection has 3 gates (or 4 genuinely wired gates) with zero hidden S state INT 4 gates.',
      });
    }
  }

  if (report.missingSymbols.length > 0 || report.missingDxfPrimList.length > 0) {
    findings.push({
      severity: 'error',
      category: 'InvalidTopology',
      code: 'CT_MISSING_DXF_SYMBOL',
      message: `${report.missingSymbols.length} dangling SYM references and ${report.missingDxfPrimList.length} components missing dxf_prim_list.`,
      offendingIds: [
        ...report.missingSymbols.map((m) => `${m.cls}#O${m.objId}`),
        ...report.missingDxfPrimList.map((m) => `${m.cls}#O${m.objId}`),
      ],
      suggestedFix: 'Re-serialize through CtSymbolAllocator to populate BEGINSYM blocks.',
    });
  }

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

  return { ok: report.ok, f9SolverOk: report.f9Solver.ok, findings };
}

/**
 * Re-reads written file from disk, verifies lossless codec roundtrip invariants,
 * runs static engineering validation, and checks FluidSIM 4.5 F6 visual & F9 solver invariants.
 *
 * Strict v2 gate: `passed` is TRUE only when roundtrip, F9 solver invariants, AND visual layout
 * are all clean (never returns `passed: true` when `visualLayoutOk === false` or `f9SolverOk === false`).
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
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  const validation: StaticValidationReport = {
    valid: errorCount === 0,
    errorCount,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };

  return {
    passed: roundtrip.passed && visual.ok && visual.f9SolverOk,
    roundtripPassed: roundtrip.passed,
    visualLayoutOk: visual.ok,
    f9SolverOk: visual.f9SolverOk,
    validation,
    reparsedDocument,
  };
}
