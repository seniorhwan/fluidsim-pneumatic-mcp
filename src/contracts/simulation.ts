/**
 * Deterministic headless coupled simulation and sequence verification contracts.
 */

import type { FailureCategory } from './errors';

export type InputAction = 'press' | 'release' | 'toggle' | 'hold';

export interface SimInputEvent {
  /** Component label (e.g., "S1", "ESTOP", "-1M1") or component ID. */
  label: string;
  action: InputAction;
  /** Timestamp in milliseconds when input action begins. */
  atMs: number;
  /** Optional duration for 'press' (auto-releases at atMs + durationMs). */
  durationMs?: number;
}

export interface SimOptions {
  durationMs?: number;
  stepMs?: number;
  inputs?: SimInputEvent[];
  /** Include periodic sampled snapshots in addition to event timeline (default false to save tokens). */
  includeSamples?: boolean;
  sampleIntervalMs?: number;
  /** Supply pressure override in bar (default 6.0). */
  supplyPressureBar?: number;
}

export interface SimEventRecord {
  tick: number;
  timeMs: number;
  kind:
    | 'input'
    | 'cylinder_start_extend'
    | 'cylinder_extended'
    | 'cylinder_start_retract'
    | 'cylinder_retracted'
    | 'sensor_triggered'
    | 'valve_switched'
    | 'relay_energized'
    | 'relay_deenergized'
    | 'solenoid_energized'
    | 'solenoid_deenergized'
    | 'vacuum_gripped'
    | 'vacuum_released'
    | 'diagnostic';
  componentId: string;
  label?: string;
  detail: string;
}

export interface SimSample {
  tick: number;
  timeMs: number;
  cylinders: Record<string, { positionMm: number; pct: number; velocityMmPerS: number }>;
  valves: Record<string, { state: 'left' | 'center' | 'right' }>;
  relays: Record<string, boolean>;
  solenoids: Record<string, boolean>;
}

export interface SimDiagnostic {
  severity: 'error' | 'warning';
  category: FailureCategory;
  code: string;
  tick: number;
  timeMs: number;
  message: string;
  offendingIds: string[];
  suggestedFix: string;
}

export interface SimFinalState {
  cylinders: Record<
    string,
    {
      label: string;
      positionMm: number;
      strokeMm: number;
      pct: number;
      activeMarkers: string[];
      unit?: 'mm' | 'deg';
    }
  >;
  valves: Record<
    string,
    {
      label: string;
      state: 'left' | 'center' | 'right';
      pilotLeftBar: number;
      pilotRightBar: number;
    }
  >;
  relays: Record<string, { label: string; energized: boolean }>;
  solenoids: Record<string, { label: string; energized: boolean }>;
  lamps: Record<string, { label: string; lit: boolean }>;
  vacuum?: Record<string, { label: string; pressureBar: number; gripped?: boolean }>;
  pressureSwitches?: Record<string, { label: string; active: boolean; diffBar: number; thresholdBar: number }>;
  gauges?: Record<string, { label: string; pressureBar: number }>;
}

export interface SimResult {
  completed: boolean;
  durationMs: number;
  stepMs: number;
  totalTicks: number;
  observedSequence: string[];
  events: SimEventRecord[];
  samples?: SimSample[];
  diagnostics: SimDiagnostic[];
  finalState: SimFinalState;
}

export interface SequenceAssertion {
  expectedSequence: string[];
  inputs: SimInputEvent[];
  durationMs?: number;
  stepMs?: number;
  /** Optional maximum cycle completion time in ms. */
  maxCycleMs?: number;
  /** When true, accepts repeating copies of expectedSequence (for continuous startMode). */
  allowRepeatCycles?: boolean;
  /** Minimum full cycles required when allowRepeatCycles is true (default 1). */
  minCycles?: number;
  /** Optional E-stop verification check mid-cycle. */
  eStopCheck?: {
    label: string;
    triggerAtMs: number;
    expectNoFurtherMotionsAfterMs?: number;
  };
}

export interface SequenceVerificationResult {
  passed: boolean;
  expectedSequence: string[];
  observedSequence: string[];
  mismatchIndex: number | null;
  cycleTimeMs: number | null;
  cyclesObserved?: number;
  diagnostics: SimDiagnostic[];
  failureSummary?: string;
  eStopVerified?: boolean;
}

export interface StaticValidationFinding {
  severity: 'error' | 'warning';
  category: FailureCategory;
  code: string;
  message: string;
  offendingIds: string[];
  suggestedFix: string;
}

export interface StaticValidationReport {
  valid: boolean;
  errorCount: number;
  warningCount: number;
  findings: StaticValidationFinding[];
}

export interface StaticValidationOptions {
  /** When true, solenoid-labeled valves validate without requiring electrical valve_solenoid coils on the same sheet. */
  allowExternalElectricalSheet?: boolean;
}
