import type { CircuitDocument, ComponentNode, ValveActuationSide } from '../contracts/circuit';
import type { SimDiagnostic } from '../contracts/simulation';

export type ValveSpoolState = 'left' | 'center' | 'right';

export interface CylinderRuntimeState {
  id: string;
  label: string;
  strokeMm: number;
  unit: 'mm' | 'deg';
  positionMm: number;
  velocityMmPerS: number;
  lastMotionState: 'idle' | 'extending' | 'retracting';
  lastEndReached: 'retracted' | 'extended' | 'mid';
  activeMarkers: string[];
  exhaustBlockedReported: boolean;
  overloadStallReported: boolean;
}

export interface ValveRuntimeState {
  id: string;
  label: string;
  state: ValveSpoolState;
  pilotLeftBar: number;
  pilotRightBar: number;
  opposingPilotActive: boolean;
  detentLatched: boolean;
}

export interface VacuumRuntimeState {
  id: string;
  label: string;
  pressureBar: number;
  gripped: boolean;
}

export interface PressureSwitchRuntimeState {
  id: string;
  label: string;
  pressureBar: number;
  thresholdBar: number;
  triggered: boolean;
}

export interface GaugeRuntimeState {
  id: string;
  label: string;
  pressureBar: number;
}

export interface PneumaticState {
  cylinders: Record<string, CylinderRuntimeState>;
  valves: Record<string, ValveRuntimeState>;
  vacuum: Record<string, VacuumRuntimeState>;
  pressureSwitches: Record<string, PressureSwitchRuntimeState>;
  gauges: Record<string, GaugeRuntimeState>;
  /** Signed gauge pressure per pneumatic port key ("compId::port") in bar (negative = vacuum). */
  portPressures: Record<string, number>;
  /** Time-delay valve internal timer in ms. */
  timeDelayElapsedMs: Record<string, number>;
  /** Active cylinder distance-rule & PEW pressure-switch sensor labels. */
  activeSensorLabels: Set<string>;
  /** Active directional motion direction per sensor label (for idle-return rollers). */
  sensorDirectionByLabel: Record<string, 'extending' | 'retracting' | 'idle'>;
}

function pKey(cid: string, port: string): string {
  return `${cid}::${port}`;
}

function isDirectionalValve(type: ComponentNode['type']): boolean {
  return (
    type === 'valve_2_2' ||
    type === 'valve_3_2' ||
    type === 'valve_4_2' ||
    type === 'valve_5_2' ||
    type === 'valve_5_3'
  );
}

function isSpringReturnSide(side?: ValveActuationSide): boolean {
  if (!side) return false;
  return (
    side.type === 'spring' ||
    side.type === 'pneumatic_spring' ||
    side.springReturn === true
  );
}

export function createInitialPneumaticState(doc: CircuitDocument): PneumaticState {
  const cylinders: Record<string, CylinderRuntimeState> = {};
  const valves: Record<string, ValveRuntimeState> = {};
  const vacuum: Record<string, VacuumRuntimeState> = {};
  const pressureSwitches: Record<string, PressureSwitchRuntimeState> = {};
  const gauges: Record<string, GaugeRuntimeState> = {};
  const timeDelayElapsedMs: Record<string, number> = {};
  const activeSensorLabels = new Set<string>();
  const sensorDirectionByLabel: Record<string, 'extending' | 'retracting' | 'idle'> = {};

  for (const c of doc.components) {
    if (
      c.type === 'cylinder_double_acting' ||
      c.type === 'cylinder_single_acting' ||
      c.type === 'cylinder_rodless' ||
      c.type === 'swivel_drive'
    ) {
      const isSwivel = c.type === 'swivel_drive';
      const strokeMm = isSwivel
        ? typeof c.params.maxAngleDeg === 'number'
          ? c.params.maxAngleDeg
          : 180
        : typeof c.params.strokeMm === 'number'
          ? c.params.strokeMm
          : c.type === 'cylinder_single_acting'
            ? 50
            : c.type === 'cylinder_rodless'
              ? 200
              : 100;
      const initialRaw = isSwivel ? c.params.initialAngleDeg : c.params.initialPositionMm;
      const initialPositionMm =
        typeof initialRaw === 'number'
          ? Math.max(0, Math.min(strokeMm, initialRaw))
          : 0;
      const activeMarkers: string[] = [];
      for (const m of c.distanceRule ?? []) {
        const tol = m.toleranceMm ?? 2;
        if (Math.abs(initialPositionMm - m.positionMm) <= tol) {
          activeMarkers.push(m.label);
          activeSensorLabels.add(m.label);
          sensorDirectionByLabel[m.label] = 'idle';
        }
      }
      cylinders[c.id] = {
        id: c.id,
        label: c.label ?? c.id,
        strokeMm,
        unit: isSwivel ? 'deg' : 'mm',
        positionMm: initialPositionMm,
        velocityMmPerS: 0,
        lastMotionState: 'idle',
        lastEndReached:
          initialPositionMm <= 0.5
            ? 'retracted'
            : initialPositionMm >= strokeMm - 0.5
              ? 'extended'
              : 'mid',
        activeMarkers,
        exhaustBlockedReported: false,
        overloadStallReported: false,
      };
    } else if (isDirectionalValve(c.type)) {
      let initialState: ValveSpoolState = 'right';
      if (c.type === 'valve_5_3') {
        initialState = 'center';
      } else if (c.params.initialState === 'left') {
        initialState = 'left';
      } else if (
        c.params.initialState !== 'right' &&
        isSpringReturnSide(c.leftActuation) &&
        !isSpringReturnSide(c.rightActuation)
      ) {
        initialState = 'left';
      }
      valves[c.id] = {
        id: c.id,
        label: c.label ?? c.id,
        state: initialState,
        pilotLeftBar: 0,
        pilotRightBar: 0,
        opposingPilotActive: false,
        detentLatched: false,
      };
    } else if (c.type === 'time_delay_valve') {
      timeDelayElapsedMs[c.id] = 0;
    } else if (c.type === 'vacuum_sucker') {
      vacuum[c.id] = {
        id: c.id,
        label: c.label ?? c.id,
        pressureBar: 0,
        gripped: false,
      };
    } else if (c.type === 'pressure_switch_differential') {
      const setP = typeof c.params.pressureBar === 'number' ? c.params.pressureBar : -0.45;
      pressureSwitches[c.id] = {
        id: c.id,
        label: c.label ?? c.id,
        pressureBar: 0,
        thresholdBar: setP,
        triggered: false,
      };
    } else if (c.type === 'pressure_gauge') {
      gauges[c.id] = {
        id: c.id,
        label: c.label ?? c.id,
        pressureBar: 0,
      };
    }
  }

  return {
    cylinders,
    valves,
    vacuum,
    pressureSwitches,
    gauges,
    portPressures: {},
    timeDelayElapsedMs,
    activeSensorLabels,
    sensorDirectionByLabel,
  };
}

