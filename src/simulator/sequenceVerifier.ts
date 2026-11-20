import type { CircuitDocument } from '../contracts/circuit';
import type { SequenceAssertion, SequenceVerificationResult } from '../contracts/simulation';
import { simulateCircuit } from './simulator';

interface ExpectedMotionGroup {
  raw: string;
  tokens: string[];
}

function parseExpectedMotionGroups(expectedSequence: readonly string[]): {
  groups: ExpectedMotionGroup[];
  totalDwellMs: number;
  totalMotionsPerCycle: number;
} {
  const groups: ExpectedMotionGroup[] = [];
  let totalDwellMs = 0;

  for (const raw of expectedSequence) {
    const trimmed = raw.trim();
    const dwellMatch = /^(?:WAIT|DWELL|T)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(ms|s)?$/i.exec(trimmed);
    if (dwellMatch) {
      const val = Number(dwellMatch[1]);
      const unit = (dwellMatch[2] ?? 'ms').toLowerCase();
      totalDwellMs += Math.round(unit === 's' ? val * 1000 : val);
      continue;
    }

    const compact = trimmed.replace(/[\s,&]+/g, '');
    const tokens: string[] = [];
    const regex = /([A-Za-z][A-Za-z0-9]*)([+-])/g;
    let m: RegExpExecArray | null;
    while ((m = regex.exec(compact)) !== null) {
      tokens.push(`${m[1]}${m[2]}`);
    }
    if (tokens.length > 0) {
      groups.push({ raw: trimmed, tokens });
    } else {
      groups.push({ raw: trimmed, tokens: [trimmed] });
    }
  }

  const totalMotionsPerCycle = groups.reduce((acc, g) => acc + g.tokens.length, 0);
  return { groups, totalDwellMs, totalMotionsPerCycle };
}

function matchGroupAt(
  observed: readonly string[],
  obsIdx: number,
  group: ExpectedMotionGroup,
): { matched: boolean; partialOk: boolean } {
  const need = group.tokens.length;
  const available = observed.slice(obsIdx, obsIdx + need);
  if (available.length < need) {
    // Check if available is a valid subset (only used for trailing partial cycle in continuous mode)
    const remaining = [...group.tokens];
    for (const tok of available) {
      const pos = remaining.indexOf(tok);
      if (pos < 0) return { matched: false, partialOk: false };
      remaining.splice(pos, 1);
    }
    return { matched: false, partialOk: true };
  }
  const remaining = [...group.tokens];
  for (const tok of available) {
    const pos = remaining.indexOf(tok);
    if (pos < 0) return { matched: false, partialOk: false };
    remaining.splice(pos, 1);
  }
  return { matched: true, partialOk: true };
}

export function verifyCircuitSequence(
  doc: CircuitDocument,
  assertion: SequenceAssertion,
): SequenceVerificationResult {
  const { groups, totalDwellMs, totalMotionsPerCycle } = parseExpectedMotionGroups(assertion.expectedSequence);
  const allowRepeat = assertion.allowRepeatCycles === true;
  const minCycles = Math.max(1, assertion.minCycles ?? 1);
  const defaultDuration = Math.max(
    4000,
    (groups.length * 1200 + totalDwellMs) * (allowRepeat ? Math.max(2, minCycles) : 1),
  );
  const durationMs = assertion.durationMs ?? Math.min(60_000, defaultDuration);
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
  let cyclesObserved = 0;

  if (groups.length === 0) {
    if (observed.length > 0) mismatchIndex = 0;
  } else if (!allowRepeat) {
    let obsCursor = 0;
    for (let gIdx = 0; gIdx < groups.length; gIdx++) {
      const res = matchGroupAt(observed, obsCursor, groups[gIdx]);
      if (!res.matched) {
        mismatchIndex = gIdx;
        break;
      }
      obsCursor += groups[gIdx].tokens.length;
    }
    if (mismatchIndex === null) {
      if (obsCursor !== observed.length) {
        mismatchIndex = groups.length;
      } else {
        cyclesObserved = 1;
      }
    }
  } else {
    // Continuous / repeating mode: verify 1..K full cycles plus optional valid trailing prefix
    let obsCursor = 0;
    let groupStep = 0;
    while (obsCursor < observed.length) {
      const grp = groups[groupStep % groups.length];
      const res = matchGroupAt(observed, obsCursor, grp);
      if (res.matched) {
        obsCursor += grp.tokens.length;
        groupStep++;
      } else if (res.partialOk && obsCursor + grp.tokens.length > observed.length) {
        // Simulation window ended mid-step on a subsequent cycle; prefix is valid
        break;
      } else {
        mismatchIndex = groupStep;
        break;
      }
    }
    cyclesObserved = Math.floor(groupStep / groups.length);
    if (mismatchIndex === null && cyclesObserved < minCycles) {
      mismatchIndex = groupStep;
    }
  }

  // Measure first-cycle completion time
  let cycleTimeMs: number | null = null;
  const motionEvents = sim.events.filter(
    (e) => e.kind === 'cylinder_extended' || e.kind === 'cylinder_retracted',
  );
  if (mismatchIndex === null && totalMotionsPerCycle > 0 && motionEvents.length >= totalMotionsPerCycle) {
    const startAt = assertion.inputs.length > 0 ? Math.min(...assertion.inputs.map((i) => i.atMs)) : 0;
    const endAt = motionEvents[totalMotionsPerCycle - 1].timeMs;
    cycleTimeMs = Math.max(0, endAt - startAt);
  }

  const hasErrorDiagnostics = sim.diagnostics.some((d) => d.severity === 'error');
  let passed = mismatchIndex === null && !hasErrorDiagnostics;
  let failureSummary: string | undefined;

  if (mismatchIndex !== null) {
    if (allowRepeat && cyclesObserved < minCycles && observed.length < minCycles * totalMotionsPerCycle) {
      failureSummary = `Expected at least ${minCycles} continuous cycle(s) of [${expected.join(', ')}], but only ${cyclesObserved} completed (observed: [${observed.join(', ')}]).`;
    } else {
      const expGroup = groups[mismatchIndex % Math.max(1, groups.length)];
      const expToken = !allowRepeat && mismatchIndex >= groups.length ? '<end-of-cycle>' : (expGroup?.raw ?? '<end-of-cycle>');
      const obsSlice = observed.slice(
        Math.min(observed.length, mismatchIndex),
        Math.min(observed.length, mismatchIndex + (expGroup?.tokens.length ?? 1)),
      );
      const obsToken = obsSlice.length > 0 ? obsSlice.join(',') : '<no-motion>';
      failureSummary = `Sequence mismatch at step ${mismatchIndex}: expected "${expToken}", observed "${obsToken}".`;
    }
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

    const expectedLimit = allowRepeat
      ? Math.max(totalMotionsPerCycle, observed.length)
      : totalMotionsPerCycle;
    eStopVerified = lateMotions.length === 0 && estopSim.observedSequence.length < expectedLimit;

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
    cyclesObserved,
    diagnostics: sim.diagnostics,
    ...(failureSummary ? { failureSummary } : {}),
    ...(eStopVerified !== undefined ? { eStopVerified } : {}),
  };
}
