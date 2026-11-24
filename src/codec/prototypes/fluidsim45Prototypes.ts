/**
 * Official FluidSIM Pneumatics 4.5 Component Prototype Registry (Single Source of Truth).
 *
 * Canonical rot=0, mirror="none" (FLIPPED=0) component prototypes verified against
 * Festo FluidSIM 4.5 `sym/pneu/*.ct`, `sym/electr/*.ct`, and the 6 golden `.ct` fixtures.
 *
 * Both `src/catalog/pneumatics45.ts`, `src/authoring/layoutRouter.ts`,
 * `src/codec/ctTextCodec.ts`, and `src/codec/ctSvgRenderer.ts` derive exact dimensions,
 * port offsets, outward port exit normals, solver properties, and SYM geometry directly
 * from this registry.
 */

import type { PortDomain, PortNormal, PortRole } from '../../contracts/catalog';
import { FS_UNIT_PER_MM, type SymPrimitive } from '../ctTransform';

export interface PrototypeGateDef {
  /** 1-based FluidSIM gate index (gate1, gate2, ...). */
  gateIndex: number;
  /** Semantic port name (ISO 1219 / IEC) or undefined for internal valve pilot/actuation pins. */
  portName?: string;
  connClass: 'PConnection' | 'EConnection' | 'UEConnection' | 'UMConnection';
  domain: PortDomain;
  role: PortRole;
  required: boolean;
  /** Canonical port anchor offset in mm at rot=0, FLIPPED=0. */
  offsetMm: { x: number; y: number };
  /** Outward port exit normal at rot=0, FLIPPED=0. */
  normal: PortNormal;
}

export interface FluidSim45Prototype {
  /** Canonical MCP catalog type (e.g. "dual_pressure_valve_and"). */
  catalogType: string;
  /** Official FluidSIM 4.5 class ID (e.g. "PVS1", "CheckValvePilotOperatedSpringLoadedP"). */
  fluidsimClass: string;
  /** Source sym/ prototype path in Festo FluidSIM 4.5 installation (for provenance). */
  symSource: string;
  verified: boolean;
  /** Canonical bounding box at rot=0, FLIPPED=0 in mm. */
  sizeMm: { width: number; height: number };
  /** Native FluidSIM GDI rendering flag word. */
  gdiFlags: number;
  /** True when the FluidSIM class renders vector geometry via `S dxf_prim_list V <idx>`. */
  usesDxfSym: boolean;
  /** Optional secondary `dxf_prim_list2` (e.g. piston rod on CylDGPPAB or moving check element). */
  usesDxfSym2?: boolean;
  /** Ordered gates matching FluidSIM 4.5 `gate1..gateN`. */
  gates: readonly PrototypeGateDef[];
  /** Mandatory default FluidSIM 4.5 solver properties emitted on the object block. */
  defaultSolverProps: readonly string[];
  /** Canonical rot=0, FLIPPED=0 ISO 1219 / IEC vector primitives (mm). */
  symPrimitives: readonly SymPrimitive[];
  /** Optional secondary moving-element vector primitives (mm). */
  symPrimitives2?: readonly SymPrimitive[];
}

export function mmToRawUnits(mm: number): number {
  return Math.round(mm * FS_UNIT_PER_MM);
}

/**
 * Helper for standard horizontal 2-port inline pneumatic components (port 1 on left W, port 2 on right E).
 */
function twoPortInlineGates(w: number, h: number): PrototypeGateDef[] {
  const midY = Math.round((h / 2) * 100) / 100;
  return [
    { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: midY }, normal: 'W' },
    { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: w, y: midY }, normal: 'E' },
  ];
}

/**
 * Helper for standard vertical 2-port electrical components (top N, bottom S).
 */
function twoPortElecGates(
  p1: string,
  r1: PortRole,
  p2: string,
  r2: PortRole,
  w: number,
  h: number,
): PrototypeGateDef[] {
  const cx = Math.round((w / 2) * 100) / 100;
  return [
    { gateIndex: 1, portName: p1, connClass: 'EConnection', domain: 'electrical', role: r1, required: true, offsetMm: { x: cx, y: 0 }, normal: 'N' },
    { gateIndex: 2, portName: p2, connClass: 'EConnection', domain: 'electrical', role: r2, required: true, offsetMm: { x: cx, y: h }, normal: 'S' },
  ];
}

