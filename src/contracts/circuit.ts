/**
 * Semantic Net-Based Intermediate Representation (IR v2) for FluidSIM Pneumatics 4.5 circuits.
 * Agents interact exclusively with semantic topology, named nets, inline port terminators,
 * and D4 orientations (rotationDeg + mirror); geometry is managed by layoutRouter & ctWireRouter.
 */

import type { ValveActuationType } from './catalog';

export type SheetSizePreset = 'DIN_A4_LANDSCAPE' | 'DIN_A3_LANDSCAPE' | 'DIN_A4_PORTRAIT';

export type SheetDomain = 'electro-pneumatic' | 'pneumatic-only' | 'electrical-only';

/** Full D4 reflection states matching FluidSIM 4.5 FLIPPED ∈ {0, 1, 2, 3}. */
export type MirrorMode = 'none' | 'horizontal' | 'vertical' | 'both';

/** FluidSIM 4.5 numeric FLIPPED code: 0=none, 1=horizontal, 2=vertical, 3=both (H+V). */
export type FluidSimFlippedCode = 0 | 1 | 2 | 3;

/** Inline pneumatic port terminator mapped directly to FluidSIM PConnection ex_type (EX3 / EX4). */
export type PortTerminatorType = 'exhaust_silencer' | 'blind_plug';

export function getSheetDimensions(preset: SheetSizePreset = 'DIN_A4_LANDSCAPE'): {
  sheetWidthMm: number;
  sheetHeightMm: number;
} {
  switch (preset) {
    case 'DIN_A3_LANDSCAPE':
      return { sheetWidthMm: 420, sheetHeightMm: 297 };
    case 'DIN_A4_PORTRAIT':
      return { sheetWidthMm: 210, sheetHeightMm: 297 };
    case 'DIN_A4_LANDSCAPE':
    default:
      return { sheetWidthMm: 297, sheetHeightMm: 210 };
  }
}

export interface Point2D {
  x: number;
  y: number;
}

export interface DistanceRuleMarker {
  /** Sensor label (e.g., "a0", "a1", "b0", "b1", "-3S1", "-3S2"). */
  label: string;
  /** Position along linear stroke (mm) or rotary swivel angle (deg). */
  positionMm: number;
  /** Optional detection window width in mm/deg (default 2). */
  toleranceMm?: number;
}

export interface ValveActuationSide {
  type: ValveActuationType;
  /** Label binding for solenoid (e.g., "Y1", "-1M1"), roller/limit switch (e.g., "a0"), or pushbutton (e.g., "S1"). */
  label?: string;
  /** Composite manual override operator (e.g. solenoid + manual override). */
  manualOverride?: boolean;
  /** Composite internal pneumatic pilot assist (e.g. solenoid + internal pilot). */
  internalPilot?: boolean;
  /** Composite mechanical spring combined with pneumatic_spring return. */
  springReturn?: boolean;
}

export interface ComponentLayout {
  x: number;
  y: number;
  rotationDeg?: 0 | 90 | 180 | 270;
  /** Legacy boolean or full FluidSIM 4.5 FLIPPED code (0..3). */
  flipped?: boolean | FluidSimFlippedCode;
  mirror?: MirrorMode;
}

export interface ComponentNode {
  /** Unique stable ID within the circuit (e.g., "CYL_A", "V1", "K1"). */
  id: string;
  /** Canonical catalog type (e.g., "cylinder_double_acting", "valve_5_2"). */
  type: string;
  /** Engineering designation / binding label (e.g., "A", "Y1", "K1", "S1", "a1"). */
  label?: string;
  /** Component-specific parameters validated against catalog. */
  params: Record<string, number | string | boolean>;
  /** Valve actuation configuration (for directional_valve components). */
  leftActuation?: ValveActuationSide;
  rightActuation?: ValveActuationSide;
  /** Actuator distance-rule sensor markers (linear mm or swivel deg). */
  distanceRule?: DistanceRuleMarker[];
  /** Semantic component CCW rotation (0 | 90 | 180 | 270 deg), synced with layout.rotationDeg. */
  rotationDeg?: 0 | 90 | 180 | 270;
  /** Semantic D4 mirror reflection ('none' | 'horizontal' | 'vertical' | 'both') mapped to FluidSIM FLIPPED 0..3. */
  mirror?: MirrorMode;
  /** Optional legacy/numeric mirror alias synced with mirror. */
  flipped?: boolean | FluidSimFlippedCode;
  /** Optional logical station/branch grouping hint (e.g. "branch_1", "magazine", "vacuum"). */
  group?: string;
  /** Optional schematic section banner rendered cleanly above this branch/station column. */
  sectionLabel?: string;
  /** Inline pneumatic port terminators (e.g. { "3": "exhaust_silencer", "5": "exhaust_silencer", "12": "blind_plug" }). */
  portTerminators?: Record<string, PortTerminatorType>;
  /** Computed or preserved 2D placement (auto-populated by layoutRouter). */
  layout?: ComponentLayout;
  /** Lossless preservation bucket for raw FluidSIM 4.5 .ct attributes. */
  rawMetadata?: Record<string, unknown>;
}

