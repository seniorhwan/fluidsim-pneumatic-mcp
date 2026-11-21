import type { CircuitDocument } from '../contracts/circuit';
import type {
  SimDiagnostic,
  SimEventRecord,
  SimFinalState,
  SimInputEvent,
  SimOptions,
  SimResult,
  SimSample,
} from '../contracts/simulation';
import {
  buildElectricalStaticTopology,
  createInitialElectricalState,
  stepElectricalSolver,
} from './electricalSolver';
import {
  buildPneumaticStaticTopology,
  createInitialPneumaticState,
  stepPneumaticSolver,
} from './pneumaticSolver';

export function simulateCircuit(doc: CircuitDocument, options: SimOptions = {}): SimResult {
  const durationMs = Math.max(50, Math.min(options.durationMs ?? 5000, 60_000));
  const stepMs = Math.max(2, Math.min(options.stepMs ?? 10, 100));
  const inputs: SimInputEvent[] = options.inputs ?? [];
  const includeSamples = options.includeSamples ?? false;
  const sampleIntervalMs = Math.max(stepMs, options.sampleIntervalMs ?? 100);

  const elecTopology = buildElectricalStaticTopology(doc);
  const pneuTopology = buildPneumaticStaticTopology(doc);
  const elecState = createInitialElectricalState(doc);
  const pneuState = createInitialPneumaticState(doc);

  const events: SimEventRecord[] = [];
  const samples: SimSample[] = [];
  const diagnostics: SimDiagnostic[] = [];
  const observedSequence: string[] = [];

  const totalTicks = Math.floor(durationMs / stepMs);
  const heldInputs = new Set<string>();
  const processedInputIdx = new Set<number>();

  // Track previous electrical states for concise edge-only event logging
  const prevRelays: Record<string, boolean> = { ...elecState.relayCoilById };
  const prevSolenoids: Record<string, boolean> = { ...elecState.solenoidsById };
  const prevSensors = new Set<string>(pneuState.activeSensorLabels);

  const compByLabelOrId = (labelOrId: string) =>
    doc.components.filter((c) => c.id === labelOrId || c.label === labelOrId);

  for (let tick = 0; tick <= totalTicks; tick++) {
    const timeMs = tick * stepMs;

    // 1. Evaluate active scripted inputs for this tick
    const pressedThisTick = new Set<string>(heldInputs);

    inputs.forEach((ev, idx) => {
      if (ev.action === 'press') {
        const endMs = ev.atMs + (ev.durationMs ?? 200);
        if (timeMs >= ev.atMs && timeMs < endMs) {
          pressedThisTick.add(ev.label);
        }
        if (timeMs >= ev.atMs && !processedInputIdx.has(idx)) {
          processedInputIdx.add(idx);
          // Also toggle detent switches/valves on leading edge
          for (const c of compByLabelOrId(ev.label)) {
            if (c.params.detent === true) {
              elecState.detentLatched[c.id] = !elecState.detentLatched[c.id];
            }
            if (pneuState.valves[c.id] && c.leftActuation?.type === 'detent') {
              pneuState.valves[c.id].detentLatched = !pneuState.valves[c.id].detentLatched;
            }
          }
          events.push({
            tick,
            timeMs,
            kind: 'input',
            componentId: ev.label,
            label: ev.label,
            detail: `Input "${ev.label}" pressed (${ev.durationMs ?? 200}ms)`,
          });
        }
      } else if (ev.action === 'hold' && timeMs >= ev.atMs && !processedInputIdx.has(idx)) {
        processedInputIdx.add(idx);
        heldInputs.add(ev.label);
        pressedThisTick.add(ev.label);
        for (const c of compByLabelOrId(ev.label)) {
          if (c.params.detent === true) elecState.detentLatched[c.id] = true;
          if (pneuState.valves[c.id] && c.leftActuation?.type === 'detent') {
            pneuState.valves[c.id].detentLatched = true;
          }
        }
        events.push({
          tick,
          timeMs,
          kind: 'input',
          componentId: ev.label,
          label: ev.label,
          detail: `Input "${ev.label}" held active`,
        });
      } else if (ev.action === 'release' && timeMs >= ev.atMs && !processedInputIdx.has(idx)) {
        processedInputIdx.add(idx);
        heldInputs.delete(ev.label);
        pressedThisTick.delete(ev.label);
        for (const c of compByLabelOrId(ev.label)) {
          if (c.params.detent === true) elecState.detentLatched[c.id] = false;
          if (pneuState.valves[c.id] && c.leftActuation?.type === 'detent') {
            pneuState.valves[c.id].detentLatched = false;
          }
        }
        events.push({
          tick,
          timeMs,
          kind: 'input',
          componentId: ev.label,
          label: ev.label,
          detail: `Input "${ev.label}" released`,
        });
      } else if (ev.action === 'toggle' && timeMs >= ev.atMs && !processedInputIdx.has(idx)) {
        processedInputIdx.add(idx);
        if (heldInputs.has(ev.label)) heldInputs.delete(ev.label);
        else heldInputs.add(ev.label);
        for (const c of compByLabelOrId(ev.label)) {
          if (c.params.detent === true) {
            elecState.detentLatched[c.id] = !elecState.detentLatched[c.id];
          }
          if (pneuState.valves[c.id] && c.leftActuation?.type === 'detent') {
            pneuState.valves[c.id].detentLatched = !pneuState.valves[c.id].detentLatched;
          }
        }
        events.push({
          tick,
          timeMs,
          kind: 'input',
          componentId: ev.label,
          label: ev.label,
          detail: `Input "${ev.label}" toggled`,
        });
      }
    });

    // 2. Step electrical ladder solver (uses current active cylinder sensors)
    const elecOut = stepElectricalSolver({
      doc,
      state: elecState,
      stepMs,
      tick,
      timeMs,
      pressedInputs: pressedThisTick,
      activeSensorLabels: pneuState.activeSensorLabels,
      topology: elecTopology,
    });

    for (const d of elecOut.diagnostics) {
      diagnostics.push(d);
      events.push({
        tick,
        timeMs,
        kind: 'diagnostic',
        componentId: d.offendingIds[0] ?? 'electrical',
        detail: `${d.code}: ${d.message}`,
      });
    }

    // Record relay / solenoid state transitions
    for (const c of doc.components) {
      if (
        c.type === 'relay_coil' ||
        c.type === 'timer_relay_on_delay' ||
        c.type === 'timer_relay_off_delay' ||
        c.type === 'electrical_counter'
      ) {
        const cur = elecState.relayCoilById[c.id] ?? false;
        if (prevRelays[c.id] !== cur) {
          prevRelays[c.id] = cur;
          events.push({
            tick,
            timeMs,
            kind: cur ? 'relay_energized' : 'relay_deenergized',
            componentId: c.id,
            label: c.label,
            detail: `Relay ${c.label ?? c.id} ${cur ? 'energized' : 'de-energized'}`,
          });
        }
      } else if (c.type === 'valve_solenoid') {
        const cur = elecState.solenoidsById[c.id] ?? false;
        if (prevSolenoids[c.id] !== cur) {
          prevSolenoids[c.id] = cur;
          events.push({
            tick,
            timeMs,
            kind: cur ? 'solenoid_energized' : 'solenoid_deenergized',
            componentId: c.id,
            label: c.label,
            detail: `Solenoid ${c.label ?? c.id} ${cur ? 'energized' : 'de-energized'}`,
          });
        }
      }
    }

    // 3. Step pneumatic solver (uses current solenoid states & inputs)
    const pneuOut = stepPneumaticSolver({
      doc,
      state: pneuState,
      stepMs,
      tick,
      timeMs,
      pressedInputs: pressedThisTick,
      solenoidsByLabel: elecState.solenoidsByLabel,
      supplyPressureOverrideBar: options.supplyPressureBar,
      topology: pneuTopology,
    });

    for (const d of pneuOut.diagnostics) {
      diagnostics.push(d);
      events.push({
        tick,
        timeMs,
        kind: 'diagnostic',
        componentId: d.offendingIds[0] ?? 'pneumatic',
        detail: `${d.code}: ${d.message}`,
      });
    }

    for (const ev of pneuOut.events) {
      events.push({
        tick,
        timeMs,
        kind: ev.kind,
        componentId: ev.componentId,
        label: ev.label,
        detail: ev.detail,
      });
      if (ev.sequenceToken) {
        observedSequence.push(ev.sequenceToken);
      }
    }

    // Track newly triggered distance-rule sensors
    for (const s of pneuState.activeSensorLabels) {
      if (!prevSensors.has(s)) {
        events.push({
          tick,
          timeMs,
          kind: 'sensor_triggered',
          componentId: s,
          label: s,
          detail: `Distance-rule sensor "${s}" activated`,
        });
      }
    }
    prevSensors.clear();
    for (const s of pneuState.activeSensorLabels) prevSensors.add(s);

    // Optional periodic sample snapshot
    if (includeSamples && timeMs % sampleIntervalMs === 0) {
      const cylSnap: SimSample['cylinders'] = {};
      for (const [cid, cs] of Object.entries(pneuState.cylinders)) {
        cylSnap[cid] = {
          positionMm: cs.positionMm,
          pct: Math.round((cs.positionMm / cs.strokeMm) * 100),
          velocityMmPerS: cs.velocityMmPerS,
        };
      }
      const valveSnap: SimSample['valves'] = {};
      for (const [vid, vs] of Object.entries(pneuState.valves)) {
        valveSnap[vid] = { state: vs.state };
      }
      samples.push({
        tick,
        timeMs,
        cylinders: cylSnap,
        valves: valveSnap,
        relays: { ...elecState.coilOutputsByLabel },
        solenoids: { ...elecState.solenoidsByLabel },
      });
    }

    if (elecOut.shortCircuitDetected || elecOut.oscillationDetected) {
      break;
    }
  }

  // Build final state snapshot
  const finalState: SimFinalState = {
    cylinders: {},
    valves: {},
    relays: {},
    solenoids: {},
    lamps: {},
  };

  for (const [cid, cs] of Object.entries(pneuState.cylinders)) {
    finalState.cylinders[cid] = {
      label: cs.label,
      positionMm: cs.positionMm,
      strokeMm: cs.strokeMm,
      ...(cs.unit === 'deg' ? { unit: 'deg' as const } : {}),
      pct: Math.round((cs.positionMm / cs.strokeMm) * 100),
      activeMarkers: [...cs.activeMarkers],
    };
  }
  for (const [vid, vs] of Object.entries(pneuState.valves)) {
    finalState.valves[vid] = {
      label: vs.label,
      state: vs.state,
      pilotLeftBar: Number(vs.pilotLeftBar.toFixed(2)),
      pilotRightBar: Number(vs.pilotRightBar.toFixed(2)),
    };
  }
  if (Object.keys(pneuState.vacuum).length > 0) {
    finalState.vacuum = {};
    for (const [id, v] of Object.entries(pneuState.vacuum)) {
      finalState.vacuum[id] = {
        label: v.label,
        pressureBar: v.pressureBar,
        gripped: v.gripped,
      };
    }
  }
  if (Object.keys(pneuState.pressureSwitches).length > 0) {
    finalState.pressureSwitches = {};
    for (const [id, ps] of Object.entries(pneuState.pressureSwitches)) {
      finalState.pressureSwitches[id] = {
        label: ps.label,
        active: ps.triggered,
        diffBar: ps.pressureBar,
        thresholdBar: ps.thresholdBar,
      };
    }
  }
  if (Object.keys(pneuState.gauges).length > 0) {
    finalState.gauges = {};
    for (const [id, g] of Object.entries(pneuState.gauges)) {
      finalState.gauges[id] = {
        label: g.label,
        pressureBar: g.pressureBar,
      };
    }
  }
  for (const c of doc.components) {
    if (
      c.type === 'relay_coil' ||
      c.type === 'timer_relay_on_delay' ||
      c.type === 'timer_relay_off_delay' ||
      c.type === 'electrical_counter'
    ) {
      finalState.relays[c.id] = {
        label: c.label ?? c.id,
        energized: elecState.relayCoilById[c.id] ?? false,
      };
    } else if (c.type === 'valve_solenoid') {
      finalState.solenoids[c.id] = {
        label: c.label ?? c.id,
        energized: elecState.solenoidsById[c.id] ?? false,
      };
    } else if (c.type === 'indicator_lamp') {
      finalState.lamps[c.id] = {
        label: c.label ?? c.id,
        lit: elecState.lampsById[c.id] ?? false,
      };
    }
  }

  return {
    completed: true,
    durationMs,
    stepMs,
    totalTicks,
    observedSequence,
    events,
    ...(includeSamples ? { samples } : {}),
    diagnostics,
    finalState,
  };
}
