import type { SequenceAssertion, SimInputEvent } from '../../contracts/simulation';
import type { McpToolContext } from './context';
import { loadCircuitFromWorkspace } from './context';
import { validateCircuitStatic } from '../../simulator/validator';
import { collectCtVisualFindings } from '../../authoring/postconditionVerifier';
import { simulateCircuit } from '../../simulator/simulator';
import { verifyCircuitSequence } from '../../simulator/sequenceVerifier';
import { paginateWithBudget } from '../../contracts/pagination';

export function handleCircuitValidate(
  ctx: McpToolContext,
  args: { path: string; allowExternalElectricalSheet?: boolean },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const report = validateCircuitStatic(document, {
    allowExternalElectricalSheet: args.allowExternalElectricalSheet,
  });
  const rawBytes = ctx.guard.readFileBuffer(relativePath);
  const visual = collectCtVisualFindings(
    rawBytes,
    document.metadata.sheetWidthMm,
    document.metadata.sheetHeightMm,
  );
  const findings = [...report.findings, ...visual.findings];
  const errorCount = findings.filter((f) => f.severity === 'error').length;
  return {
    path: relativePath,
    valid: errorCount === 0 && visual.f9SolverOk,
    f9SolverOk: visual.f9SolverOk,
    visualLayoutOk: visual.ok,
    errorCount,
    warningCount: findings.filter((f) => f.severity === 'warning').length,
    findings,
  };
}

export function handleCircuitSimulate(
  ctx: McpToolContext,
  args: {
    path: string;
    inputs?: SimInputEvent[];
    durationMs?: number;
    stepMs?: number;
    includeSamples?: boolean;
    sampleIntervalMs?: number;
    sampleLimit?: number;
    supplyPressureBar?: number;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
  },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const sim = simulateCircuit(document, {
    inputs: args.inputs,
    durationMs: args.durationMs,
    stepMs: args.stepMs,
    includeSamples: args.includeSamples,
    sampleIntervalMs: args.sampleIntervalMs,
    supplyPressureBar: args.supplyPressureBar,
  });

  const effectiveMaxBytes = Math.min(ctx.maxPayloadBytes, args.maxBytes ?? ctx.maxPayloadBytes);
  const eventsBudget = sim.samples ? Math.max(2048, Math.floor(effectiveMaxBytes * 0.45)) : effectiveMaxBytes;
  const pagedEvents = paginateWithBudget(
    sim.events,
    {
      cursor: args.cursor,
      limit: args.limit ?? 100,
      maxBytes: eventsBudget,
    },
    eventsBudget,
  );

  let samplesPayload:
    | { samples: NonNullable<typeof sim.samples>; samplesTotal: number; samplesTruncated: boolean }
    | undefined;
  if (sim.samples) {
    const samplesBudget = Math.max(2048, Math.floor(effectiveMaxBytes * 0.45));
    const pagedSamples = paginateWithBudget(
      sim.samples,
      {
        limit: args.sampleLimit ?? 100,
        maxBytes: samplesBudget,
      },
      samplesBudget,
    );
    samplesPayload = {
      samples: pagedSamples.items,
      samplesTotal: sim.samples.length,
      samplesTruncated: pagedSamples.page.nextCursor !== null,
    };
  }

  return {
    path: relativePath,
    completed: sim.completed,
    durationMs: sim.durationMs,
    stepMs: sim.stepMs,
    totalTicks: sim.totalTicks,
    observedSequence: sim.observedSequence,
    diagnostics: sim.diagnostics,
    finalState: sim.finalState,
    events: pagedEvents.items,
    eventsPage: pagedEvents.page,
    ...(samplesPayload ?? {}),
  };
}

export function handleCircuitVerifySequence(
  ctx: McpToolContext,
  args: SequenceAssertion & { path: string },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const result = verifyCircuitSequence(document, {
    expectedSequence: args.expectedSequence,
    inputs: args.inputs,
    durationMs: args.durationMs,
    stepMs: args.stepMs,
    maxCycleMs: args.maxCycleMs,
    allowRepeatCycles: args.allowRepeatCycles,
    minCycles: args.minCycles,
    eStopCheck: args.eStopCheck,
  });

  return {
    path: relativePath,
    ...result,
  };
}
