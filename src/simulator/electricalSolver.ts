import type { CircuitDocument, ComponentNode } from '../contracts/circuit';
import type { SimDiagnostic } from '../contracts/simulation';

export interface ElectricalState {
  /** Relay / timer / counter output energized states keyed by coil label (e.g., "K1", "T1", "C1"). */
  coilOutputsByLabel: Record<string, boolean>;
  /** Individual coil component energized states keyed by component ID. */
  relayCoilById: Record<string, boolean>;
  /** Valve solenoid energized states keyed by solenoid label (e.g., "Y1"). */
  solenoidsByLabel: Record<string, boolean>;
  /** Valve solenoid states keyed by component ID. */
  solenoidsById: Record<string, boolean>;
  /** Indicator lamp lit states keyed by component ID. */
  lampsById: Record<string, boolean>;
  /** Internal timer accumulation in ms keyed by component ID. */
  timerElapsedMs: Record<string, number>;
  /** Internal off-delay remaining hold in ms keyed by component ID. */
  offDelayRemainingMs: Record<string, number>;
  /** Internal counter state keyed by component ID. */
  counterCounts: Record<string, number>;
  /** Previous count-pulse edge state for rising-edge detection. */
  counterPrevPulse: Record<string, boolean>;
  /** Detent switch latched states keyed by component ID. */
  detentLatched: Record<string, boolean>;
}

export function createInitialElectricalState(doc: CircuitDocument): ElectricalState {
  const state: ElectricalState = {
    coilOutputsByLabel: {},
    relayCoilById: {},
    solenoidsByLabel: {},
    solenoidsById: {},
    lampsById: {},
    timerElapsedMs: {},
    offDelayRemainingMs: {},
    counterCounts: {},
    counterPrevPulse: {},
    detentLatched: {},
  };

  for (const c of doc.components) {
    if (
      c.type === 'relay_coil' ||
      c.type === 'timer_relay_on_delay' ||
      c.type === 'timer_relay_off_delay' ||
      c.type === 'electrical_counter'
    ) {
      state.relayCoilById[c.id] = false;
      if (c.label) state.coilOutputsByLabel[c.label] = false;
      state.timerElapsedMs[c.id] = 0;
      state.offDelayRemainingMs[c.id] = 0;
      state.counterCounts[c.id] = 0;
      state.counterPrevPulse[c.id] = false;
    } else if (c.type === 'valve_solenoid') {
      state.solenoidsById[c.id] = false;
      if (c.label) state.solenoidsByLabel[c.label] = false;
    } else if (c.type === 'indicator_lamp') {
      state.lampsById[c.id] = false;
    }
  }

  return state;
}

function pKey(cid: string, port: string): string {
  return `${cid}::${port}`;
}

export interface ElectricalStaticTopology {
  elecComps: ComponentNode[];
  rails24: ComponentNode[];
  rails0: ComponentNode[];
  baseAdj: Map<string, string[]>;
}

function addAdjEdge(g: Map<string, string[]>, a: string, b: string): void {
  let la = g.get(a);
  if (!la) {
    la = [];
    g.set(a, la);
  }
  la.push(b);
  let lb = g.get(b);
  if (!lb) {
    lb = [];
    g.set(b, lb);
  }
  lb.push(a);
}

export function buildElectricalStaticTopology(doc: CircuitDocument): ElectricalStaticTopology {
  const elecComps = doc.components.filter((c) => isElectricalComponent(c.type));
  const rails24 = elecComps.filter((c) => c.type === 'power_24v');
  const rails0 = elecComps.filter((c) => c.type === 'power_0v');
  const baseAdj = new Map<string, string[]>();

  for (const e of doc.connections) {
    if (e.domain !== 'electrical') continue;
    addAdjEdge(baseAdj, pKey(e.from.componentId, e.from.port), pKey(e.to.componentId, e.to.port));
  }
  for (const c of elecComps) {
    if (c.type === 'electrical_junction') {
      const ports = ['1', '2', '3', '4'];
      for (let i = 0; i < ports.length; i++) {
        for (let j = i + 1; j < ports.length; j++) {
          addAdjEdge(baseAdj, pKey(c.id, ports[i]), pKey(c.id, ports[j]));
        }
      }
    }
  }

  return { elecComps, rails24, rails0, baseAdj };
}