export interface PortRef {
  componentId: string;
  port: string;
}

export interface ConnectionEdge {
  id: string;
  from: PortRef;
  to: PortRef;
  domain: 'pneumatic' | 'electrical';
  /** Auto-routed orthogonal polyline waypoints in mm (unified with FluidSIM .ct L segments). */
  waypoints?: Point2D[];
  /** Optional owning named net ID when expanded from CircuitNet. */
  netId?: string;
  /** Lossless preservation bucket for raw .ct wire/hose properties. */
  rawMetadata?: Record<string, unknown>;
}

/**
 * First-class named shared net (IR v2).
 * Automatically lowered into 3-gate PTriconnection / ETriconnection T-junction trees by topologyNormalizer.
 */
export interface CircuitNet {
  id: string;
  name?: string;
  domain: 'pneumatic' | 'electrical';
  endpoints: PortRef[];
  /** Optional inline net terminators (e.g. exhaust silencer or blind plug on a shared exhaust/supply bus). */
  terminators?: PortTerminatorType[];
}

export interface CircuitMetadata {
  title: string;
  fluidsimVersion: '4.5';
  format: 'fsim-ir-json' | 'fluidsim-4.5-ct';
  sheetWidthMm: number;
  sheetHeightMm: number;
  sheetSize?: SheetSizePreset;
  sheetDomain?: SheetDomain;
  /** When true, solenoid-labeled valves validate without requiring electrical valve_solenoid coils on the same sheet. */
  allowExternalElectricalSheet?: boolean;
  createdAt?: string;
  updatedAt?: string;
  notes?: string;
}

export interface RawAstPreservation {
  /** Original raw file encoding (e.g., "latin1", "utf8", "binary"). */
  encoding?: string;
  /** Preserved opaque raw header/footer/sections for 100% lossless .ct roundtrips. */
  preservedSections?: Record<string, unknown>;
}

export interface CircuitDocument {
  schemaVersion: '1.0' | '2.0';
  metadata: CircuitMetadata;
  components: ComponentNode[];
  connections: ConnectionEdge[];
  /** Optional first-class named shared nets (IR v2). */
  nets?: CircuitNet[];
  rawAst?: RawAstPreservation;
}

export type CircuitPatchOp =
  | {
      op: 'add_component';
      component: ComponentNode;
    }
  | {
      op: 'update_component';
      id: string;
      patch: Partial<Omit<ComponentNode, 'id' | 'type'>>;
    }
  | {
      op: 'remove_component';
      id: string;
      /** If true, also removes attached edges/net memberships (default true). */
      removeConnectedEdges?: boolean;
    }
  | {
      op: 'connect';
      id?: string;
      from: PortRef;
      to: PortRef;
    }
  | {
      op: 'disconnect';
      edgeId?: string;
      from?: PortRef;
      to?: PortRef;
    }
  | {
      op: 'set_distance_rule';
      componentId: string;
      markers: DistanceRuleMarker[];
    }
  | {
      op: 'set_label';
      componentId: string;
      label: string;
      side?: 'component' | 'leftActuation' | 'rightActuation';
    }
  | {
      op: 'set_port_terminator';
      componentId: string;
      port: string;
      terminator: PortTerminatorType | 'none';
    }
  | {
      op: 'set_net';
      net: CircuitNet;
    }
  | {
      op: 'remove_net';
      netId: string;
    };
