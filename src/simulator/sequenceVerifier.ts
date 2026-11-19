import type { CircuitDocument } from '../contracts/circuit';
import type { SequenceAssertion, SequenceVerificationResult } from '../contracts/simulation';
import { simulateCircuit } from './simulator';

export function verifyCircuitSequence(
  doc: CircuitDocument,
  assertion: SequenceAssertion,
): SequenceVerificationResult {
  const durationMs = assertion.durationMs ?? Math.max(4000, assertion.expectedSequence.length * 1200);
  const stepMs = assertion.stepMs ?? 10;

  const sim = simulateCircuit(doc, {
    durationMs,
    stepMs,
    inputs: assertion.inputs,
    includeSamples: false,
  });

  const expected = assertion.expectedSequence;
  const observed = sim.observedSequence;

  let mismatchIndex: number | null = null;
  for (let i = 0; i < expected.length; i++) {
    if (observed[i] !== expected[i]) {
      mismatchIndex = i;
      break;
    }
  }

  // Also fail if extra unexpected motions occurred beyond expected length for single-cycle checks
  if (mismatchIndex === null && observed.length !== expected.length) {
    mismatchIndex = expected.length;
  }

  // Measure cycle time (from first input to last expected motion event)
  let cycleTimeMs: number | null = null;
  const motionEvents = sim.events.filter(
    (e) => e.kind === 'cylinder_extended' || e.kind === 'cylinder_retracted',
  );
  if (mismatchIndex === null && motionEvents.length >= expected.length && expected.length > 0) {
    const startAt = assertion.inputs.length > 0 ? Math.min(...assertion.inputs.map((i) => i.atMs)) : 0;
    const endAt = motionEvents[expected.length - 1].timeMs;
    cycleTimeMs = Math.max(0, endAt - startAt);
  }

  const hasErrorDiagnostics = sim.diagnostics.some((d) => d.severity === 'error');
  let passed = mismatchIndex === null && !hasErrorDiagnostics;
  let failureSummary: string | undefined;

  if (mismatchIndex !== null) {
    const expToken = expected[mismatchIndex] ?? '<end-of-cycle>';
    const obsToken = observed[mismatchIndex] ?? '<no-motion>';
    failureSummary = `Sequence mismatch at step ${mismatchIndex}: expected "${expToken}", observed "${obsToken}".`;
    if (sim.diagnostics.length > 0) {
      failureSummary += ` Root cause: ${sim.diagnostics[0].code} — ${sim.diagnostics[0].message}`;
    }
  } else if (hasErrorDiagnostics) {
    failureSummary = `Sequence matched motions, but simulation reported error diagnostic: ${sim.diagnostics[0].code} (${sim.diagnostics[0].message})`;
  }

  if (passed && assertion.maxCycleMs !== undefined && cycleTimeMs !== null && cycleTimeMs > assertion.maxCycleMs) {
    passed = false;
    failureSummary = `Cycle time ${cycleTimeMs}ms exceeded maxCycleMs=${assertion.maxCycleMs}ms.`;
  }

  // Optional mid-cycle E-stop verification pass
  let eStopVerified: boolean | undefined;
  if (assertion.eStopCheck) {
    const { label, triggerAtMs, expectNoFurtherMotionsAfterMs = 250 } = assertion.eStopCheck;
    const estopSim = simulateCircuit(doc, {
      durationMs,
      stepMs,
      inputs: [
        ...assertion.inputs,
        { label, action: 'hold', atMs: triggerAtMs },
      ],
      includeSamples: false,
    });

    const lateMotions = estopSim.events.filter(
      (e) =>
        (e.kind === 'cylinder_extended' || e.kind === 'cylinder_retracted') &&
        e.timeMs > triggerAtMs + expectNoFurtherMotionsAfterMs,
    );

    // E-stop passes if no new cycle motions complete after the E-stop grace window AND full sequence was interrupted
    eStopVerified =
      lateMotions.length === 0 && estopSim.observedSequence.length < expected.length;

    if (!eStopVerified) {
      passed = false;
      failureSummary = `E-stop "${label}" triggered at t=${triggerAtMs}ms failed to halt actuator cycle (observed ${estopSim.observedSequence.join(' ')}, ${lateMotions.length} motion(s) after grace window).`;
    }
  }

  return {
    passed,
    expectedSequence: expected,
    observedSequence: observed,
    mismatchIndex,
    cycleTimeMs,
    diagnostics: sim.diagnostics,
    ...(failureSummary ? { failureSummary } : {}),
    ...(eStopVerified !== undefined ? { eStopVerified } : {}),
  };
}
