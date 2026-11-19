import type { SequenceAssertion, SimInputEvent } from '../../contracts/simulation';
import type { McpToolContext } from './context';
import { loadCircuitFromWorkspace } from './context';
import { validateCircuitStatic } from '../../simulator/validator';
import { simulateCircuit } from '../../simulator/simulator';
import { verifyCircuitSequence } from '../../simulator/sequenceVerifier';
import { paginateWithBudget } from '../../contracts/pagination';

export function handleCircuitValidate(ctx: McpToolContext, args: { path: string }) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const report = validateCircuitStatic(document);
  return {
    path: relativePath,
    ...report,
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

  const pagedEvents = paginateWithBudget(
    sim.events,
    {
      cursor: args.cursor,
      limit: args.limit ?? 100,
      maxBytes: args.maxBytes,
    },
    ctx.maxPayloadBytes,
  );

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
    ...(sim.samples ? { samples: sim.samples } : {}),
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
    eStopCheck: args.eStopCheck,
  });

  return {
    path: relativePath,
    ...result,
  };
}