export interface PneumaticStaticTopology {
  rootByPort: Map<string, string>;
  netsByRoot: Map<string, NetInfo>;
}

export function buildPneumaticStaticTopology(doc: CircuitDocument): PneumaticStaticTopology {
  const parent = new Map<string, string>();
  const findRaw = (x: string): string => {
    let cur = x;
    while (parent.has(cur) && parent.get(cur) !== cur) {
      cur = parent.get(cur)!;
    }
    let walk = x;
    while (parent.has(walk) && parent.get(walk) !== cur) {
      const next = parent.get(walk)!;
      parent.set(walk, cur);
      walk = next;
    }
    if (!parent.has(cur)) parent.set(cur, cur);
    return cur;
  };
  const union = (a: string, b: string): void => {
    const ra = findRaw(a);
    const rb = findRaw(b);
    if (ra !== rb) parent.set(rb, ra);
  };

  for (const e of doc.connections) {
    if (e.domain !== 'pneumatic') continue;
    union(pKey(e.from.componentId, e.from.port), pKey(e.to.componentId, e.to.port));
  }
  for (const c of doc.components) {
    if (c.type === 'pneumatic_junction') {
      union(pKey(c.id, '1'), pKey(c.id, '2'));
      union(pKey(c.id, '1'), pKey(c.id, '3'));
      union(pKey(c.id, '1'), pKey(c.id, '4'));
    } else if (c.type === 'pneumatic_manifold') {
      for (const pn of ['2', '3', '4', '5', '6', '7', '8']) {
        union(pKey(c.id, '1'), pKey(c.id, pn));
      }
    }
  }

  const rootByPort = new Map<string, string>();
  const netsByRoot = new Map<string, NetInfo>();
  for (const k of parent.keys()) {
    const r = findRaw(k);
    rootByPort.set(k, r);
    let info = netsByRoot.get(r);
    if (!info) {
      info = { root: r, members: [] };
      netsByRoot.set(r, info);
    }
    info.members.push(k);
  }
  return { rootByPort, netsByRoot };
}

export interface PneumaticTickInput {
  doc: CircuitDocument;
  state: PneumaticState;
  stepMs: number;
  tick: number;
  timeMs: number;
  pressedInputs: Set<string>;
  solenoidsByLabel: Record<string, boolean>;
  supplyPressureOverrideBar?: number;
  topology?: PneumaticStaticTopology;
}

export interface PneumaticMotionEvent {
  kind:
    | 'cylinder_start_extend'
    | 'cylinder_extended'
    | 'cylinder_start_retract'
    | 'cylinder_retracted'
    | 'valve_switched'
    | 'vacuum_gripped'
    | 'vacuum_released';
  componentId: string;
  label: string;
  detail: string;
  sequenceToken?: string;
}

export interface PneumaticTickOutput {
  diagnostics: SimDiagnostic[];
  events: PneumaticMotionEvent[];
}

interface NetInfo {
  root: string;
  members: string[];
}

