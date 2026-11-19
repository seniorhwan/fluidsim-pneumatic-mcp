/**
 * Semantic Intermediate Representation (IR) for FluidSIM Pneumatics 4.5 circuits.
 * Agents interact exclusively with semantic topology; geometry is managed by layoutRouter.
 */

import type { ValveActuationType } from './catalog';

export interface Point2D {
  x: number;
  y: number;
}

export interface DistanceRuleMarker {
  /** Sensor label (e.g., "a0", "a1", "b0", "b1"). */
  label: string;
  /** Position along stroke in mm (0 .. strokeMm). */
  positionMm: number;
  /** Optional detection window width in mm (default 2mm). */
  toleranceMm?: number;
}

export interface ValveActuationSide {
  type: ValveActuationType;
  /** Label binding for solenoid (e.g., "Y1"), roller/limit switch (e.g., "a0"), or pushbutton (e.g., "S1"). */
  label?: string;
}

export interface ComponentLayout {
  x: number;
  y: number;
  rotationDeg?: 0 | 90 | 180 | 270;
  flipped?: boolean;
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
  /** Cylinder distance-rule sensor markers (for actuators). */
  distanceRule?: DistanceRuleMarker[];
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
  /** Auto-routed orthogonal polyline waypoints in FluidSIM grid coordinates. */
  waypoints?: Point2D[];
  /** Lossless preservation bucket for raw .ct wire/hose properties. */
  rawMetadata?: Record<string, unknown>;
}

export interface CircuitMetadata {
  title: string;
  fluidsimVersion: '4.5';
  format: 'fsim-ir-json' | 'fluidsim-4.5-ct';
  sheetWidthMm: number;
  sheetHeightMm: number;
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
  schemaVersion: '1.0';
  metadata: CircuitMetadata;
  components: ComponentNode[];
  connections: ConnectionEdge[];
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
      /** If true, also removes attached edges (default true). */
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
    };