export const FLUIDSIM45_PROTOTYPES: Readonly<Record<string, FluidSim45Prototype>> = {
  // =========================================================================
  // 1. AIR SUPPLY, CONDITIONING & DISTRIBUTION
  // =========================================================================
  air_source: {
    catalogType: 'air_source',
    fluidsimClass: 'PPE1',
    symSource: 'sym/pneu/psup/psup1.ct',
    verified: true,
    sizeMm: { width: 6, height: 6 },
    gdiFlags: 204803,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 3, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 6',
      ' S MAX_FLOW_FEST B T',
      ' S MAX_FLOW F 1000',
    ],
    symPrimitives: [
      { kind: 'poly', points: [{ x: 3, y: 0.5 }, { x: 0.5, y: 5.5 }, { x: 5.5, y: 5.5 }] },
      { kind: 'circle', cx: 3, cy: 3.8, r: 0.6, fill: true },
    ],
  },

  air_service_unit: {
    catalogType: 'air_service_unit',
    fluidsimClass: 'Wartungseinheit2',
    symSource: 'sym/pneu/psup/psup7.ct',
    verified: true,
    sizeMm: { width: 40, height: 22 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 0, y: 11 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 40, y: 11 }, normal: 'E' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 6',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 1000',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 4, x2: 38, y2: 18 },
      { kind: 'line', x1: 0, y1: 11, x2: 3, y2: 11 },
      { kind: 'line', x1: 37, y1: 11, x2: 40, y2: 11 },
      // Filter diamond
      { kind: 'poly', points: [{ x: 9, y: 5 }, { x: 14, y: 11 }, { x: 9, y: 17 }, { x: 4, y: 11 }] },
      { kind: 'line', x1: 9, y1: 7, x2: 9, y2: 15, style: 2 },
      // Regulator box + gauge
      { kind: 'rect', x1: 17, y1: 7, x2: 25, y2: 15 },
      { kind: 'circle', cx: 21, cy: 3, r: 2.5 },
      { kind: 'line', x1: 21, y1: 5.5, x2: 21, y2: 7 },
      // Lubricator
      { kind: 'line', x1: 29, y1: 6, x2: 29, y2: 16 },
      { kind: 'line', x1: 33, y1: 6, x2: 33, y2: 11 },
    ],
  },

  air_filter: {
    catalogType: 'air_filter',
    fluidsimClass: 'FilterP',
    symSource: 'sym/pneu/psup/psup4.ct',
    verified: true,
    sizeMm: { width: 8, height: 8 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: twoPortInlineGates(8, 8),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 500',
    ],
    symPrimitives: [
      { kind: 'poly', points: [{ x: 4, y: 0.5 }, { x: 7.5, y: 4 }, { x: 4, y: 7.5 }, { x: 0.5, y: 4 }] },
      { kind: 'line', x1: 4, y1: 1.5, x2: 4, y2: 6.5, style: 2 },
    ],
  },

  air_reservoir: {
    catalogType: 'air_reservoir',
    fluidsimClass: 'AccPneu1',
    symSource: 'sym/pneu/psup/pacc1.ct',
    verified: true,
    sizeMm: { width: 16, height: 10 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 5 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 16, y: 5 }, normal: 'E' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S VOLUME_FEST B T',
      ' S VOLUME F 1',
    ],
    symPrimitives: [
      { kind: 'line', x1: 4, y1: 1, x2: 12, y2: 1 },
      { kind: 'line', x1: 4, y1: 9, x2: 12, y2: 9 },
      { kind: 'arc', cx: 4, cy: 5, r: 4, startDeg: 90, endDeg: 270 },
      { kind: 'arc', cx: 12, cy: 5, r: 4, startDeg: 270, endDeg: 90 },
    ],
  },

  exhaust_silencer: {
    catalogType: 'exhaust_silencer',
    fluidsimClass: 'PConnection:EX3',
    symSource: 'inline:PConnection:EX3',
    verified: true,
    sizeMm: { width: 4, height: 4 },
    gdiFlags: 348163,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 2, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'poly', points: [{ x: 0.5, y: 0.5 }, { x: 3.5, y: 0.5 }, { x: 2, y: 3.5 }] },
    ],
  },

  blind_plug: {
    catalogType: 'blind_plug',
    fluidsimClass: 'PConnection:EX4',
    symSource: 'inline:PConnection:EX4',
    verified: true,
    sizeMm: { width: 4, height: 4 },
    gdiFlags: 348163,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 2, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'line', x1: 2, y1: 0, x2: 2, y2: 3 },
      { kind: 'line', x1: 0.5, y1: 3, x2: 3.5, y2: 3 },
    ],
  },

  pneumatic_junction: {
    catalogType: 'pneumatic_junction',
    fluidsimClass: 'PTriconnection',
    symSource: 'builtin:PTriconnection',
    verified: true,
    sizeMm: { width: 4, height: 4 },
    gdiFlags: 6553603,
    usesDxfSym: false,
    // Standard 3-gate T-junction (gate1..gate3); optional 4th cross port only emitted when explicitly wired.
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 2 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 4, y: 2 }, normal: 'E' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 2, y: 0 }, normal: 'N' },
      { gateIndex: 4, portName: '4', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 2, y: 4 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F con_descr1 x_offset I 0',
      ' F con_descr1 y_offset I 0',
      ' F con_descr2 x_offset I 0',
      ' F con_descr2 y_offset I 0',
      ' F con_descr3 x_offset I 0',
      ' F con_descr3 y_offset I 0',
    ],
    symPrimitives: [
      { kind: 'circle', cx: 2, cy: 2, r: 0.9, fill: true },
    ],
  },

  pneumatic_manifold: {
    catalogType: 'pneumatic_manifold',
    fluidsimClass: 'PTriconnection',
    symSource: 'builtin:PTriconnection:bus',
    verified: true,
    sizeMm: { width: 40, height: 4 },
    gdiFlags: 6553603,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 0, y: 2 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 6, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 12, y: 0 }, normal: 'N' },
      { gateIndex: 4, portName: '4', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 18, y: 0 }, normal: 'N' },
      { gateIndex: 5, portName: '5', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 24, y: 0 }, normal: 'N' },
      { gateIndex: 6, portName: '6', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 30, y: 0 }, normal: 'N' },
      { gateIndex: 7, portName: '7', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 36, y: 0 }, normal: 'N' },
      { gateIndex: 8, portName: '8', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: false, offsetMm: { x: 40, y: 2 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 2, x2: 40, y2: 2 },
    ],
  },

  // =========================================================================
  // 2. LINEAR & ROTARY ACTUATORS
  // =========================================================================
  cylinder_single_acting: {
    catalogType: 'cylinder_single_acting',
    fluidsimClass: 'CylDGPPAB',
    symSource: 'sym/pneu/act/a1.ct',
    verified: true,
    sizeMm: { width: 19, height: 11 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    usesDxfSym2: true,
    gates: [
      { gateIndex: 1, portName: 'A', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 2, y: 11 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' S description_FEST B T',
      ' S description S Zylinder, einfachwirkend',
      ' S piston S CP_CA',
      ' F enum UNKNOWN B T',
      ' S MoName_FEST B T',
      ' S MoName S Pneu.Actuator.CylinderSA_SR',
      ' S PISTON_COUNT I 1',
      ' S PISTON_R B T',
      ' S SPRING_R B T',
      ' S SENSING B T',
      ' S SLEDGE B F',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 0, y1: 1, x2: 19, y2: 9 },
      { kind: 'line', x1: 2, y1: 9, x2: 2, y2: 11 },
      // Return spring inside right chamber
      { kind: 'line', x1: 8, y1: 3, x2: 10, y2: 7 },
      { kind: 'line', x1: 10, y1: 7, x2: 12, y2: 3 },
      { kind: 'line', x1: 12, y1: 3, x2: 14, y2: 7 },
      { kind: 'line', x1: 14, y1: 7, x2: 16, y2: 3 },
    ],
    symPrimitives2: [
      { kind: 'rect', x1: 4, y1: 1.5, x2: 6.5, y2: 8.5, fill: true },
      { kind: 'rect', x1: 6.5, y1: 4.2, x2: 25, y2: 5.8 },
    ],
  },

  cylinder_double_acting: {
    catalogType: 'cylinder_double_acting',
    fluidsimClass: 'CylDGPPAB',
    symSource: 'sym/pneu/act/a2.ct',
    verified: true,
    sizeMm: { width: 19, height: 11 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    usesDxfSym2: true,
    gates: [
      { gateIndex: 1, portName: 'A', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 2, y: 11 }, normal: 'S' },
      { gateIndex: 2, portName: 'B', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 17, y: 11 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' S description_FEST B T',
      ' S description S Zylinder, doppeltwirkend',
      ' S piston S CP_CA',
      ' F enum UNKNOWN B T',
      ' S MoName_FEST B T',
      ' S MoName S Pneu.Actuator.CylinderDA',
      ' S PISTON_COUNT I 1',
      ' S PISTON_R B T',
      ' S SPRING_R B F',
      ' S SENSING B T',
      ' S SLEDGE B F',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 0, y1: 1, x2: 19, y2: 9 },
      { kind: 'line', x1: 2, y1: 9, x2: 2, y2: 11 },
      { kind: 'line', x1: 17, y1: 9, x2: 17, y2: 11 },
    ],
    symPrimitives2: [
      { kind: 'rect', x1: 4, y1: 1.5, x2: 6.5, y2: 8.5, fill: true },
      { kind: 'rect', x1: 6.5, y1: 4.2, x2: 25, y2: 5.8 },
    ],
  },

  cylinder_rodless: {
    catalogType: 'cylinder_rodless',
    fluidsimClass: 'CylDGPPAB',
    symSource: 'sym/pneu/fuact/a3.ct',
    verified: true,
    sizeMm: { width: 32, height: 12 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    usesDxfSym2: true,
    gates: [
      { gateIndex: 1, portName: 'A', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 3, y: 12 }, normal: 'S' },
      { gateIndex: 2, portName: 'B', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 29, y: 12 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' S description_FEST B T',
      ' S description S Kolbenstangenloser Zylinder',
      ' F enum UNKNOWN B T',
      ' S MoName_FEST B T',
      ' S MoName S Pneu.Actuator.CylinderDA',
      ' S PISTON_COUNT I 1',
      ' S PISTON_R B F',
      ' S SPRING_R B F',
      ' S SENSING B T',
      ' S SLEDGE B T',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 0, y1: 3, x2: 32, y2: 10 },
      { kind: 'line', x1: 3, y1: 10, x2: 3, y2: 12 },
      { kind: 'line', x1: 29, y1: 10, x2: 29, y2: 12 },
    ],
    symPrimitives2: [
      { kind: 'rect', x1: 5, y1: 3.5, x2: 9, y2: 9.5, fill: true },
      { kind: 'rect', x1: 4, y1: 0.5, x2: 10, y2: 3 },
    ],
  },

  swivel_drive: {
    catalogType: 'swivel_drive',
    fluidsimClass: 'PAR1b',
    symSource: 'sym/pneu/act/a6.ct',
    verified: true,
    sizeMm: { width: 10, height: 13 },
    gdiFlags: 4628483,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: 'A', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 2, y: 13 }, normal: 'S' },
      { gateIndex: 2, portName: 'B', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 8, y: 13 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S SENSING B T',
    ],
    symPrimitives: [
      { kind: 'circle', cx: 5, cy: 5.5, r: 4.5 },
      { kind: 'line', x1: 5, y1: 5.5, x2: 8.5, y2: 3 },
      { kind: 'arc', cx: 5, cy: 5.5, r: 3, startDeg: 20, endDeg: 160 },
      { kind: 'line', x1: 2, y1: 9.2, x2: 2, y2: 13 },
      { kind: 'line', x1: 8, y1: 9.2, x2: 8, y2: 13 },
    ],
  },

  air_motor: {
    catalogType: 'air_motor',
    fluidsimClass: 'PAR2',
    symSource: 'sym/pneu/act/a7.ct',
    verified: true,
    sizeMm: { width: 16, height: 16 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: 'A', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 4, y: 16 }, normal: 'S' },
      { gateIndex: 2, portName: 'B', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 12, y: 16 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
    ],
    symPrimitives: [
      { kind: 'circle', cx: 8, cy: 8, r: 6 },
      { kind: 'poly', points: [{ x: 8, y: 2.5 }, { x: 6.5, y: 5 }, { x: 9.5, y: 5 }], fill: true },
      { kind: 'line', x1: 4, y1: 12.8, x2: 4, y2: 16 },
      { kind: 'line', x1: 12, y1: 12.8, x2: 12, y2: 16 },
    ],
  },

  // =========================================================================
  // 3. DIRECTIONAL CONTROL VALVES (Compiled dynamically by ctValveCompiler.ts)
  // =========================================================================
  valve_2_2: {
    catalogType: 'valve_2_2',
    fluidsimClass: 'WV_2',
    symSource: 'sym/pneu/valv/cv2.ct',
    verified: true,
    sizeMm: { width: 28, height: 12 },
    gdiFlags: 1617923,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 14, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 14, y: 12 }, normal: 'S' },
      { gateIndex: 3, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 0, y: 8 }, normal: 'W' },
      { gateIndex: 4, portName: '10', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 28, y: 8 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 6, y1: 2, x2: 14, y2: 10 },
      { kind: 'rect', x1: 14, y1: 2, x2: 22, y2: 10 },
    ],
  },

  valve_3_2: {
    catalogType: 'valve_3_2',
    fluidsimClass: 'WV_3',
    symSource: 'sym/pneu/valv/cv3.ct',
    verified: true,
    sizeMm: { width: 28, height: 12 },
    gdiFlags: 1617923,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 12, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 12, y: 12 }, normal: 'S' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 18, y: 12 }, normal: 'S' },
      { gateIndex: 4, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 0, y: 8 }, normal: 'W' },
      { gateIndex: 5, portName: '10', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 28, y: 8 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 6, y1: 2, x2: 14, y2: 10 },
      { kind: 'rect', x1: 14, y1: 2, x2: 22, y2: 10 },
    ],
  },

  valve_4_2: {
    catalogType: 'valve_4_2',
    fluidsimClass: 'WV_4',
    symSource: 'sym/pneu/valv/cv4.ct',
    verified: true,
    sizeMm: { width: 32, height: 12 },
    gdiFlags: 3102723,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '4', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 12, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 20, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 12, y: 12 }, normal: 'S' },
      { gateIndex: 4, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 20, y: 12 }, normal: 'S' },
      { gateIndex: 5, portName: '14', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 0, y: 8 }, normal: 'W' },
      { gateIndex: 6, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 32, y: 8 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 8, y1: 2, x2: 16, y2: 10 },
      { kind: 'rect', x1: 16, y1: 2, x2: 24, y2: 10 },
    ],
  },

  valve_5_2: {
    catalogType: 'valve_5_2',
    fluidsimClass: 'WV_5',
    symSource: 'sym/pneu/valv/cv5.ct',
    verified: true,
    sizeMm: { width: 36, height: 12 },
    gdiFlags: 3102723,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '4', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 14, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 22, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '5', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 12, y: 12 }, normal: 'S' },
      { gateIndex: 4, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 18, y: 12 }, normal: 'S' },
      { gateIndex: 5, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 24, y: 12 }, normal: 'S' },
      { gateIndex: 6, portName: '14', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 0, y: 8 }, normal: 'W' },
      { gateIndex: 7, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 36, y: 8 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 10, y1: 2, x2: 18, y2: 10 },
      { kind: 'rect', x1: 18, y1: 2, x2: 26, y2: 10 },
    ],
  },

  valve_5_3: {
    catalogType: 'valve_5_3',
    fluidsimClass: 'WV_5',
    symSource: 'sym/pneu/valv/cv5_3.ct',
    verified: true,
    sizeMm: { width: 44, height: 12 },
    gdiFlags: 3102723,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '4', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 18, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 26, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '5', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 16, y: 12 }, normal: 'S' },
      { gateIndex: 4, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 22, y: 12 }, normal: 'S' },
      { gateIndex: 5, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 28, y: 12 }, normal: 'S' },
      { gateIndex: 6, portName: '14', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 0, y: 8 }, normal: 'W' },
      { gateIndex: 7, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 44, y: 8 }, normal: 'E' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 10, y1: 2, x2: 18, y2: 10 },
      { kind: 'rect', x1: 18, y1: 2, x2: 26, y2: 10 },
      { kind: 'rect', x1: 26, y1: 2, x2: 34, y2: 10 },
    ],
  },

  // =========================================================================
  // 4. FLOW, SHUT-OFF, LOGIC & PRESSURE VALVES (All Official sym/ Classes!)
  // =========================================================================
  flow_control_one_way: {
    catalogType: 'flow_control_one_way',
    fluidsimClass: 'DRSV2_pneu',
    symSource: 'sym/pneu/sfv/sf10.ct',
    verified: true,
    sizeMm: { width: 15, height: 20 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 3, y: 20 }, normal: 'S' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 3, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S LEVEL_FEST B T',
      ' S LEVEL F 50',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 100',
    ],
    symPrimitives: [
      // Main vertical line through throttle
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 20 },
      // Throttle arcs
      { kind: 'arc', cx: 0.5, cy: 10, r: 2.2, startDeg: 310, endDeg: 50 },
      { kind: 'arc', cx: 5.5, cy: 10, r: 2.2, startDeg: 130, endDeg: 230 },
      // Variable arrow
      { kind: 'line', x1: 0.5, y1: 13, x2: 6, y2: 7 },
      // Parallel bypass check valve on right
      { kind: 'line', x1: 3, y1: 3, x2: 11, y2: 3 },
      { kind: 'line', x1: 11, y1: 3, x2: 11, y2: 17 },
      { kind: 'line', x1: 3, y1: 17, x2: 11, y2: 17 },
      { kind: 'circle', cx: 11, cy: 10, r: 1.5 },
      { kind: 'line', x1: 9, y1: 11.5, x2: 11, y2: 8 },
      { kind: 'line', x1: 13, y1: 11.5, x2: 11, y2: 8 },
    ],
  },

  throttle_valve: {
    catalogType: 'throttle_valve',
    fluidsimClass: 'DV_P1',
    symSource: 'sym/pneu/sfv/sf9.ct',
    verified: true,
    sizeMm: { width: 14, height: 5 },
    gdiFlags: 6940243,
    usesDxfSym: true,
    gates: twoPortInlineGates(14, 5),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S LEVEL_FEST B T',
      ' S LEVEL F 50',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 100',
    ],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 2.5, x2: 14, y2: 2.5 },
      { kind: 'arc', cx: 7, cy: 0, r: 2.2, startDeg: 220, endDeg: 320 },
      { kind: 'arc', cx: 7, cy: 5, r: 2.2, startDeg: 40, endDeg: 140 },
      { kind: 'line', x1: 4.5, y1: 4.5, x2: 9.5, y2: 0.5 },
    ],
  },

  nozzle: {
    catalogType: 'nozzle',
    fluidsimClass: 'NozzleP',
    symSource: 'sym/pneu/sfv/pth1.ct',
    verified: true,
    sizeMm: { width: 14, height: 6 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: twoPortInlineGates(14, 6),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 40',
    ],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 3, x2: 14, y2: 3 },
      { kind: 'arc', cx: 7, cy: 0.2, r: 2.3, startDeg: 220, endDeg: 320 },
      { kind: 'arc', cx: 7, cy: 5.8, r: 2.3, startDeg: 40, endDeg: 140 },
    ],
  },

  orifice: {
    catalogType: 'orifice',
    fluidsimClass: 'NozzleP',
    symSource: 'sym/pneu/sfv/pth1.ct',
    verified: true,
    sizeMm: { width: 14, height: 6 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: twoPortInlineGates(14, 6),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 40',
    ],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 3, x2: 14, y2: 3 },
      { kind: 'line', x1: 6, y1: 0.5, x2: 6, y2: 2.2 },
      { kind: 'line', x1: 6, y1: 3.8, x2: 6, y2: 5.5 },
      { kind: 'line', x1: 8, y1: 0.5, x2: 8, y2: 2.2 },
      { kind: 'line', x1: 8, y1: 3.8, x2: 8, y2: 5.5 },
    ],
  },

  check_valve: {
    catalogType: 'check_valve',
    fluidsimClass: 'CheckValveP',
    symSource: 'sym/pneu/sfv/sf5a.ct',
    verified: true,
    sizeMm: { width: 12, height: 8 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: twoPortInlineGates(12, 8),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 300',
    ],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 4, x2: 4.5, y2: 4 },
      { kind: 'line', x1: 7.5, y1: 4, x2: 12, y2: 4 },
      { kind: 'circle', cx: 6, cy: 4, r: 1.5 },
      { kind: 'line', x1: 4, y1: 1.5, x2: 7.8, y2: 4 },
      { kind: 'line', x1: 4, y1: 6.5, x2: 7.8, y2: 4 },
    ],
  },

  check_valve_spring: {
    catalogType: 'check_valve_spring',
    fluidsimClass: 'CheckValveSpringLoadedP',
    symSource: 'sym/pneu/sfv/sf5b.ct',
    verified: true,
    sizeMm: { width: 14, height: 8 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: twoPortInlineGates(14, 8),
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 300',
    ],
    symPrimitives: [
      { kind: 'line', x1: 0, y1: 4, x2: 4, y2: 4 },
      { kind: 'line', x1: 10, y1: 4, x2: 14, y2: 4 },
      { kind: 'circle', cx: 5.5, cy: 4, r: 1.5 },
      { kind: 'line', x1: 3.5, y1: 1.5, x2: 7.2, y2: 4 },
      { kind: 'line', x1: 3.5, y1: 6.5, x2: 7.2, y2: 4 },
      // Spring zigzag
      { kind: 'line', x1: 7.2, y1: 4, x2: 8.2, y2: 2 },
      { kind: 'line', x1: 8.2, y1: 2, x2: 9.2, y2: 6 },
      { kind: 'line', x1: 9.2, y1: 6, x2: 10, y2: 4 },
    ],
  },

  check_valve_pilot_open: {
    catalogType: 'check_valve_pilot_open',
    fluidsimClass: 'CheckValvePilotOperatedSpringLoadedP',
    symSource: 'sym/pneu/sfv/sf5d.ct',
    verified: true,
    sizeMm: { width: 16, height: 10 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 4 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 16, y: 4 }, normal: 'E' },
      { gateIndex: 3, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: false, offsetMm: { x: 8, y: 10 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 300',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 0.5, x2: 14, y2: 7.5 },
      { kind: 'line', x1: 0, y1: 4, x2: 5, y2: 4 },
      { kind: 'line', x1: 11, y1: 4, x2: 16, y2: 4 },
      { kind: 'circle', cx: 6.5, cy: 4, r: 1.5 },
      { kind: 'line', x1: 4.5, y1: 1.8, x2: 8.2, y2: 4 },
      { kind: 'line', x1: 4.5, y1: 6.2, x2: 8.2, y2: 4 },
      // Pilot line from port 12 (bottom) unlocking the check ball
      { kind: 'line', x1: 8, y1: 10, x2: 8, y2: 5.5, style: 2 },
    ],
  },

  dual_pressure_valve_and: {
    catalogType: 'dual_pressure_valve_and',
    fluidsimClass: 'PVS1',
    symSource: 'sym/pneu/sfv/sf1.ct',
    verified: true,
    sizeMm: { width: 20, height: 12 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 6 }, normal: 'W' },
      { gateIndex: 2, portName: '1_2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 20, y: 6 }, normal: 'E' },
      { gateIndex: 3, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 10, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 300',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 2, x2: 17, y2: 10 },
      { kind: 'line', x1: 0, y1: 6, x2: 6, y2: 6 },
      { kind: 'line', x1: 14, y1: 6, x2: 20, y2: 6 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 6 },
      // H-spool AND valve symbol
      { kind: 'line', x1: 6, y1: 3.5, x2: 6, y2: 8.5 },
      { kind: 'line', x1: 14, y1: 3.5, x2: 14, y2: 8.5 },
      { kind: 'line', x1: 6, y1: 6, x2: 14, y2: 6 },
    ],
  },

  shuttle_valve_or: {
    catalogType: 'shuttle_valve_or',
    fluidsimClass: 'PVS3',
    symSource: 'sym/pneu/sfv/sf2.ct',
    verified: true,
    sizeMm: { width: 24, height: 12 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 6 }, normal: 'W' },
      { gateIndex: 2, portName: '1_2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 24, y: 6 }, normal: 'E' },
      { gateIndex: 3, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 12, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 300',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 2, x2: 21, y2: 10 },
      { kind: 'line', x1: 0, y1: 6, x2: 9, y2: 6 },
      { kind: 'line', x1: 15, y1: 6, x2: 24, y2: 6 },
      { kind: 'line', x1: 12, y1: 0, x2: 12, y2: 6 },
      { kind: 'circle', cx: 12, cy: 6, r: 2 },
    ],
  },

  quick_exhaust_valve: {
    catalogType: 'quick_exhaust_valve',
    fluidsimClass: 'PVS2',
    symSource: 'sym/pneu/sfv/sf3.ct',
    verified: true,
    sizeMm: { width: 24, height: 12 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 0, y: 6 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 12, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: false, offsetMm: { x: 12, y: 12 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 600',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 2, x2: 21, y2: 10 },
      { kind: 'line', x1: 0, y1: 6, x2: 10, y2: 6 },
      { kind: 'line', x1: 12, y1: 0, x2: 12, y2: 12 },
      { kind: 'poly', points: [{ x: 10, y: 4 }, { x: 14, y: 4 }, { x: 12, y: 8 }] },
    ],
  },

  time_delay_valve: {
    catalogType: 'time_delay_valve',
    fluidsimClass: 'TimerClosedP',
    symSource: 'sym/pneu/tvalv/t1p.ct',
    verified: true,
    sizeMm: { width: 28, height: 24 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 14, y: 24 }, normal: 'S' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 14, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: false, offsetMm: { x: 20, y: 24 }, normal: 'S' },
      { gateIndex: 4, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: true, offsetMm: { x: 0, y: 16 }, normal: 'W' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S NN_FLOW_FEST B T',
      ' S NN_FLOW F 100',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 1, y1: 1, x2: 27, y2: 23 },
      { kind: 'rect', x1: 9, y1: 4, x2: 23, y2: 12 },
      { kind: 'circle', cx: 6, cy: 17, r: 3 },
      { kind: 'line', x1: 0, y1: 16, x2: 3, y2: 16 },
    ],
  },

  pressure_regulator: {
    catalogType: 'pressure_regulator',
    fluidsimClass: 'PressureReducingValve3WaysAdjustableP',
    symSource: 'sym/pneu/pv/pv2.ct',
    verified: true,
    sizeMm: { width: 16, height: 14 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 0, y: 7 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 16, y: 7 }, normal: 'E' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 5',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 2, x2: 13, y2: 12 },
      { kind: 'line', x1: 0, y1: 7, x2: 16, y2: 7 },
      { kind: 'poly', points: [{ x: 11, y: 7 }, { x: 8.5, y: 5.5 }, { x: 8.5, y: 8.5 }], fill: true },
    ],
  },

  pressure_sequence_valve: {
    catalogType: 'pressure_sequence_valve',
    fluidsimClass: 'PressureSequenceValveP',
    symSource: 'sym/pneu/pv/pv3.ct',
    verified: true,
    sizeMm: { width: 18, height: 16 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 9, y: 16 }, normal: 'S' },
      { gateIndex: 2, portName: '2', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 9, y: 0 }, normal: 'N' },
      { gateIndex: 3, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: false, offsetMm: { x: 14, y: 16 }, normal: 'S' },
      { gateIndex: 4, portName: '12', connClass: 'PConnection', domain: 'pneumatic', role: 'pilot', required: true, offsetMm: { x: 0, y: 10 }, normal: 'W' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 4',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 2, x2: 15, y2: 14 },
      { kind: 'line', x1: 0, y1: 10, x2: 3, y2: 10 },
      { kind: 'line', x1: 9, y1: 0, x2: 9, y2: 16 },
    ],
  },

  pressure_relief_valve: {
    catalogType: 'pressure_relief_valve',
    fluidsimClass: 'PressureReliefValveP',
    symSource: 'sym/pneu/pv/pv1.ct',
    verified: true,
    sizeMm: { width: 14, height: 14 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'working', required: true, offsetMm: { x: 7, y: 14 }, normal: 'S' },
      { gateIndex: 2, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: true, offsetMm: { x: 7, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 6',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 2, x2: 12, y2: 12 },
      { kind: 'line', x1: 7, y1: 0, x2: 7, y2: 14 },
    ],
  },

  // =========================================================================
  // 5. VACUUM & MEASURING
  // =========================================================================
  vacuum_suction_nozzle: {
    catalogType: 'vacuum_suction_nozzle',
    fluidsimClass: 'PAV1',
    symSource: 'sym/pneu/vac/vac1.ct',
    verified: true,
    sizeMm: { width: 14, height: 12 },
    gdiFlags: 4495368,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'supply', required: true, offsetMm: { x: 0, y: 6 }, normal: 'W' },
      { gateIndex: 2, portName: '3', connClass: 'PConnection', domain: 'pneumatic', role: 'exhaust', required: false, offsetMm: { x: 14, y: 6 }, normal: 'E' },
      { gateIndex: 3, portName: '1v', connClass: 'PConnection', domain: 'pneumatic', role: 'vacuum', required: true, offsetMm: { x: 7, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 2, x2: 12, y2: 10 },
      { kind: 'line', x1: 0, y1: 6, x2: 14, y2: 6 },
      { kind: 'line', x1: 7, y1: 0, x2: 7, y2: 6 },
      { kind: 'poly', points: [{ x: 4, y: 4 }, { x: 7, y: 6 }, { x: 4, y: 8 }] },
      { kind: 'poly', points: [{ x: 10, y: 4 }, { x: 7, y: 6 }, { x: 10, y: 8 }] },
    ],
  },

  vacuum_sucker: {
    catalogType: 'vacuum_sucker',
    fluidsimClass: 'PAV1S',
    symSource: 'sym/pneu/vac/vac2.ct',
    verified: true,
    sizeMm: { width: 10, height: 10 },
    gdiFlags: 4894728,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1v', connClass: 'PConnection', domain: 'pneumatic', role: 'vacuum', required: true, offsetMm: { x: 5, y: 10 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
    ],
    symPrimitives: [
      { kind: 'line', x1: 5, y1: 4, x2: 5, y2: 10 },
      { kind: 'arc', cx: 5, cy: 1.5, r: 4, startDeg: 200, endDeg: 340 },
      { kind: 'line', x1: 1.5, y1: 3, x2: 8.5, y2: 3 },
    ],
  },

  pressure_switch_differential: {
    catalogType: 'pressure_switch_differential',
    fluidsimClass: 'PSW1',
    symSource: 'sym/pneu/meas/ps1.ct',
    verified: true,
    sizeMm: { width: 10, height: 10 },
    gdiFlags: 2938888,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: 'P1', connClass: 'PConnection', domain: 'pneumatic', role: 'signal', required: true, offsetMm: { x: 0, y: 5 }, normal: 'W' },
      { gateIndex: 2, portName: 'P2', connClass: 'PConnection', domain: 'pneumatic', role: 'signal', required: false, offsetMm: { x: 10, y: 5 }, normal: 'E' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 1.5, x2: 8, y2: 8.5 },
      { kind: 'line', x1: 0, y1: 5, x2: 2, y2: 5 },
      { kind: 'line', x1: 3.5, y1: 6.5, x2: 6.5, y2: 3.5 },
    ],
  },

  pressure_switch_pew: {
    catalogType: 'pressure_switch_pew',
    fluidsimClass: 'PEW',
    symSource: 'sym/pneu/meas/ps2.ct',
    verified: true,
    sizeMm: { width: 16, height: 12 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: 'P1', connClass: 'PConnection', domain: 'pneumatic', role: 'signal', required: true, offsetMm: { x: 0, y: 6 }, normal: 'W' },
      { gateIndex: 2, portName: 'P2', connClass: 'PConnection', domain: 'pneumatic', role: 'signal', required: false, offsetMm: { x: 16, y: 6 }, normal: 'E' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
      ' S PRESSURE_FEST B T',
      ' S PRESSURE F 3',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 3, y1: 1.5, x2: 13, y2: 10.5 },
      { kind: 'line', x1: 0, y1: 6, x2: 3, y2: 6 },
      { kind: 'line', x1: 13, y1: 6, x2: 16, y2: 6 },
      { kind: 'line', x1: 5, y1: 8, x2: 11, y2: 4 },
    ],
  },

  pressure_gauge: {
    catalogType: 'pressure_gauge',
    fluidsimClass: 'PressureIndicatorP',
    symSource: 'sym/pneu/meas/pmea4.ct',
    verified: true,
    sizeMm: { width: 10, height: 10 },
    gdiFlags: 2314243,
    usesDxfSym: true,
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'PConnection', domain: 'pneumatic', role: 'signal', required: true, offsetMm: { x: 5, y: 10 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F enum UNKNOWN B T',
    ],
    symPrimitives: [
      { kind: 'circle', cx: 5, cy: 4.5, r: 4 },
      { kind: 'line', x1: 5, y1: 4.5, x2: 7.5, y2: 2.5 },
      { kind: 'line', x1: 5, y1: 8.5, x2: 5, y2: 10 },
    ],
  },

  // =========================================================================
  // 6. ELECTRICAL 24V / 0V LADDER COMPONENTS
  // =========================================================================
  power_24v: {
    catalogType: 'power_24v',
    fluidsimClass: 'pol2',
    symSource: 'sym/electr/pol2.ct',
    verified: true,
    sizeMm: { width: 8, height: 6 },
    gdiFlags: 4126728,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: 'OUT', connClass: 'EConnection', domain: 'electrical', role: 'power_pos', required: true, offsetMm: { x: 4, y: 6 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' F con_descr1 x_offset I 0',
      ' F con_descr1 y_offset I 0',
    ],
    symPrimitives: [
      { kind: 'line', x1: 1, y1: 2, x2: 7, y2: 2 },
      { kind: 'line', x1: 4, y1: 2, x2: 4, y2: 6 },
    ],
  },

  power_0v: {
    catalogType: 'power_0v',
    fluidsimClass: 'pol1',
    symSource: 'sym/electr/pol1.ct',
    verified: true,
    sizeMm: { width: 8, height: 6 },
    gdiFlags: 184328,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: 'IN', connClass: 'EConnection', domain: 'electrical', role: 'power_neg', required: true, offsetMm: { x: 4, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F con_descr1 x_offset I 0',
      ' F con_descr1 y_offset I 0',
    ],
    symPrimitives: [
      { kind: 'line', x1: 4, y1: 0, x2: 4, y2: 4 },
      { kind: 'line', x1: 1, y1: 4, x2: 7, y2: 4 },
    ],
  },

  electrical_junction: {
    catalogType: 'electrical_junction',
    fluidsimClass: 'ETriconnection',
    symSource: 'builtin:ETriconnection',
    verified: true,
    sizeMm: { width: 4, height: 4 },
    gdiFlags: 4321283,
    usesDxfSym: false,
    // Standard 3-gate T-junction (gate1..gate3); optional 4th cross port only emitted when explicitly wired.
    gates: [
      { gateIndex: 1, portName: '1', connClass: 'EConnection', domain: 'electrical', role: 'signal', required: true, offsetMm: { x: 0, y: 2 }, normal: 'W' },
      { gateIndex: 2, portName: '2', connClass: 'EConnection', domain: 'electrical', role: 'signal', required: true, offsetMm: { x: 4, y: 2 }, normal: 'E' },
      { gateIndex: 3, portName: '3', connClass: 'EConnection', domain: 'electrical', role: 'signal', required: false, offsetMm: { x: 2, y: 4 }, normal: 'S' },
      { gateIndex: 4, portName: '4', connClass: 'EConnection', domain: 'electrical', role: 'signal', required: false, offsetMm: { x: 2, y: 0 }, normal: 'N' },
    ],
    defaultSolverProps: [
      ' F con_descr1 x_offset I 0',
      ' F con_descr1 y_offset I 0',
      ' F con_descr2 x_offset I 0',
      ' F con_descr2 y_offset I 0',
      ' F con_descr3 x_offset I 0',
      ' F con_descr3 y_offset I 0',
    ],
    symPrimitives: [
      { kind: 'circle', cx: 2, cy: 2, r: 0.8, fill: true },
    ],
  },

  pushbutton_no: {
    catalogType: 'pushbutton_no',
    fluidsimClass: 'E_S011',
    symSource: 'sym/electr/e_s011.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 4142088,
    usesDxfSym: false,
    gates: twoPortElecGates('13', 'contact_in', '14', 'contact_out', 6, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 1, y1: 3, x2: 3, y2: 7 },
    ],
  },

  pushbutton_nc: {
    catalogType: 'pushbutton_nc',
    fluidsimClass: 'E_S012',
    symSource: 'sym/electr/e_s012.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 4454408,
    usesDxfSym: false,
    gates: twoPortElecGates('11', 'contact_in', '12', 'contact_out', 6, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 3, y1: 3, x2: 4.8, y2: 3 },
      { kind: 'line', x1: 4.2, y1: 3, x2: 3, y2: 7 },
    ],
  },

  limit_switch_no: {
    catalogType: 'limit_switch_no',
    fluidsimClass: 'E_S001',
    symSource: 'sym/electr/e_s001.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 3665928,
    usesDxfSym: false,
    gates: twoPortElecGates('13', 'contact_in', '14', 'contact_out', 6, 10),
    defaultSolverProps: [' S SWITCH_TYPE I 1'],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 1, y1: 3, x2: 3, y2: 7 },
    ],
  },

  limit_switch_nc: {
    catalogType: 'limit_switch_nc',
    fluidsimClass: 'E_S002',
    symSource: 'sym/electr/e_s002.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 1472008,
    usesDxfSym: false,
    gates: twoPortElecGates('11', 'contact_in', '12', 'contact_out', 6, 10),
    defaultSolverProps: [' S SWITCH_TYPE I 1'],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 4.5, y1: 3, x2: 3, y2: 7 },
    ],
  },

  proximity_switch_magnetic: {
    catalogType: 'proximity_switch_magnetic',
    fluidsimClass: 'E_B001',
    symSource: 'sym/electr/e_b001.ct',
    verified: true,
    sizeMm: { width: 10, height: 10 },
    gdiFlags: 3665928,
    usesDxfSym: false,
    gates: twoPortElecGates('13', 'contact_in', '14', 'contact_out', 10, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'poly', points: [{ x: 5, y: 1.5 }, { x: 9, y: 5 }, { x: 5, y: 8.5 }, { x: 1, y: 5 }] },
      { kind: 'line', x1: 5, y1: 0, x2: 5, y2: 1.5 },
      { kind: 'line', x1: 5, y1: 8.5, x2: 5, y2: 10 },
    ],
  },

  relay_coil: {
    catalogType: 'relay_coil',
    fluidsimClass: 'E_K001',
    symSource: 'sym/electr/e_k001.ct',
    verified: true,
    sizeMm: { width: 8, height: 10 },
    gdiFlags: 645133,
    usesDxfSym: false,
    gates: twoPortElecGates('A1', 'coil_in', 'A2', 'coil_out', 8, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 1, y1: 2.5, x2: 7, y2: 7.5 },
      { kind: 'line', x1: 4, y1: 0, x2: 4, y2: 2.5 },
      { kind: 'line', x1: 4, y1: 7.5, x2: 4, y2: 10 },
    ],
  },

  timer_relay_on_delay: {
    catalogType: 'timer_relay_on_delay',
    fluidsimClass: 'E_K008',
    symSource: 'sym/electr/e_k008.ct',
    verified: true,
    sizeMm: { width: 12, height: 10 },
    gdiFlags: 1146888,
    usesDxfSym: false,
    gates: twoPortElecGates('A1', 'coil_in', 'A2', 'coil_out', 12, 10),
    defaultSolverProps: [
      ' S DELAY_TIME_FEST B T',
      ' S DELAY_TIME F 5',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 1, y1: 2.5, x2: 11, y2: 7.5 },
      { kind: 'line', x1: 4, y1: 2.5, x2: 1, y2: 7.5 },
      { kind: 'line', x1: 1, y1: 2.5, x2: 4, y2: 7.5 },
      { kind: 'line', x1: 6, y1: 0, x2: 6, y2: 2.5 },
      { kind: 'line', x1: 6, y1: 7.5, x2: 6, y2: 10 },
    ],
  },

  timer_relay_off_delay: {
    catalogType: 'timer_relay_off_delay',
    fluidsimClass: 'LRelaismagnet_abfver',
    symSource: 'sym/electr/e_k009.ct',
    verified: true,
    sizeMm: { width: 12, height: 10 },
    gdiFlags: 1146888,
    usesDxfSym: false,
    gates: twoPortElecGates('A1', 'coil_in', 'A2', 'coil_out', 12, 10),
    defaultSolverProps: [
      ' S DELAY_TIME_FEST B T',
      ' S DELAY_TIME F 5',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 1, y1: 2.5, x2: 11, y2: 7.5 },
      { kind: 'rect', x1: 1, y1: 2.5, x2: 4, y2: 7.5, fill: true },
      { kind: 'line', x1: 6, y1: 0, x2: 6, y2: 2.5 },
      { kind: 'line', x1: 6, y1: 7.5, x2: 6, y2: 10 },
    ],
  },

  electrical_counter: {
    catalogType: 'electrical_counter',
    fluidsimClass: 'E_P010',
    symSource: 'sym/electr/e_p010.ct',
    verified: true,
    sizeMm: { width: 14, height: 10 },
    gdiFlags: 8570888,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: 'A1', connClass: 'EConnection', domain: 'electrical', role: 'coil_in', required: true, offsetMm: { x: 4, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: 'A2', connClass: 'EConnection', domain: 'electrical', role: 'coil_out', required: true, offsetMm: { x: 4, y: 10 }, normal: 'S' },
      { gateIndex: 3, portName: 'R1', connClass: 'EConnection', domain: 'electrical', role: 'coil_in', required: false, offsetMm: { x: 10, y: 0 }, normal: 'N' },
      { gateIndex: 4, portName: 'R2', connClass: 'EConnection', domain: 'electrical', role: 'coil_out', required: false, offsetMm: { x: 10, y: 10 }, normal: 'S' },
    ],
    defaultSolverProps: [
      ' S J_FEST B T',
      ' S J F 5',
      ' S N_FEST B T',
      ' S N F 5',
    ],
    symPrimitives: [
      { kind: 'rect', x1: 1, y1: 2, x2: 13, y2: 8 },
      { kind: 'line', x1: 4, y1: 0, x2: 4, y2: 2 },
      { kind: 'line', x1: 4, y1: 8, x2: 4, y2: 10 },
      { kind: 'line', x1: 10, y1: 0, x2: 10, y2: 2 },
      { kind: 'line', x1: 10, y1: 8, x2: 10, y2: 10 },
    ],
  },

  relay_contact_no: {
    catalogType: 'relay_contact_no',
    fluidsimClass: 'E_S001',
    symSource: 'sym/electr/e_s001.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 3665928,
    usesDxfSym: false,
    gates: twoPortElecGates('13', 'contact_in', '14', 'contact_out', 6, 10),
    defaultSolverProps: [' S SWITCH_TYPE I 0'],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 1, y1: 3, x2: 3, y2: 7 },
    ],
  },

  relay_contact_nc: {
    catalogType: 'relay_contact_nc',
    fluidsimClass: 'E_S002',
    symSource: 'sym/electr/e_s002.ct',
    verified: true,
    sizeMm: { width: 6, height: 10 },
    gdiFlags: 1472008,
    usesDxfSym: false,
    gates: twoPortElecGates('11', 'contact_in', '12', 'contact_out', 6, 10),
    defaultSolverProps: [' S SWITCH_TYPE I 0'],
    symPrimitives: [
      { kind: 'line', x1: 3, y1: 0, x2: 3, y2: 3 },
      { kind: 'line', x1: 3, y1: 7, x2: 3, y2: 10 },
      { kind: 'line', x1: 4.5, y1: 3, x2: 3, y2: 7 },
    ],
  },

  relay_contact_changeover: {
    catalogType: 'relay_contact_changeover',
    fluidsimClass: 'LWechsler',
    symSource: 'sym/electr/e_s003.ct',
    verified: true,
    sizeMm: { width: 10, height: 10 },
    gdiFlags: 3665928,
    usesDxfSym: false,
    gates: [
      { gateIndex: 1, portName: '11', connClass: 'EConnection', domain: 'electrical', role: 'contact_com', required: true, offsetMm: { x: 5, y: 0 }, normal: 'N' },
      { gateIndex: 2, portName: '12', connClass: 'EConnection', domain: 'electrical', role: 'contact_nc', required: false, offsetMm: { x: 2, y: 10 }, normal: 'S' },
      { gateIndex: 3, portName: '14', connClass: 'EConnection', domain: 'electrical', role: 'contact_no', required: false, offsetMm: { x: 8, y: 10 }, normal: 'S' },
    ],
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'line', x1: 5, y1: 0, x2: 5, y2: 3 },
      { kind: 'line', x1: 5, y1: 3, x2: 2, y2: 7 },
      { kind: 'line', x1: 2, y1: 7, x2: 2, y2: 10 },
      { kind: 'line', x1: 8, y1: 7, x2: 8, y2: 10 },
    ],
  },

  valve_solenoid: {
    catalogType: 'valve_solenoid',
    fluidsimClass: 'E_Y001',
    symSource: 'sym/electr/e_y001.ct',
    verified: true,
    sizeMm: { width: 12, height: 10 },
    gdiFlags: 9113608,
    usesDxfSym: false,
    gates: twoPortElecGates('A1', 'coil_in', 'A2', 'coil_out', 12, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'rect', x1: 2, y1: 2.5, x2: 10, y2: 7.5 },
      { kind: 'line', x1: 2, y1: 7.5, x2: 10, y2: 2.5 },
      { kind: 'line', x1: 6, y1: 0, x2: 6, y2: 2.5 },
      { kind: 'line', x1: 6, y1: 7.5, x2: 6, y2: 10 },
    ],
  },

  indicator_lamp: {
    catalogType: 'indicator_lamp',
    fluidsimClass: 'E_H001',
    symSource: 'sym/electr/e_h001.ct',
    verified: true,
    sizeMm: { width: 8, height: 10 },
    gdiFlags: 645133,
    usesDxfSym: false,
    gates: twoPortElecGates('X1', 'coil_in', 'X2', 'coil_out', 8, 10),
    defaultSolverProps: [],
    symPrimitives: [
      { kind: 'circle', cx: 4, cy: 5, r: 3 },
      { kind: 'line', x1: 2, y1: 3, x2: 6, y2: 7 },
      { kind: 'line', x1: 6, y1: 3, x2: 2, y2: 7 },
      { kind: 'line', x1: 4, y1: 0, x2: 4, y2: 2 },
      { kind: 'line', x1: 4, y1: 8, x2: 4, y2: 10 },
    ],
  },
};

export function getFluidSim45Prototype(catalogType: string): FluidSim45Prototype | undefined {
  return FLUIDSIM45_PROTOTYPES[catalogType];
}

export function getPrototypeByFluidSimClass(cls: string): FluidSim45Prototype | undefined {
  return Object.values(FLUIDSIM45_PROTOTYPES).find((p) => p.fluidsimClass === cls);
}