export function stepPneumaticSolver(input: PneumaticTickInput): PneumaticTickOutput {
  const {
    doc,
    state,
    stepMs,
    tick,
    timeMs,
    pressedInputs,
    solenoidsByLabel,
    supplyPressureOverrideBar,
    topology,
  } = input;
  const diagnostics: SimDiagnostic[] = [];
  const events: PneumaticMotionEvent[] = [];

  const topo = topology ?? buildPneumaticStaticTopology(doc);
  const { rootByPort, netsByRoot } = topo;
  const find = (x: string): string => rootByPort.get(x) ?? x;

  const getPortP = (cid: string, port: string): number => {
    const k = pKey(cid, port);
    return state.portPressures[k] ?? 0;
  };

  const allowManualSolenoidInput =
    doc.metadata.allowExternalElectricalSheet === true ||
    doc.metadata.sheetDomain === 'pneumatic-only';

  // Iterative coupled valve + pressure/vacuum relaxation (resolves cascading pilot stages within a tick)
  const PILOT_THRESHOLD_BAR = 1.5;
  const netPosPressure = new Map<string, number>();
  const netVacPressure = new Map<string, number>();
  const netExhaustConnected = new Map<string, boolean>();

  const evalActuation = (
    valve: ComponentNode,
    side: ValveActuationSide | undefined,
    pilotPortName: string,
    isLeft: boolean,
  ): boolean => {
    if (!side || side.type === 'none' || side.type === 'spring' || side.type === 'pneumatic_spring') {
      return false;
    }
    const manualInputHit =
      pressedInputs.has(valve.id) ||
      (valve.label !== undefined && pressedInputs.has(valve.label)) ||
      (side.label !== undefined && pressedInputs.has(side.label));

    if (side.type === 'pushbutton') {
      return manualInputHit;
    }
    if (side.type === 'detent') {
      return state.valves[valve.id]?.detentLatched === true;
    }
    if (side.type === 'roller') {
      return Boolean(side.label && state.activeSensorLabels.has(side.label));
    }
    if (side.type === 'idle_return_roller') {
      if (!side.label || !state.activeSensorLabels.has(side.label)) return false;
      const dir = state.sensorDirectionByLabel[side.label];
      return isLeft ? dir === 'extending' || dir === 'idle' : dir === 'retracting';
    }
    if (side.type === 'solenoid') {
      if (side.label && solenoidsByLabel[side.label]) return true;
      if ((side.manualOverride === true || allowManualSolenoidInput) && manualInputHit) {
        return true;
      }
      return false;
    }
    if (side.type === 'pneumatic_pilot') {
      return getPortP(valve.id, pilotPortName) >= PILOT_THRESHOLD_BAR;
    }
    return false;
  };

  const MAX_RELAX = 6;
  const opposingFlagThisTick = new Map<string, boolean>();
  const prevValveStates: Record<string, ValveSpoolState> = {};
  for (const [vid, vs] of Object.entries(state.valves)) {
    prevValveStates[vid] = vs.state;
  }

  for (let pass = 0; pass < MAX_RELAX; pass++) {
    // 1. Update valve spool states from current pressures/solenoids/inputs
    for (const c of doc.components) {
      if (!isDirectionalValve(c.type)) continue;
      const vs = state.valves[c.id];
      if (!vs) continue;

      const leftPilotPort = c.type === 'valve_3_2' || c.type === 'valve_2_2' ? '12' : '14';
      const rightPilotPort = c.type === 'valve_3_2' || c.type === 'valve_2_2' ? '10' : '12';
      vs.pilotLeftBar = getPortP(c.id, leftPilotPort);
      vs.pilotRightBar = getPortP(c.id, rightPilotPort);

      const leftActive = evalActuation(c, c.leftActuation, leftPilotPort, true);
      const rightActive = evalActuation(c, c.rightActuation, rightPilotPort, false);
      const leftSpring = isSpringReturnSide(c.leftActuation);
      const rightSpring = isSpringReturnSide(c.rightActuation);

      if (c.type === 'valve_5_3') {
        if (leftActive && rightActive) {
          opposingFlagThisTick.set(c.id, true);
        } else if (leftActive) {
          vs.state = 'left';
        } else if (rightActive) {
          vs.state = 'right';
        } else {
          vs.state = 'center';
        }
      } else {
        if (leftActive && rightActive) {
          opposingFlagThisTick.set(c.id, true);
        } else if (leftActive) {
          vs.state = 'left';
        } else if (rightActive) {
          vs.state = 'right';
        } else if (rightSpring && !leftSpring) {
          vs.state = 'right';
        } else if (leftSpring && !rightSpring) {
          vs.state = 'left';
        }
      }
    }

    // 2. Propagate positive gauge pressures & vacuum across pneumatic nets
    netPosPressure.clear();
    netVacPressure.clear();
    netExhaustConnected.clear();

    // Seed air sources and exhausts
    for (const c of doc.components) {
      if (c.type === 'air_source') {
        const pBar =
          supplyPressureOverrideBar ??
          (typeof c.params.pressureBar === 'number' ? c.params.pressureBar : 6.0);
        const r = find(pKey(c.id, '1'));
        netPosPressure.set(r, Math.max(netPosPressure.get(r) ?? 0, pBar));
      } else if (c.type === 'exhaust_silencer') {
        const r = find(pKey(c.id, '1'));
        netExhaustConnected.set(r, true);
      }
    }

    const readNetSigned = (cid: string, port: string): number => {
      const r = find(pKey(cid, port));
      const pos = netPosPressure.get(r) ?? 0;
      if (pos > 0.01) return pos;
      if (netExhaustConnected.get(r) === true) return 0;
      const vac = netVacPressure.get(r) ?? 0;
      return vac < -0.01 ? vac : 0;
    };

    // Propagate through valves, regulators, filters, check valves, flow controls, Venturis, and logic elements
    for (let prop = 0; prop < 10; prop++) {
      let updated = false;

      const drivePos = (cid: string, port: string, pressure: number): void => {
        if (pressure <= 0.01) return;
        const r = find(pKey(cid, port));
        const prev = netPosPressure.get(r) ?? 0;
        if (pressure > prev + 0.01) {
          netPosPressure.set(r, pressure);
          updated = true;
        }
      };

      const driveVac = (cid: string, port: string, vacuumBar: number): void => {
        if (vacuumBar >= -0.01) return;
        const r = find(pKey(cid, port));
        const prev = netVacPressure.get(r) ?? 0;
        if (vacuumBar < prev - 0.01) {
          netVacPressure.set(r, vacuumBar);
          updated = true;
        }
      };

      const markExhaust = (cid: string, port: string): void => {
        const r = find(pKey(cid, port));
        if (!netExhaustConnected.get(r)) {
          netExhaustConnected.set(r, true);
          updated = true;
        }
      };

      const readPos = (cid: string, port: string): number => netPosPressure.get(find(pKey(cid, port))) ?? 0;
      const readVac = (cid: string, port: string): number => netVacPressure.get(find(pKey(cid, port))) ?? 0;
      const isNetExhaust = (cid: string, port: string): boolean =>
        netExhaustConnected.get(find(pKey(cid, port))) === true;

      for (const c of doc.components) {
        if (c.type === 'air_service_unit') {
          const cap =
            typeof c.params.nominalPressureBar === 'number' ? c.params.nominalPressureBar : 6.0;
          const pIn = readPos(c.id, '1');
          if (pIn > 0) drivePos(c.id, '2', Math.min(pIn, cap));
        } else if (c.type === 'pressure_regulator') {
          const cap = typeof c.params.setPressureBar === 'number' ? c.params.setPressureBar : 4.0;
          const pIn = readPos(c.id, '1');
          if (pIn > 0) drivePos(c.id, '2', Math.min(pIn, cap));
        } else if (c.type === 'air_filter' || c.type === 'air_reservoir' || c.type === 'throttle_valve') {
          const p1 = readPos(c.id, '1');
          const p2 = readPos(c.id, '2');
          if (p1 > p2) drivePos(c.id, '2', p1);
          else if (p2 > p1) drivePos(c.id, '1', p2);
          const v1 = readVac(c.id, '1');
          const v2 = readVac(c.id, '2');
          if (v1 < v2) driveVac(c.id, '2', v1);
          else if (v2 < v1) driveVac(c.id, '1', v2);
          if (isNetExhaust(c.id, '1')) markExhaust(c.id, '2');
          if (isNetExhaust(c.id, '2')) markExhaust(c.id, '1');
        } else if (c.type === 'pressure_relief_valve') {
          const relief = typeof c.params.reliefPressureBar === 'number' ? c.params.reliefPressureBar : 6.0;
          const p1 = readPos(c.id, '1');
          if (p1 > relief) {
            drivePos(c.id, '2', p1 - relief);
          }
        } else if (c.type === 'check_valve' || c.type === 'check_valve_spring') {
          const cracking =
            typeof c.params.crackingPressureBar === 'number'
              ? c.params.crackingPressureBar
              : c.type === 'check_valve_spring'
                ? 0.2
                : 0.05;
          const pilotOpen = c.type === 'check_valve_spring' && readPos(c.id, '12') >= PILOT_THRESHOLD_BAR;
          const p1 = readPos(c.id, '1');
          const p2 = readPos(c.id, '2');
          // Forward positive flow 1 -> 2
          if (p1 > p2 + cracking) {
            drivePos(c.id, '2', Math.max(0, p1 - cracking));
          }
          // Reverse positive flow only when pilot-opened
          if (pilotOpen && p2 > p1) {
            drivePos(c.id, '1', p2);
          }
          // Forward vacuum suction (air sucked from 1 -> 2 when port 2 is at vacuum)
          const v2 = readVac(c.id, '2');
          if (v2 < -cracking && p1 <= 0.05) {
            const vacDrop = Math.min(cracking, 0.15);
            driveVac(c.id, '1', Math.min(0, v2 + vacDrop));
          }
          // Reverse exhaust when pilot-opened or forward exhaust
          if (isNetExhaust(c.id, '2')) markExhaust(c.id, '1');
          if (pilotOpen && isNetExhaust(c.id, '1')) markExhaust(c.id, '2');
        } else if (c.type === 'flow_control_one_way') {
          const p1 = readPos(c.id, '1');
          const p2 = readPos(c.id, '2');
          if (p1 > p2) drivePos(c.id, '2', p1);
          else if (p2 > p1) drivePos(c.id, '1', p2);
          const v1 = readVac(c.id, '1');
          const v2 = readVac(c.id, '2');
          if (v1 < v2) driveVac(c.id, '2', v1);
          else if (v2 < v1) driveVac(c.id, '1', v2);
          if (isNetExhaust(c.id, '1')) markExhaust(c.id, '2');
          if (isNetExhaust(c.id, '2')) markExhaust(c.id, '1');
        } else if (c.type === 'quick_exhaust_valve') {
          const p1 = readPos(c.id, '1');
          if (p1 >= 0.5) drivePos(c.id, '2', p1);
          else if (isNetExhaust(c.id, '3')) markExhaust(c.id, '2');
        } else if (c.type === 'shuttle_valve_or') {
          const pa = readPos(c.id, '1');
          const pb = readPos(c.id, '1_2');
          const pMax = Math.max(pa, pb);
          if (pMax > 0.1) drivePos(c.id, '2', pMax);
          else if (isNetExhaust(c.id, '1') || isNetExhaust(c.id, '1_2')) markExhaust(c.id, '2');
        } else if (c.type === 'dual_pressure_valve_and') {
          const pa = readPos(c.id, '1');
          const pb = readPos(c.id, '1_2');
          if (pa >= 0.5 && pb >= 0.5) drivePos(c.id, '2', Math.min(pa, pb));
          else if (isNetExhaust(c.id, '1') || isNetExhaust(c.id, '1_2')) markExhaust(c.id, '2');
        } else if (c.type === 'vacuum_suction_nozzle') {
          const minSupply = typeof c.params.minSupplyBar === 'number' ? c.params.minSupplyBar : 2.0;
          const vacTarget = typeof c.params.vacuumBar === 'number' ? c.params.vacuumBar : -0.7;
          const p1 = readPos(c.id, '1');
          if (p1 >= minSupply && isNetExhaust(c.id, '3')) {
            driveVac(c.id, '1v', vacTarget);
          }
        } else if (c.type === 'time_delay_valve') {
          const delayMs = typeof c.params.delayMs === 'number' ? c.params.delayMs : 1000;
          const elapsed = state.timeDelayElapsedMs[c.id] ?? 0;
          const actuated = elapsed >= delayMs;
          const isNO = c.params.normalState === 'NO';
          const openSupply = isNO ? !actuated : actuated;
          if (openSupply) {
            drivePos(c.id, '2', readPos(c.id, '1'));
          } else if (isNetExhaust(c.id, '3')) {
            markExhaust(c.id, '2');
          }
        } else if (c.type === 'pressure_sequence_valve') {
          const threshold = typeof c.params.thresholdBar === 'number' ? c.params.thresholdBar : 4.0;
          const pPilot = readPos(c.id, '12');
          if (pPilot >= threshold) {
            drivePos(c.id, '2', readPos(c.id, '1'));
          } else if (isNetExhaust(c.id, '3')) {
            markExhaust(c.id, '2');
          }
        } else if (c.type === 'valve_2_2') {
          const vs = state.valves[c.id];
          const isNO = c.params.normalState === 'NO' || c.params.normallyOpen === true;
          const actuated = vs?.state === 'left';
          const open = isNO ? !actuated : actuated;
          if (open) {
            const p1 = readPos(c.id, '1');
            const p2 = readPos(c.id, '2');
            if (p1 > p2) drivePos(c.id, '2', p1);
            else if (p2 > p1) drivePos(c.id, '1', p2);
            const v1 = readVac(c.id, '1');
            const v2 = readVac(c.id, '2');
            if (v1 < v2) driveVac(c.id, '2', v1);
            else if (v2 < v1) driveVac(c.id, '1', v2);
            if (isNetExhaust(c.id, '1')) markExhaust(c.id, '2');
            if (isNetExhaust(c.id, '2')) markExhaust(c.id, '1');
          }
        } else if (c.type === 'valve_3_2') {
          const vs = state.valves[c.id];
          const isNO = c.params.normalState === 'NO' || c.params.normallyOpen === true;
          const actuated = vs?.state === 'left';
          const supplyToOut = isNO ? !actuated : actuated;
          if (supplyToOut) {
            drivePos(c.id, '2', readPos(c.id, '1'));
          } else if (isNetExhaust(c.id, '3')) {
            markExhaust(c.id, '2');
          }
        } else if (c.type === 'valve_4_2') {
          const vs = state.valves[c.id];
          const p1 = readPos(c.id, '1');
          const ex3 = isNetExhaust(c.id, '3');
          if (vs?.state === 'left') {
            drivePos(c.id, '4', p1);
            if (ex3) markExhaust(c.id, '2');
          } else {
            drivePos(c.id, '2', p1);
            if (ex3) markExhaust(c.id, '4');
          }
        } else if (c.type === 'valve_5_2') {
          const vs = state.valves[c.id];
          const p1 = readPos(c.id, '1');
          const ex3 = isNetExhaust(c.id, '3');
          const ex5 = isNetExhaust(c.id, '5');
          if (vs?.state === 'left') {
            drivePos(c.id, '4', p1);
            if (ex3) markExhaust(c.id, '2');
          } else {
            drivePos(c.id, '2', p1);
            if (ex5) markExhaust(c.id, '4');
          }
        } else if (c.type === 'valve_5_3') {
          const vs = state.valves[c.id];
          const p1 = readPos(c.id, '1');
          const ex3 = isNetExhaust(c.id, '3');
          const ex5 = isNetExhaust(c.id, '5');
          if (vs?.state === 'left') {
            drivePos(c.id, '4', p1);
            if (ex3) markExhaust(c.id, '2');
          } else if (vs?.state === 'right') {
            drivePos(c.id, '2', p1);
            if (ex5) markExhaust(c.id, '4');
          } else {
            const center = c.params.centerType ?? 'closed';
            if (center === 'exhausted') {
              if (ex3) markExhaust(c.id, '2');
              if (ex5) markExhaust(c.id, '4');
            } else if (center === 'pressurized') {
              drivePos(c.id, '2', p1);
              drivePos(c.id, '4', p1);
            }
          }
        }
      }

      if (!updated) break;
    }

    // Write resolved signed pressures back to portPressures map
    for (const [root, info] of netsByRoot.entries()) {
      const pos = netPosPressure.get(root) ?? 0;
      const vac = netVacPressure.get(root) ?? 0;
      const exh = netExhaustConnected.get(root) === true;
      const p = pos > 0.01 ? pos : exh ? 0 : vac < -0.01 ? vac : 0;
      for (const mk of info.members) {
        state.portPressures[mk] = p;
      }
    }

    // Touch readNetSigned to satisfy unused checks if needed
    void readNetSigned;
  }

  // Emit valve switch events & opposing-pilot diagnostics (on rising edge of opposing condition)
  for (const c of doc.components) {
    const vs = state.valves[c.id];
    if (!vs) continue;

    if (prevValveStates[c.id] !== vs.state) {
      events.push({
        kind: 'valve_switched',
        componentId: c.id,
        label: vs.label,
        detail: `${vs.label} switched ${prevValveStates[c.id]} -> ${vs.state}`,
      });
    }

    const isOpposingNow = opposingFlagThisTick.get(c.id) === true;
    if (isOpposingNow && !vs.opposingPilotActive) {
      vs.opposingPilotActive = true;
      const detailStr =
        c.leftActuation?.type === 'solenoid' || c.rightActuation?.type === 'solenoid'
          ? `both solenoids (${c.leftActuation?.label ?? 'L'} & ${c.rightActuation?.label ?? 'R'}) energized simultaneously`
          : `opposing pressure on ports 14 (${vs.pilotLeftBar.toFixed(1)} bar) and 12 (${vs.pilotRightBar.toFixed(1)} bar)`;
      diagnostics.push({
        severity: 'error',
        category: 'PneumaticRuleViolation',
        code: 'OPPOSING_PILOT_SIGNAL',
        tick,
        timeMs,
        message: `Valve ${c.id} (${vs.label}, ${c.type}) has ${detailStr} at t=${timeMs}ms.`,
        offendingIds: [c.id],
        suggestedFix:
          'Split the sequence into cascade groups (pneumatic-cascade) or use an electro-pneumatic step-chain so the opposing pilot is exhausted/de-energized before the next pilot triggers.',
      });
    } else if (!isOpposingNow) {
      vs.opposingPilotActive = false;
    }
  }

  // Update time-delay valves once per tick
  for (const c of doc.components) {
    if (c.type !== 'time_delay_valve') continue;
    const p12 = getPortP(c.id, '12');
    if (p12 >= PILOT_THRESHOLD_BAR) {
      state.timeDelayElapsedMs[c.id] = (state.timeDelayElapsedMs[c.id] ?? 0) + stepMs;
    } else {
      state.timeDelayElapsedMs[c.id] = 0;
    }
  }

  // Helper to compute effective throttle speed factor for a cylinder chamber
  const computeChamberFlowFactor = (
    cylId: string,
    cylPort: string,
    mode: 'fill' | 'exhaust',
  ): number => {
    const targetRoot = find(pKey(cylId, cylPort));
    let factor = 1.0;

    let quickExhaustBoost = false;
    for (const c of doc.components) {
      if (c.type === 'quick_exhaust_valve' && mode === 'exhaust') {
        const r2 = find(pKey(c.id, '2'));
        if (r2 === targetRoot && netExhaustConnected.get(find(pKey(c.id, '3'))) === true) {
          quickExhaustBoost = true;
        }
        continue;
      }
      if (c.type === 'throttle_valve') {
        const r1 = find(pKey(c.id, '1'));
        const r2 = find(pKey(c.id, '2'));
        if (r1 !== targetRoot && r2 !== targetRoot) continue;
        const openingPct = typeof c.params.openingPct === 'number' ? c.params.openingPct : 50;
        factor = Math.min(factor, Math.max(0.05, openingPct / 100));
        continue;
      }
      if (c.type !== 'flow_control_one_way') continue;
      const r1 = find(pKey(c.id, '1'));
      const r2 = find(pKey(c.id, '2'));
      if (r1 !== targetRoot && r2 !== targetRoot) continue;

      const openingPct = typeof c.params.openingPct === 'number' ? c.params.openingPct : 50;
      const freeDir = c.params.freeFlowDirection === '2_to_1' ? '2_to_1' : '1_to_2';
      const cylOnPort2 = r2 === targetRoot;
      const flowDir: '1_to_2' | '2_to_1' =
        (cylOnPort2 && mode === 'fill') || (!cylOnPort2 && mode === 'exhaust') ? '1_to_2' : '2_to_1';

      if (flowDir !== freeDir) {
        factor = Math.min(factor, Math.max(0.05, openingPct / 100));
      }
    }
    if (quickExhaustBoost) {
      factor = Math.max(factor, 1.35);
    }
    return factor;
  };

  // Update actuator kinematics, vacuum cups, gauges, and distance-rule / PEW sensor markers
  state.activeSensorLabels.clear();
  for (const key of Object.keys(state.sensorDirectionByLabel)) {
    delete state.sensorDirectionByLabel[key];
  }

  const dtSec = stepMs / 1000;
  const NOMINAL_MAX_SPEED_MM_S = 280; // ~357ms for 100mm stroke at 6 bar unrestricted
  const NOMINAL_MAX_SWIVEL_DEG_S = 360; // ~500ms for 180° swivel at 6 bar unrestricted

  for (const c of doc.components) {
    if (
      c.type !== 'cylinder_double_acting' &&
      c.type !== 'cylinder_single_acting' &&
      c.type !== 'cylinder_rodless' &&
      c.type !== 'swivel_drive'
    ) {
      continue;
    }
    const cs = state.cylinders[c.id];
    if (!cs) continue;

    const isSwivel = c.type === 'swivel_drive';
    const isRodless = c.type === 'cylinder_rodless';
    const boreMm = typeof c.params.pistonDiameterMm === 'number' ? c.params.pistonDiameterMm : 25;
    const rodMm = typeof c.params.rodDiameterMm === 'number' ? c.params.rodDiameterMm : 10;
    const extLoadN = typeof c.params.externalLoadN === 'number' ? c.params.externalLoadN : 0;

    const areaCapMm2 = Math.PI * (boreMm / 2) ** 2;
    const areaRodMm2 =
      isSwivel || isRodless ? areaCapMm2 : Math.max(10, areaCapMm2 - Math.PI * (rodMm / 2) ** 2);

    const pA = Math.max(0, getPortP(c.id, 'A'));
    const exhaustA = netExhaustConnected.get(find(pKey(c.id, 'A'))) === true;

    let netForceN = 0;
    let speedFactor = 1.0;
    let exhaustBlocked = false;

    if (c.type === 'cylinder_single_acting') {
      const springN = typeof c.params.springForceN === 'number' ? c.params.springForceN : 25;
      netForceN = pA * 0.1 * areaCapMm2 - springN - extLoadN;
      if (netForceN > 5) {
        speedFactor = computeChamberFlowFactor(c.id, 'A', 'fill');
      } else if (netForceN < -5) {
        if (!exhaustA && pA < 0.1) exhaustBlocked = true;
        speedFactor = computeChamberFlowFactor(c.id, 'A', 'exhaust');
      }
    } else {
      const pB = Math.max(0, getPortP(c.id, 'B'));
      const exhaustB = netExhaustConnected.get(find(pKey(c.id, 'B'))) === true;
      netForceN = pA * 0.1 * areaCapMm2 - pB * 0.1 * areaRodMm2 - extLoadN;

      if (netForceN > 5) {
        if (pB < 0.1 && !exhaustB) {
          exhaustBlocked = true;
        }
        const fFill = computeChamberFlowFactor(c.id, 'A', 'fill');
        const fExh = computeChamberFlowFactor(c.id, 'B', 'exhaust');
        speedFactor = Math.min(fFill, fExh);
      } else if (netForceN < -5) {
        if (pA < 0.1 && !exhaustA) {
          exhaustBlocked = true;
        }
        const fFill = computeChamberFlowFactor(c.id, 'B', 'fill');
        const fExh = computeChamberFlowFactor(c.id, 'A', 'exhaust');
        speedFactor = Math.min(fFill, fExh);
      }
    }

    let refForceN = Math.max(50, 6.0 * 0.1 * areaCapMm2);
    let speedScale = 1.0;
    if (c.type === 'cylinder_single_acting' && netForceN < 0) {
      const springN = typeof c.params.springForceN === 'number' ? c.params.springForceN : 25;
      refForceN = Math.max(15, springN);
      speedScale = 0.7;
    }

    let velocity = 0;
    const wantsExtend = netForceN > 5 && cs.positionMm < cs.strokeMm - 0.1;
    const wantsRetract = netForceN < -5 && cs.positionMm > 0.1;
    const blockedWhileMoving = exhaustBlocked && (wantsExtend || wantsRetract);

    if (blockedWhileMoving && !cs.exhaustBlockedReported) {
      cs.exhaustBlockedReported = true;
      diagnostics.push({
        severity: 'error',
        category: 'PneumaticRuleViolation',
        code: 'EXHAUST_BLOCKED',
        tick,
        timeMs,
        message: `Actuator ${c.id} (${cs.label}) cannot ${wantsExtend ? 'extend' : 'retract'} at t=${timeMs}ms because its exhausting chamber has no path to an exhaust_silencer.`,
        offendingIds: [c.id],
        suggestedFix:
          'Connect exhaust_silencer terminators to valve exhaust ports (3 / 5) and verify the directional valve opens an exhaust path.',
      });
    } else if (!blockedWhileMoving) {
      cs.exhaustBlockedReported = false;
    }

    const pBCheck = c.type === 'cylinder_single_acting' ? 0 : Math.max(0, getPortP(c.id, 'B'));
    const tryingExtend = pA >= 1.5 && pBCheck < 0.5 && cs.positionMm < cs.strokeMm - 0.1;
    const tryingRetract = pBCheck >= 1.5 && pA < 0.5 && cs.positionMm > 0.1;
    const stalledByLoad =
      extLoadN > 0 &&
      ((tryingExtend && netForceN <= 5) || (tryingRetract && netForceN >= -5));
    if (stalledByLoad && !cs.overloadStallReported) {
      cs.overloadStallReported = true;
      diagnostics.push({
        severity: 'error',
        category: 'PneumaticRuleViolation',
        code: 'ACTUATOR_STALLED_OVERLOAD',
        tick,
        timeMs,
        message: `Actuator ${c.id} (${cs.label}) stalled under externalLoadN=${extLoadN}N at t=${timeMs}ms (insufficient pneumatic force).`,
        offendingIds: [c.id],
        suggestedFix:
          'Increase cylinder pistonDiameterMm, raise air_source pressureBar, or reduce externalLoadN.',
      });
    } else if (!stalledByLoad) {
      cs.overloadStallReported = false;
    }

    if (!exhaustBlocked && Math.abs(netForceN) > 5) {
      const forceRatio = Math.min(1.5, Math.abs(netForceN) / refForceN);
      const maxSpeed = isSwivel ? NOMINAL_MAX_SWIVEL_DEG_S : NOMINAL_MAX_SPEED_MM_S;
      velocity = Math.sign(netForceN) * maxSpeed * speedScale * forceRatio * speedFactor;
    }

    if (velocity > 0 && cs.positionMm >= cs.strokeMm) velocity = 0;
    if (velocity < 0 && cs.positionMm <= 0) velocity = 0;

    const prevPos = cs.positionMm;
    const nextPos = Math.max(0, Math.min(cs.strokeMm, prevPos + velocity * dtSec));
    cs.positionMm = Number(nextPos.toFixed(3));
    cs.velocityMmPerS = Number(velocity.toFixed(2));
    const unitLabel = cs.unit;

    if (velocity > 1 && cs.lastMotionState !== 'extending') {
      cs.lastMotionState = 'extending';
      events.push({
        kind: 'cylinder_start_extend',
        componentId: c.id,
        label: cs.label,
        detail: `${isSwivel ? 'Swivel drive' : 'Cylinder'} ${cs.label} started ${isSwivel ? 'rotating +' : 'extending'} (${cs.positionMm.toFixed(1)}${unitLabel})`,
      });
    } else if (velocity < -1 && cs.lastMotionState !== 'retracting') {
      cs.lastMotionState = 'retracting';
      events.push({
        kind: 'cylinder_start_retract',
        componentId: c.id,
        label: cs.label,
        detail: `${isSwivel ? 'Swivel drive' : 'Cylinder'} ${cs.label} started ${isSwivel ? 'rotating -' : 'retracting'} (${cs.positionMm.toFixed(1)}${unitLabel})`,
      });
    } else if (Math.abs(velocity) <= 1) {
      cs.lastMotionState = 'idle';
    }

    if (prevPos < cs.strokeMm - 0.1 && cs.positionMm >= cs.strokeMm - 0.1 && cs.lastEndReached !== 'extended') {
      cs.lastEndReached = 'extended';
      events.push({
        kind: 'cylinder_extended',
        componentId: c.id,
        label: cs.label,
        detail: `${isSwivel ? 'Swivel drive' : 'Cylinder'} ${cs.label} reached 100% (${cs.strokeMm}${unitLabel})`,
        sequenceToken: `${cs.label}+`,
      });
    } else if (prevPos > 0.1 && cs.positionMm <= 0.1 && cs.lastEndReached !== 'retracted') {
      cs.lastEndReached = 'retracted';
      events.push({
        kind: 'cylinder_retracted',
        componentId: c.id,
        label: cs.label,
        detail: `${isSwivel ? 'Swivel drive' : 'Cylinder'} ${cs.label} reached 0% (0${unitLabel})`,
        sequenceToken: `${cs.label}-`,
      });
    }

    cs.activeMarkers = [];
    const motionDir: 'extending' | 'retracting' | 'idle' =
      velocity > 1 ? 'extending' : velocity < -1 ? 'retracting' : 'idle';
    for (const m of c.distanceRule ?? []) {
      const isEndStop = m.positionMm <= 0.001 || m.positionMm >= cs.strokeMm - 0.001;
      const tol = isEndStop ? 0.25 : (m.toleranceMm ?? 2);
      if (Math.abs(cs.positionMm - m.positionMm) <= tol) {
        cs.activeMarkers.push(m.label);
        state.activeSensorLabels.add(m.label);
        state.sensorDirectionByLabel[m.label] = motionDir;
      }
    }
  }

  // Evaluate vacuum suction cups, differential pressure/vacuum switches (PEW), and pressure gauges
  for (const c of doc.components) {
    if (c.type === 'vacuum_sucker') {
      const vs = state.vacuum[c.id];
      if (!vs) continue;
      const p1v = getPortP(c.id, '1v');
      const threshold = typeof c.params.gripThresholdBar === 'number' ? c.params.gripThresholdBar : -0.4;
      const grippedNow = p1v <= threshold;
      vs.pressureBar = Number(p1v.toFixed(2));
      if (grippedNow !== vs.gripped) {
        vs.gripped = grippedNow;
        events.push({
          kind: grippedNow ? 'vacuum_gripped' : 'vacuum_released',
          componentId: c.id,
          label: vs.label,
          detail: `Vacuum cup ${vs.label} ${grippedNow ? 'gripped workpiece' : 'released workpiece'} (${vs.pressureBar} bar)`,
        });
      }
    } else if (c.type === 'pressure_switch_differential') {
      const ps = state.pressureSwitches[c.id];
      if (!ps) continue;
      const p1 = getPortP(c.id, 'P1') || getPortP(c.id, '1');
      const p2 = getPortP(c.id, 'P2') || getPortP(c.id, '2');
      const diff = p1 - p2;
      const setP = typeof c.params.pressureBar === 'number' ? c.params.pressureBar : -0.5;
      const trigMode =
        c.params.triggerMode === 'above' || c.params.triggerMode === 'below'
          ? c.params.triggerMode
          : setP < 0
            ? 'below'
            : 'above';
      const triggered = trigMode === 'below' ? diff <= setP : diff >= setP;
      ps.pressureBar = Number(diff.toFixed(2));
      ps.thresholdBar = setP;
      ps.triggered = triggered;
      if (triggered && c.label) {
        state.activeSensorLabels.add(c.label);
        state.sensorDirectionByLabel[c.label] = 'idle';
      }
    } else if (c.type === 'pressure_gauge') {
      const g = state.gauges[c.id];
      if (!g) continue;
      g.pressureBar = Number(getPortP(c.id, '1').toFixed(2));
    }
  }

  return { diagnostics, events };
}