export interface ElectricalTickInput {
  doc: CircuitDocument;
  state: ElectricalState;
  stepMs: number;
  tick: number;
  timeMs: number;
  /** Currently pressed manual inputs (labels or component IDs). */
  pressedInputs: Set<string>;
  /** Currently active cylinder distance-rule sensor labels (e.g., "a0", "b1"). */
  activeSensorLabels: Set<string>;
  topology?: ElectricalStaticTopology;
}

export interface ElectricalTickOutput {
  diagnostics: SimDiagnostic[];
  shortCircuitDetected: boolean;
  oscillationDetected: boolean;
}

export function stepElectricalSolver(input: ElectricalTickInput): ElectricalTickOutput {
  const { doc, state, stepMs, tick, timeMs, pressedInputs, activeSensorLabels, topology } = input;
  const diagnostics: SimDiagnostic[] = [];

  const topo = topology ?? buildElectricalStaticTopology(doc);
  const { elecComps, rails24, rails0, baseAdj } = topo;
  if (elecComps.length === 0) {
    return { diagnostics, shortCircuitDetected: false, oscillationDetected: false };
  }
  const addEdge = addAdjEdge;

  const isPressed = (c: ComponentNode): boolean => {
    const manual = pressedInputs.has(c.id) || (c.label !== undefined && pressedInputs.has(c.label));
    if (c.params.detent === true) {
      return state.detentLatched[c.id] === true;
    }
    return manual;
  };

  const evaluatePass = (): {
    has24: Set<string>;
    has0: Set<string>;
    shorted: boolean;
  } => {
    const adj = new Map<string, string[]>();
    for (const [k, v] of baseAdj.entries()) {
      adj.set(k, [...v]);
    }

    for (const c of elecComps) {
      if (c.type === 'pushbutton_no') {
        if (isPressed(c)) addEdge(adj, pKey(c.id, '13'), pKey(c.id, '14'));
      } else if (c.type === 'pushbutton_nc') {
        if (!isPressed(c)) addEdge(adj, pKey(c.id, '11'), pKey(c.id, '12'));
      } else if (c.type === 'limit_switch_no') {
        if (c.label && activeSensorLabels.has(c.label)) {
          addEdge(adj, pKey(c.id, '13'), pKey(c.id, '14'));
        }
      } else if (c.type === 'limit_switch_nc') {
        if (!c.label || !activeSensorLabels.has(c.label)) {
          addEdge(adj, pKey(c.id, '11'), pKey(c.id, '12'));
        }
      } else if (c.type === 'proximity_switch_magnetic') {
        const triggered = Boolean(c.label && activeSensorLabels.has(c.label));
        const closed = c.params.normalState === 'NC' ? !triggered : triggered;
        if (closed) addEdge(adj, pKey(c.id, '13'), pKey(c.id, '14'));
      } else if (c.type === 'relay_contact_no') {
        if (c.label && (state.coilOutputsByLabel[c.label] || activeSensorLabels.has(c.label))) {
          addEdge(adj, pKey(c.id, '13'), pKey(c.id, '14'));
        }
      } else if (c.type === 'relay_contact_nc') {
        if (!c.label || (!state.coilOutputsByLabel[c.label] && !activeSensorLabels.has(c.label))) {
          addEdge(adj, pKey(c.id, '11'), pKey(c.id, '12'));
        }
      } else if (c.type === 'relay_contact_changeover') {
        const active = Boolean(c.label && (state.coilOutputsByLabel[c.label] || activeSensorLabels.has(c.label)));
        if (active) addEdge(adj, pKey(c.id, '11'), pKey(c.id, '14'));
        else addEdge(adj, pKey(c.id, '11'), pKey(c.id, '12'));
      }
    }

    const bfs = (seeds: string[]): Set<string> => {
      const seen = new Set<string>(seeds);
      const q = [...seeds];
      while (q.length > 0) {
        const u = q.shift()!;
        for (const v of adj.get(u) ?? []) {
          if (!seen.has(v)) {
            seen.add(v);
            q.push(v);
          }
        }
      }
      return seen;
    };

    const has24 = bfs(rails24.map((r) => pKey(r.id, 'OUT')));
    const has0 = bfs(rails0.map((r) => pKey(r.id, 'IN')));
    let shorted = false;
    for (const node of has24) {
      if (has0.has(node)) {
        shorted = true;
        break;
      }
    }
    return { has24, has0, shorted };
  };

  const isPowered = (
    has24: Set<string>,
    has0: Set<string>,
    cid: string,
    pA: string,
    pB: string,
  ): boolean => {
    const ka = pKey(cid, pA);
    const kb = pKey(cid, pB);
    return (has24.has(ka) && has0.has(kb)) || (has24.has(kb) && has0.has(ka));
  };

  // Fixed-point relay convergence loop (detects instantaneous relay chatter/oscillation)
  const MAX_ITER = 12;
  let converged = false;
  let shortCircuitDetected = false;
  let lastPass = evaluatePass();

  for (let iter = 0; iter < MAX_ITER; iter++) {
    lastPass = evaluatePass();
    if (lastPass.shorted) {
      shortCircuitDetected = true;
      break;
    }

    let changed = false;
    for (const c of elecComps) {
      if (c.type === 'relay_coil') {
        const powered = isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
        if (state.relayCoilById[c.id] !== powered) {
          state.relayCoilById[c.id] = powered;
          if (c.label) state.coilOutputsByLabel[c.label] = powered;
          changed = true;
        }
      }
    }
    if (!changed) {
      converged = true;
      break;
    }
  }

  let oscillationDetected = false;
  if (!converged && !shortCircuitDetected) {
    oscillationDetected = true;
    const oscillatingRelays = elecComps.filter((c) => c.type === 'relay_coil').map((c) => c.id);
    diagnostics.push({
      severity: 'error',
      category: 'ElectricalRuleViolation',
      code: 'RELAY_OSCILLATION_CHATTER',
      tick,
      timeMs,
      message: `Electrical relay logic failed to converge at t=${timeMs}ms (self-breaking NC feedback / relay chatter).`,
      offendingIds: oscillatingRelays,
      suggestedFix:
        'Check for a relay coil fed through its own NC contact without a delay or separate latch step.',
    });
  }

  if (shortCircuitDetected) {
    diagnostics.push({
      severity: 'error',
      category: 'ElectricalRuleViolation',
      code: 'LIVE_SHORT_CIRCUIT',
      tick,
      timeMs,
      message: `Live +24V to 0V short-circuit occurred at t=${timeMs}ms.`,
      offendingIds: [...rails24.map((r) => r.id), ...rails0.map((r) => r.id)],
      suggestedFix: 'Ensure every closed switch path between +24V and 0V passes through a coil, solenoid, or lamp.',
    });
  }

  // Update stateful time/count elements once per simulation tick
  let timerOrCounterToggled = false;
  for (const c of elecComps) {
    if (c.type === 'timer_relay_on_delay') {
      const powered = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
      const delayMs = typeof c.params.delayMs === 'number' ? c.params.delayMs : 1000;
      if (powered) {
        state.timerElapsedMs[c.id] = (state.timerElapsedMs[c.id] ?? 0) + stepMs;
      } else {
        state.timerElapsedMs[c.id] = 0;
      }
      const active = powered && state.timerElapsedMs[c.id] >= delayMs;
      if (state.relayCoilById[c.id] !== active) timerOrCounterToggled = true;
      state.relayCoilById[c.id] = active;
      if (c.label) state.coilOutputsByLabel[c.label] = active;
    } else if (c.type === 'timer_relay_off_delay') {
      const powered = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
      const delayMs = typeof c.params.delayMs === 'number' ? c.params.delayMs : 1000;
      if (powered) {
        state.offDelayRemainingMs[c.id] = delayMs;
      } else if ((state.offDelayRemainingMs[c.id] ?? 0) > 0) {
        state.offDelayRemainingMs[c.id] = Math.max(0, state.offDelayRemainingMs[c.id] - stepMs);
      }
      const active = powered || (state.offDelayRemainingMs[c.id] ?? 0) > 0;
      if (state.relayCoilById[c.id] !== active) timerOrCounterToggled = true;
      state.relayCoilById[c.id] = active;
      if (c.label) state.coilOutputsByLabel[c.label] = active;
    } else if (c.type === 'electrical_counter') {
      const pulse = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
      const reset = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'R1', 'R2');
      const preset = typeof c.params.presetCount === 'number' ? c.params.presetCount : 3;
      if (reset) {
        state.counterCounts[c.id] = 0;
      } else if (pulse && !state.counterPrevPulse[c.id]) {
        state.counterCounts[c.id] = (state.counterCounts[c.id] ?? 0) + 1;
      }
      state.counterPrevPulse[c.id] = pulse;
      const active = (state.counterCounts[c.id] ?? 0) >= preset;
      if (state.relayCoilById[c.id] !== active) timerOrCounterToggled = true;
      state.relayCoilById[c.id] = active;
      if (c.label) state.coilOutputsByLabel[c.label] = active;
    }
  }

  // If a timer or counter flipped on this tick, propagate immediately to dependent relays before evaluating outputs
  if (timerOrCounterToggled && !shortCircuitDetected && !oscillationDetected) {
    for (let iter = 0; iter < 6; iter++) {
      lastPass = evaluatePass();
      if (lastPass.shorted) {
        shortCircuitDetected = true;
        break;
      }
      let changed = false;
      for (const c of elecComps) {
        if (c.type === 'relay_coil') {
          const powered = isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
          if (state.relayCoilById[c.id] !== powered) {
            state.relayCoilById[c.id] = powered;
            if (c.label) state.coilOutputsByLabel[c.label] = powered;
            changed = true;
          }
        }
      }
      if (!changed) break;
    }
  }

  // Evaluate solenoids and indicator lamps against converged circuit state
  for (const c of elecComps) {
    if (c.type === 'valve_solenoid') {
      const powered = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'A1', 'A2');
      state.solenoidsById[c.id] = powered;
      if (c.label) state.solenoidsByLabel[c.label] = powered;
    } else if (c.type === 'indicator_lamp') {
      const powered = !shortCircuitDetected && isPowered(lastPass.has24, lastPass.has0, c.id, 'X1', 'X2');
      state.lampsById[c.id] = powered;
    }
  }

  return { diagnostics, shortCircuitDetected, oscillationDetected };
}

function isElectricalComponent(type: string): boolean {
  return (
    type === 'power_24v' ||
    type === 'power_0v' ||
    type === 'electrical_junction' ||
    type === 'pushbutton_no' ||
    type === 'pushbutton_nc' ||
    type === 'limit_switch_no' ||
    type === 'limit_switch_nc' ||
    type === 'proximity_switch_magnetic' ||
    type === 'relay_coil' ||
    type === 'relay_contact_no' ||
    type === 'relay_contact_nc' ||
    type === 'relay_contact_changeover' ||
    type === 'timer_relay_on_delay' ||
    type === 'timer_relay_off_delay' ||
    type === 'electrical_counter' ||
    type === 'valve_solenoid' ||
    type === 'indicator_lamp'
  );
}
