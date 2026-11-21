import crypto from 'node:crypto';
import type {
  CircuitDocument,
  ComponentNode,
  ConnectionEdge,
  DistanceRuleMarker,
  ValveActuationSide,
} from '../contracts/circuit';
import type { DecodedCtContainer } from './ctBinaryCodec';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';
import { autoLayoutCircuit, rotatePortOffset } from '../authoring/layoutRouter';
import {
  CtSymbolAllocator,
  buildCheckValveSyms,
  buildCylinderSyms,
  buildDualPressureAndSym,
  buildFilterSym,
  buildFlowControlOneWaySym,
  buildPressureRegulatorSym,
  buildPressureSwitchSym,
  buildQuickExhaustSym,
  buildShuttleValveOrSym,
  buildSwivelDriveSym,
  buildThrottleValveSym,
  buildVacuumNozzleSym,
  buildVacuumSuckerSym,
  buildValveSym,
  buildWartungseinheit2Sym,
} from './ctSymbolLibrary';

/**
 * Lossless FluidSIM 4.5 `.ct` text AST parser & serializer + Semantic IR bridge.
 * Empirically verified against real Festo FluidSIM `.ct` files in `fixtures/golden/`.
 */

const FS_UNIT_PER_MM = 3072;

export interface RawCtObject {
  cls: string;
  objId: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  rot: number;
  flip: number;
  flags: number;
  headerLine: string;
  props: string[];
}

export interface RawCtGate {
  gateNum: number;
  parentId: number;
  childId: number;
  rawLine: string;
}

export interface RawCtConnection {
  kind: 'PLine' | 'ELine' | 'line';
  portObjA: number;
  portObjB: number;
  rawLine: string;
  props: string[];
}

export interface ParsedCtBodyAst {
  preambleLines: string[];
  objects: RawCtObject[];
  gates: RawCtGate[];
  connections: RawCtConnection[];
  otherLines: string[];
}

export interface PreservedCtSections {
  kind: 'fluidsim-4.5-ct';
  headerLinesB64: string[];
  profile: DecodedCtContainer['profile'];
  previewBlockB64: string;
  fsPreviewBlock?: string;
  trailerText: string;
  originalCtBody: string;
  originalSemanticFingerprint: string;
  preservedDecorativeObjects: string[];
}

function getScalarProp(props: string[], key: string): string | undefined {
  const prefix = ` S ${key} `;
  for (const line of props) {
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length).trim();
      // Format: "<TYPE_TAG> <VALUE>" e.g. "S Y1", "F 100", "I 0", "B T", "INT 4"
      const sp = rest.indexOf(' ');
      if (sp >= 0) {
        return rest.slice(sp + 1);
      }
      return rest;
    }
  }
  return undefined;
}

function getNumberProp(props: string[], key: string, fallback: number): number {
  const raw = getScalarProp(props, key);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function getBoolProp(props: string[], key: string): boolean {
  const raw = getScalarProp(props, key);
  return raw === 'T' || raw === 'TRUE' || raw === 'true' || raw === '1';
}

export function parseCtBodyAst(ctBody: string): ParsedCtBodyAst {
  const preambleLines: string[] = [];
  const objects: RawCtObject[] = [];
  const gates: RawCtGate[] = [];
  const connections: RawCtConnection[] = [];
  const otherLines: string[] = [];

  const lines = ctBody.length > 0 ? ctBody.split('\n') : [];
  let curObj: RawCtObject | null = null;
  let curCon: RawCtConnection | null = null;

  for (const line of lines) {
    if (line.length === 0) continue;

    // Indented property or polyline line belonging to current object or connection
    if (line.startsWith(' ') || line.startsWith('L ')) {
      if (curObj) {
        curObj.props.push(line);
      } else if (curCon) {
        curCon.props.push(line);
      } else {
        otherLines.push(line);
      }
      continue;
    }

    curObj = null;
    curCon = null;

    // Object header: "<ClassName> O<id> <x1> <y1> <x2> <y2> <rot> <flip> <flags>"
    const objMatch = line.match(
      /^([A-Za-z0-9_]+)\s+O(\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)(.*)$/,
    );
    if (objMatch) {
      curObj = {
        cls: objMatch[1],
        objId: Number(objMatch[2]),
        x1: Number(objMatch[3]),
        y1: Number(objMatch[4]),
        x2: Number(objMatch[5]),
        y2: Number(objMatch[6]),
        rot: Number(objMatch[7]),
        flip: Number(objMatch[8]),
        flags: Number(objMatch[9]),
        headerLine: line,
        props: [],
      };
      objects.push(curObj);
      continue;
    }

    // Gate binding: "gate<N> # <parentId> <childId>"
    const gateMatch = line.match(/^gate(\d+)\s+#\s+(\d+)\s+(\d+)$/);
    if (gateMatch) {
      gates.push({
        gateNum: Number(gateMatch[1]),
        parentId: Number(gateMatch[2]),
        childId: Number(gateMatch[3]),
        rawLine: line,
      });
      continue;
    }

    // FluidSIM 4.2/4.5 connection: "CON PLine <a> <b>" or "CON ELine <a> <b>" (tolerates trailing tokens)
    const conMatch = line.match(/^CON\s+(PLine|ELine|SLine)\s+(\d+)\s+(\d+)(?:\s.*)?$/);
    if (conMatch) {
      curCon = {
        kind: conMatch[1] === 'PLine' ? 'PLine' : 'ELine',
        portObjA: Number(conMatch[2]),
        portObjB: Number(conMatch[3]),
        rawLine: line,
        props: [],
      };
      connections.push(curCon);
      continue;
    }

    // Legacy compact connection: "line <a> <b>"
    const legacyLineMatch = line.match(/^line\s+(\d+)\s+(\d+)$/);
    if (legacyLineMatch) {
      curCon = {
        kind: 'line',
        portObjA: Number(legacyLineMatch[1]),
        portObjB: Number(legacyLineMatch[2]),
        rawLine: line,
        props: [],
      };
      connections.push(curCon);
      continue;
    }

    if (objects.length === 0 && gates.length === 0 && connections.length === 0) {
      preambleLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  return { preambleLines, objects, gates, connections, otherLines };
}

function normalizeRotation(rot: number): 0 | 90 | 180 | 270 {
  const norm = ((Math.round(rot / 90) * 90) % 360 + 360) % 360;
  if (norm === 90 || norm === 180 || norm === 270) return norm;
  return 0;
}

function mapValveActuationSide(
  props: string[],
  side: 'L' | 'R',
  solenoidLabel?: string,
  rollerLabel?: string,
): ValveActuationSide {
  const springKey = side === 'L' ? 'SPRING_L' : 'SPRING_R';
  const pneuSpringKey = side === 'L' ? 'PNEU_SPRING_L' : 'PNEU_SPRING_R';
  const elPnKey = side === 'L' ? 'ACTUATION_L_EL_PN' : 'ACTUATION_R_EL_PN';
  const meKey = side === 'L' ? 'ACTUATION_L_ME' : 'ACTUATION_R_ME';
  const maKey = side === 'L' ? 'ACTUATION_L_MA' : 'ACTUATION_R_MA';
  const intPilotKey = side === 'L' ? '_MCP_INT_PILOT_L' : '_MCP_INT_PILOT_R';

  const spring = getBoolProp(props, springKey);
  const pneuSpring = getBoolProp(props, pneuSpringKey);
  const elPn = getScalarProp(props, elPnKey) ?? '';
  const me = getScalarProp(props, meKey) ?? '';
  const ma = getScalarProp(props, maKey) ?? '';
  const hasManual = Boolean(ma && !ma.endsWith('N'));
  const hasIntPilot = getBoolProp(props, intPilotKey) || elPn.includes('PE3') || (elPn.includes('PE1') && elPn.includes('PE2'));

  if (elPn.includes('PE1') || solenoidLabel) {
    return {
      type: 'solenoid',
      ...(solenoidLabel ? { label: solenoidLabel } : {}),
      ...(hasManual ? { manualOverride: true } : {}),
      ...(hasIntPilot ? { internalPilot: true } : {}),
    };
  }
  if (elPn.includes('PE2')) {
    return {
      type: 'pneumatic_pilot',
      ...(hasManual ? { manualOverride: true } : {}),
    };
  }
  if ((me && !me.endsWith('N')) || rollerLabel) {
    return { type: 'roller', ...(rollerLabel ? { label: rollerLabel } : {}) };
  }
  if (hasManual) {
    if (ma.includes('4F')) {
      return { type: 'detent' };
    }
    return { type: 'pushbutton' };
  }
  if (pneuSpring) {
    return {
      type: 'pneumatic_spring',
      ...(spring ? { springReturn: true } : {}),
    };
  }
  if (spring) {
    return { type: 'spring' };
  }
  return { type: 'none' };
}

function gateNumberToPortName(type: string, gateNum: number): string | undefined {
  switch (type) {
    case 'air_source':
    case 'exhaust_silencer':
    case 'blind_plug':
    case 'pressure_gauge':
      return gateNum === 1 ? '1' : undefined;
    case 'air_service_unit':
    case 'air_filter':
    case 'air_reservoir':
    case 'flow_control_one_way':
    case 'throttle_valve':
    case 'check_valve':
    case 'pressure_regulator':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : undefined;
    case 'check_valve_spring':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : gateNum === 3 ? '12' : undefined;
    case 'pressure_relief_valve':
      return gateNum === 1 ? '1' : gateNum === 2 ? '3' : undefined;
    case 'pressure_switch_differential':
      return gateNum === 1 ? 'P1' : gateNum === 2 ? 'P2' : undefined;
    case 'vacuum_suction_nozzle':
      return gateNum === 1 ? '1' : gateNum === 2 ? '3' : gateNum === 3 ? '1v' : undefined;
    case 'vacuum_sucker':
      return gateNum === 1 ? '1v' : undefined;
    case 'pneumatic_junction':
    case 'electrical_junction':
      return gateNum >= 1 && gateNum <= 4 ? String(gateNum) : undefined;
    case 'pneumatic_manifold':
      return gateNum >= 1 && gateNum <= 8 ? String(gateNum) : undefined;
    case 'cylinder_single_acting':
      return gateNum === 1 ? 'A' : undefined;
    case 'cylinder_double_acting':
    case 'cylinder_rodless':
    case 'swivel_drive':
    case 'air_motor':
      return gateNum === 1 ? 'A' : gateNum === 2 ? 'B' : undefined;
    case 'valve_2_2': {
      const map: Record<number, string> = { 1: '2', 2: '1', 3: '12', 4: '10' };
      return map[gateNum];
    }
    case 'valve_3_2': {
      const map: Record<number, string> = { 1: '2', 2: '1', 3: '3', 4: '12', 5: '10' };
      return map[gateNum];
    }
    case 'valve_4_2': {
      const map: Record<number, string> = { 1: '4', 2: '2', 3: '1', 4: '3', 5: '14', 6: '12' };
      return map[gateNum];
    }
    case 'valve_5_2':
    case 'valve_5_3': {
      const map: Record<number, string> = {
        1: '4',
        2: '2',
        3: '5',
        4: '1',
        5: '3',
        6: '14',
        7: '12',
      };
      return map[gateNum];
    }
    case 'quick_exhaust_valve':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : gateNum === 3 ? '3' : undefined;
    case 'shuttle_valve_or':
    case 'dual_pressure_valve_and':
      return gateNum === 1 ? '1' : gateNum === 2 ? '1_2' : gateNum === 3 ? '2' : undefined;
    case 'time_delay_valve':
    case 'pressure_sequence_valve': {
      const map: Record<number, string> = { 1: '2', 2: '1', 3: '3', 4: '12' };
      return map[gateNum];
    }
    case 'power_24v':
      return gateNum === 1 ? 'OUT' : undefined;
    case 'power_0v':
      return gateNum === 1 ? 'IN' : undefined;
    case 'pushbutton_no':
    case 'limit_switch_no':
    case 'proximity_switch_magnetic':
    case 'relay_contact_no':
      return gateNum === 1 ? '13' : gateNum === 2 ? '14' : undefined;
    case 'pushbutton_nc':
    case 'limit_switch_nc':
    case 'relay_contact_nc':
      return gateNum === 1 ? '11' : gateNum === 2 ? '12' : undefined;
    case 'relay_contact_changeover':
      return gateNum === 1 ? '11' : gateNum === 2 ? '12' : gateNum === 3 ? '14' : undefined;
    case 'relay_coil':
    case 'timer_relay_on_delay':
    case 'timer_relay_off_delay':
    case 'valve_solenoid':
      return gateNum === 1 ? 'A1' : gateNum === 2 ? 'A2' : undefined;
    case 'electrical_counter': {
      const map: Record<number, string> = { 1: 'A1', 2: 'A2', 3: 'R1', 4: 'R2' };
      return map[gateNum];
    }
    case 'indicator_lamp':
      return gateNum === 1 ? 'X1' : gateNum === 2 ? 'X2' : undefined;
    default:
      return String(gateNum);
  }
}

function portNameToGateNumber(type: string, portName: string): number {
  switch (type) {
    case 'valve_2_2': {
      const map: Record<string, number> = { '2': 1, '1': 2, '12': 3, '10': 4 };
      return map[portName] ?? 1;
    }
    case 'valve_3_2': {
      const map: Record<string, number> = { '2': 1, '1': 2, '3': 3, '12': 4, '10': 5 };
      return map[portName] ?? 1;
    }
    case 'valve_4_2': {
      const map: Record<string, number> = { '4': 1, '2': 2, '1': 3, '3': 4, '14': 5, '12': 6 };
      return map[portName] ?? 1;
    }
    case 'valve_5_2':
    case 'valve_5_3': {
      const map: Record<string, number> = {
        '4': 1,
        '2': 2,
        '5': 3,
        '1': 4,
        '3': 5,
        '14': 6,
        '12': 7,
      };
      return map[portName] ?? 1;
    }
    case 'cylinder_single_acting':
    case 'cylinder_double_acting':
    case 'cylinder_rodless':
    case 'swivel_drive':
    case 'air_motor':
      return portName === 'B' ? 2 : 1;
    case 'check_valve_spring':
      return portName === '12' ? 3 : portName === '2' ? 2 : 1;
    case 'pressure_relief_valve':
      return portName === '3' ? 2 : 1;
    case 'pressure_switch_differential':
      return portName === 'P2' ? 2 : 1;
    case 'vacuum_suction_nozzle':
      return portName === '1' ? 1 : portName === '3' ? 2 : 3;
    case 'vacuum_sucker':
      return 1;
    case 'shuttle_valve_or':
    case 'dual_pressure_valve_and':
      return portName === '1' ? 1 : portName === '1_2' ? 2 : 3;
    case 'time_delay_valve':
    case 'pressure_sequence_valve': {
      const map: Record<string, number> = { '2': 1, '1': 2, '3': 3, '12': 4 };
      return map[portName] ?? 1;
    }
    case 'power_24v':
    case 'power_0v':
    case 'air_source':
    case 'exhaust_silencer':
    case 'blind_plug':
    case 'pressure_gauge':
      return 1;
    case 'pushbutton_no':
    case 'limit_switch_no':
    case 'proximity_switch_magnetic':
    case 'relay_contact_no':
      return portName === '14' ? 2 : 1;
    case 'pushbutton_nc':
    case 'limit_switch_nc':
    case 'relay_contact_nc':
      return portName === '12' ? 2 : 1;
    case 'relay_contact_changeover':
      return portName === '12' ? 2 : portName === '14' ? 3 : 1;
    case 'relay_coil':
    case 'timer_relay_on_delay':
    case 'timer_relay_off_delay':
    case 'valve_solenoid':
      return portName === 'A2' ? 2 : 1;
    case 'electrical_counter': {
      const map: Record<string, number> = { A1: 1, A2: 2, R1: 3, R2: 4 };
      return map[portName] ?? 1;
    }
    case 'indicator_lamp':
      return portName === 'X2' ? 2 : 1;
    default: {
      const parsed = Number(portName);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
    }
  }
}

function rgbIntToLampColor(rgb: number): string {
  if (rgb === 0x00ff00 || rgb === 65280) return 'green';
  if (rgb === 0xff0000 || rgb === 16711680 || rgb === 255) return 'red';
  if (rgb === 0xffff00 || rgb === 16776960) return 'yellow';
  if (rgb === 0x0000ff) return 'blue';
  if (rgb === 0xffffff || rgb === 16777215) return 'white';
  return 'green';
}

function lampColorToRgbInt(color: string): number {
  switch (color) {
    case 'red':
      return 16711680;
    case 'yellow':
      return 16776960;
    case 'blue':
      return 255;
    case 'white':
      return 16777215;
    default:
      return 65280;
  }
}

export function computeSemanticFingerprint(doc: Pick<CircuitDocument, 'metadata' | 'components' | 'connections'>): string {
  const canonical = {
    title: doc.metadata.title,
    sheetWidthMm: doc.metadata.sheetWidthMm,
    sheetHeightMm: doc.metadata.sheetHeightMm,
    sheetDomain: doc.metadata.sheetDomain ?? null,
    allowExternalElectricalSheet: doc.metadata.allowExternalElectricalSheet ?? false,
    components: doc.components.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.label ?? null,
      params: c.params,
      rotationDeg: c.rotationDeg ?? c.layout?.rotationDeg ?? 0,
      leftActuation: c.leftActuation ?? null,
      rightActuation: c.rightActuation ?? null,
      distanceRule: c.distanceRule ?? null,
    })),
    connections: doc.connections.map((e) => ({
      id: e.id,
      from: e.from,
      to: e.to,
      domain: e.domain,
    })),
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

const PORT_CLASSES = new Set(['PConnection', 'EConnection', 'UEConnection', 'UMConnection']);
const DECORATIVE_CLASSES = new Set(['CAD_RECT', 'text', 'hupe']);

export function parseCtContainerToDocument(
  container: DecodedCtContainer,
  filePath = '',
): CircuitDocument {
  const ast = parseCtBodyAst(container.ctBody);
  // FluidSIM `gate<N> # <parentIdx> <childIdx>` and `CON <kind> <idxA> <idxB>` reference
  // 0-based object declaration indices in `ast.objects` (NOT the persistent `O<id>` handle).
  const objByIdx = new Map<number, RawCtObject>();
  ast.objects.forEach((obj, idx) => {
    objByIdx.set(idx, obj);
  });

  const gatesByParent = new Map<number, RawCtGate[]>();
  const parentByChild = new Map<number, { parentId: number; gateNum: number }>();
  for (const g of ast.gates) {
    const arr = gatesByParent.get(g.parentId) ?? [];
    arr.push(g);
    gatesByParent.set(g.parentId, arr);
    parentByChild.set(g.childId, { parentId: g.parentId, gateNum: g.gateNum });
  }

  // First collect all R_SCHALT distance-rule markers so we know cylinder marker labels
  const distanceRules: Array<{
    obj: RawCtObject;
    markers: DistanceRuleMarker[];
    cx: number;
    cy: number;
  }> = [];
  const allMarkerLabels = new Set<string>();

  for (const obj of ast.objects) {
    if (obj.cls !== 'R_SCHALT') continue;
    const markers: DistanceRuleMarker[] = [];
    for (let idx = 0; idx < 32; idx++) {
      const lbl = getScalarProp(obj.props, `label${idx}`);
      const posRaw = getScalarProp(obj.props, `pos${idx}`);
      if (lbl !== undefined && posRaw !== undefined) {
        const positionMm = Number(posRaw);
        if (lbl.trim().length > 0 && Number.isFinite(positionMm)) {
          markers.push({ label: lbl.trim(), positionMm });
          allMarkerLabels.add(lbl.trim());
        }
      }
    }
    distanceRules.push({
      obj,
      markers,
      cx: (obj.x1 + obj.x2) / 2,
      cy: (obj.y1 + obj.y2) / 2,
    });
  }

  const components: ComponentNode[] = [];
  const compIdByObjIdx = new Map<number, string>();
  const compTypeByObjIdx = new Map<number, string>();
  const manifoldSliceByObjIdx = new Map<number, number>();
  const manifoldIdSet = new Set<string>();
  const cylinderNodes: Array<{ node: ComponentNode; cx: number; cy: number }> = [];
  const preservedDecorativeObjects: string[] = [];

  // Track which port objects (by 0-based index) are actually wired via CON/line
  const connectedPortObjIndices = new Set<number>();
  for (const con of ast.connections) {
    connectedPortObjIndices.add(con.portObjA);
    connectedPortObjIndices.add(con.portObjB);
  }

  // Title & optional sheet metadata carried in FluidSIM `text` objects
  let detectedTitle = '';
  let explicitSheetWidthMm: number | undefined;
  let explicitSheetHeightMm: number | undefined;
  let explicitSheetDomain: CircuitDocument['metadata']['sheetDomain'];
  let explicitAllowExtElec: boolean | undefined;
  const usedIds = new Set<string>();
  const allocId = (preferred: string): string => {
    let candidate = preferred;
    let suffix = 2;
    while (usedIds.has(candidate)) {
      candidate = `${preferred}_${suffix++}`;
    }
    usedIds.add(candidate);
    return candidate;
  };

  for (let objIdx = 0; objIdx < ast.objects.length; objIdx++) {
    const obj = ast.objects[objIdx];
    if (PORT_CLASSES.has(obj.cls) || obj.cls === 'R_SCHALT') continue;

    if (obj.cls === 'text') {
      // Auto-generated component tag text labels are regenerated cleanly on serialize
      // and must NOT hijack the sheet title or duplicate across patches.
      if (getScalarProp(obj.props, '_MCP_LABEL_FOR')) {
        continue;
      }
      const txt = getScalarProp(obj.props, 'text');
      if (!detectedTitle && txt && txt.trim().length > 0) {
        detectedTitle = txt.trim();
      }
      const sw = getNumberProp(obj.props, '_MCP_SHEET_W', NaN);
      const sh = getNumberProp(obj.props, '_MCP_SHEET_H', NaN);
      if (Number.isFinite(sw) && sw >= 100) explicitSheetWidthMm = sw;
      if (Number.isFinite(sh) && sh >= 100) explicitSheetHeightMm = sh;
      const sd = getScalarProp(obj.props, '_MCP_SHEET_DOMAIN');
      if (sd === 'pneumatic-only' || sd === 'electro-pneumatic' || sd === 'electrical-only') {
        explicitSheetDomain = sd;
      }
      if (getScalarProp(obj.props, '_MCP_ALLOW_EXT_ELEC') !== undefined) {
        explicitAllowExtElec = getBoolProp(obj.props, '_MCP_ALLOW_EXT_ELEC');
      }
      preservedDecorativeObjects.push([obj.headerLine, ...obj.props].join('\n'));
      continue;
    }

    if (DECORATIVE_CLASSES.has(obj.cls)) {
      preservedDecorativeObjects.push([obj.headerLine, ...obj.props].join('\n'));
      continue;
    }

    const customId = getScalarProp(obj.props, '_MCP_ID');
    const customType = getScalarProp(obj.props, '_MCP_TYPE');
    const customParamsJson = getScalarProp(obj.props, '_MCP_PARAMS');
    const id = allocId(customId || `O${obj.objId}`);
    const objGates = (gatesByParent.get(objIdx) ?? []).sort((a, b) => a.gateNum - b.gateNum);

    const rotDeg = normalizeRotation(obj.rot);
    const layout = {
      x: Math.round((obj.x1 / FS_UNIT_PER_MM) * 10) / 10,
      y: Math.round((obj.y1 / FS_UNIT_PER_MM) * 10) / 10,
      rotationDeg: rotDeg,
      flipped: obj.flip !== 0,
    };

    const rawMetadata: Record<string, unknown> = {
      fluidsimClass: obj.cls,
      fluidsimObjId: obj.objId,
    };

    let node: ComponentNode | null = null;

    const manifoldId = getScalarProp(obj.props, '_MCP_MANIFOLD_ID');
    if (manifoldId && obj.cls === 'PTriconnection') {
      const sliceIdx = getNumberProp(obj.props, '_MCP_MANIFOLD_SLICE', 0);
      const busRole = getScalarProp(obj.props, '_MCP_MANIFOLD_ROLE') ?? 'supply';
      const lbl = getScalarProp(obj.props, 'label');
      manifoldSliceByObjIdx.set(objIdx, sliceIdx);
      compIdByObjIdx.set(objIdx, manifoldId);
      compTypeByObjIdx.set(objIdx, 'pneumatic_manifold');
      if (!manifoldIdSet.has(manifoldId)) {
        manifoldIdSet.add(manifoldId);
        usedIds.add(manifoldId);
        components.push({
          id: manifoldId,
          type: 'pneumatic_manifold',
          ...(lbl ? { label: lbl } : {}),
          params: { busRole },
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        });
      }
      continue;
    }

    if (customType) {
      let parsedParams: Record<string, number | string | boolean> = {};
      if (customParamsJson) {
        try {
          parsedParams = JSON.parse(Buffer.from(customParamsJson, 'base64').toString('utf8')) as Record<
            string,
            number | string | boolean
          >;
        } catch {
          parsedParams = {};
        }
      }
      const lbl = getScalarProp(obj.props, 'label');
      const actLRaw = getScalarProp(obj.props, '_MCP_ACT_L');
      const actRRaw = getScalarProp(obj.props, '_MCP_ACT_R');
      const leftActuation = actLRaw
        ? (JSON.parse(Buffer.from(actLRaw, 'base64').toString('utf8')) as ValveActuationSide)
        : undefined;
      const rightActuation = actRRaw
        ? (JSON.parse(Buffer.from(actRRaw, 'base64').toString('utf8')) as ValveActuationSide)
        : undefined;
      node = {
        id,
        type: customType,
        ...(lbl ? { label: lbl } : {}),
        params: parsedParams,
        ...(leftActuation ? { leftActuation } : {}),
        ...(rightActuation ? { rightActuation } : {}),
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
      if (customType === 'swivel_drive' || customType === 'cylinder_rodless') {
        cylinderNodes.push({
          node,
          cx: (obj.x1 + obj.x2) / 2,
          cy: (obj.y1 + obj.y2) / 2,
        });
      }
    } else if (obj.cls === 'PPE1') {
      const pressureBar = getNumberProp(obj.props, 'P_LIM', 6.0);
      const maxFlowLMin = getNumberProp(obj.props, 'FLOW', 1000);
      node = {
        id,
        type: 'air_source',
        params: { pressureBar, maxFlowLMin },
        layout,
        rawMetadata,
      };
    } else if (
      obj.cls === 'PPE2' ||
      obj.cls === 'Wartungseinheit2' ||
      obj.cls === 'Wartungseinheit' ||
      obj.cls === 'CompressorFixedP'
    ) {
      const nominalPressureBar =
        obj.cls === 'CompressorFixedP'
          ? getNumberProp(obj.props, 'P_LIM', 6.0)
          : getNumberProp(obj.props, 'P_SOLL', 6.0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'air_service_unit',
        ...(lbl ? { label: lbl } : {}),
        params: { nominalPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'FilterP') {
      const nominalFlowLMin = getNumberProp(obj.props, 'NN_FLOW', 500);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'air_filter',
        ...(lbl ? { label: lbl } : {}),
        params: { nominalFlowLMin },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PAV1') {
      const vacuumBar = getNumberProp(obj.props, '_MCP_VAC_BAR', -0.7);
      const minSupplyBar = getNumberProp(obj.props, '_MCP_MIN_SUP', 3.0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'vacuum_suction_nozzle',
        ...(lbl ? { label: lbl } : {}),
        params: { vacuumBar, minSupplyBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PAV1S') {
      const gripThresholdBar = getNumberProp(obj.props, '_MCP_GRIP_BAR', -0.3);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'vacuum_sucker',
        ...(lbl ? { label: lbl } : {}),
        params: { gripThresholdBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PAR1b') {
      const maxAngleDeg = getNumberProp(obj.props, 'ALPHA', 180);
      const initialAngleDeg = getNumberProp(obj.props, '_MCP_INIT_DEG', 0);
      const torqueNm = getNumberProp(obj.props, '_MCP_TORQUE', 5);
      const externalLoadNm = getNumberProp(obj.props, '_MCP_LOAD_NM', 0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'swivel_drive',
        ...(lbl ? { label: lbl } : {}),
        params: { maxAngleDeg, initialAngleDeg, torqueNm, externalLoadNm },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
      cylinderNodes.push({
        node,
        cx: (obj.x1 + obj.x2) / 2,
        cy: (obj.y1 + obj.y2) / 2,
      });
    } else if (obj.cls === 'PTriconnection' || obj.cls === 'PVS4') {
      const pGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'PConnection');
      node = {
        id,
        type: pGates.length > 4 ? 'pneumatic_manifold' : 'pneumatic_junction',
        params: pGates.length > 4 ? { busRole: 'supply' } : {},
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CylDGPPAB') {
      const pGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'PConnection');
      const isSingleActing =
        getBoolProp(obj.props, 'SPRING_R') ||
        (getScalarProp(obj.props, 'description') ?? '').toLowerCase().includes('einfachwirkend') ||
        pGates.length <= 1;
      const strokeMm = getNumberProp(obj.props, 'HUB', isSingleActing ? 50 : 100);
      const areaCapCm2 = getNumberProp(obj.props, 'A_K', 3.14159);
      const areaRingCm2 = getNumberProp(obj.props, 'A_R', 2.63894);
      const pistonDiameterMm = Math.max(6, Math.round(20 * Math.sqrt(Math.max(0.1, areaCapCm2) / Math.PI)));
      const rodAreaCm2 = Math.max(0.03, areaCapCm2 - areaRingCm2);
      const rodDiameterMm = Math.max(2, Math.round(20 * Math.sqrt(rodAreaCm2 / Math.PI)));
      const externalLoadN = Math.max(0, getNumberProp(obj.props, 'F', 0));
      const initialPositionMm = Math.max(0, getNumberProp(obj.props, 'S', 0));
      const lbl = getScalarProp(obj.props, 'label');

      const springForceN = getNumberProp(obj.props, '_MCP_SPRING_N', 25);
      node = {
        id,
        type: isSingleActing ? 'cylinder_single_acting' : 'cylinder_double_acting',
        ...(lbl ? { label: lbl } : {}),
        params: isSingleActing
          ? { strokeMm, pistonDiameterMm, springForceN, externalLoadN, initialPositionMm }
          : {
              strokeMm,
              pistonDiameterMm,
              rodDiameterMm,
              externalLoadN,
              cushioning: getBoolProp(obj.props, 'DAMPING_R') || getBoolProp(obj.props, 'DAMPING_L'),
              initialPositionMm,
            },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
      cylinderNodes.push({
        node,
        cx: (obj.x1 + obj.x2) / 2,
        cy: (obj.y1 + obj.y2) / 2,
      });
    } else if (obj.cls === 'WV_2' || obj.cls === 'WV_3' || obj.cls === 'WV_4' || obj.cls === 'WV_5') {
      const bodyCount = getNumberProp(obj.props, 'BODY_COUNT', 2);
      const type =
        obj.cls === 'WV_2'
          ? 'valve_2_2'
          : obj.cls === 'WV_3'
            ? 'valve_3_2'
            : obj.cls === 'WV_4'
              ? 'valve_4_2'
              : bodyCount === 3
                ? 'valve_5_3'
                : 'valve_5_2';

      const ueGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'UEConnection');
      const umGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'UMConnection');
      const leftSol = ueGates[0] ? getScalarProp(objByIdx.get(ueGates[0].childId)?.props ?? [], 'label') : undefined;
      const rightSol = ueGates[1] ? getScalarProp(objByIdx.get(ueGates[1].childId)?.props ?? [], 'label') : undefined;
      const leftRol = umGates[0] ? getScalarProp(objByIdx.get(umGates[0].childId)?.props ?? [], 'label') : undefined;
      const rightRol = umGates[1] ? getScalarProp(objByIdx.get(umGates[1].childId)?.props ?? [], 'label') : undefined;

      const leftActuation = mapValveActuationSide(obj.props, 'L', leftSol, leftRol);
      const rightActuation = mapValveActuationSide(obj.props, 'R', rightSol, rightRol);
      const nominalFlowLMin = getNumberProp(obj.props, 'NN_FLOW', type === 'valve_3_2' ? 120 : type === 'valve_2_2' ? 200 : 500);
      const lbl = getScalarProp(obj.props, 'label');

      const switchedPosR = getScalarProp(obj.props, 'SWITCHED_POS_R') ?? '';
      const switchedNo =
        getScalarProp(obj.props, '_MCP_NORMAL_STATE') === 'NO' ||
        switchedPosR.includes('C3P') ||
        switchedPosR.includes('C2P') ||
        getBoolProp(obj.props, 'SWITCHED_POS_R') ||
        (getScalarProp(obj.props, 'BODY_R') ?? '').includes('NO');
      const normalState = switchedNo ? 'NO' : 'NC';
      const initialState = getScalarProp(obj.props, '_MCP_INITIAL_STATE') === 'left' ? 'left' : 'right';
      const centerTypeRaw = getScalarProp(obj.props, '_MCP_CENTER_TYPE');
      const centerType =
        centerTypeRaw === 'exhausted' || centerTypeRaw === 'pressurized' ? centerTypeRaw : 'closed';

      node = {
        id,
        type,
        ...(lbl ? { label: lbl } : {}),
        params:
          type === 'valve_2_2' || type === 'valve_3_2'
            ? { normalState, normallyOpen: normalState === 'NO', nominalFlowLMin }
            : type === 'valve_5_3'
              ? { centerType, nominalFlowLMin }
              : { initialState, nominalFlowLMin },
        leftActuation,
        rightActuation,
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'DV_P1') {
      const pGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'PConnection');
      const lbl = getScalarProp(obj.props, 'label');
      if (pGates.length >= 3) {
        node = {
          id,
          type: 'quick_exhaust_valve',
          ...(lbl ? { label: lbl } : {}),
          params: {},
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        };
      } else {
        const level = getNumberProp(obj.props, 'LEVEL', 50);
        const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
        const freeFlowDirection = getScalarProp(obj.props, '_MCP_FREE_FLOW') === '2_to_1' ? '2_to_1' : '1_to_2';
        node = {
          id,
          type: 'flow_control_one_way',
          ...(lbl ? { label: lbl } : {}),
          params: { openingPct, freeFlowDirection },
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        };
      }
    } else if (obj.cls === 'DRSV1_pneu') {
      const level = getNumberProp(obj.props, 'LEVEL', 50);
      const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'throttle_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { openingPct },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CheckValveP') {
      const crackingPressureBar = getNumberProp(obj.props, 'P_V', 0.1);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'check_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { crackingPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CheckValveSpringLoadedP' || obj.cls === 'CheckValvePilotOperatedSpringLoadedP') {
      const crackingPressureBar = getNumberProp(obj.props, 'P_V', 0.3);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'check_valve_spring',
        ...(lbl ? { label: lbl } : {}),
        params: { crackingPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PVS3') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'shuttle_valve_or',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'DRSV2_pneu') {
      const pGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'PConnection');
      const lbl = getScalarProp(obj.props, 'label');
      if (pGates.length >= 3) {
        node = {
          id,
          type: 'dual_pressure_valve_and',
          ...(lbl ? { label: lbl } : {}),
          params: {},
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        };
      } else {
        const level = getNumberProp(obj.props, 'LEVEL', 50);
        const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
        const freeFlowDirection = getScalarProp(obj.props, '_MCP_FREE_FLOW') === '2_to_1' ? '2_to_1' : '1_to_2';
        node = {
          id,
          type: 'flow_control_one_way',
          ...(lbl ? { label: lbl } : {}),
          params: { openingPct, freeFlowDirection },
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        };
      }
    } else if (obj.cls === 'PressureReducingValve3WaysAdjustableP') {
      const setPressureBar = getNumberProp(obj.props, 'P_SOLL', 4.0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pressure_regulator',
        ...(lbl ? { label: lbl } : {}),
        params: { setPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PEW' || obj.cls === 'PSW1') {
      const pressureBar = getNumberProp(obj.props, 'P_SOLL', -0.5);
      const hysteresisBar = getNumberProp(obj.props, '_MCP_HYST', 0.05);
      const triggerModeRaw = getScalarProp(obj.props, '_MCP_TRIG_MODE');
      const triggerMode =
        triggerModeRaw === 'above' || triggerModeRaw === 'below' ? triggerModeRaw : 'auto';
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pressure_switch_differential',
        ...(lbl ? { label: lbl } : {}),
        params: { pressureBar, hysteresisBar, triggerMode },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PressureGaugeP' || obj.cls === 'ManometerP' || obj.cls === 'PM1') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pressure_gauge',
        ...(lbl ? { label: lbl } : {}),
        params: { minBar: -1, maxBar: 10 },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'ReservoirP' || obj.cls === 'AirTankP') {
      const volumeL = getNumberProp(obj.props, 'V', 1.0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'air_reservoir',
        ...(lbl ? { label: lbl } : {}),
        params: { volumeL },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'SilencerP') {
      node = { id, type: 'exhaust_silencer', params: {}, layout, rawMetadata };
    } else if (obj.cls === 'TimeDelayValveP' || obj.cls === 'VZ_NC' || obj.cls === 'VZ_NO') {
      const delayMs = Math.max(10, Math.round(getNumberProp(obj.props, 'DELAY_TIME', 10) * 100));
      const normalState = obj.cls === 'VZ_NO' ? 'NO' : 'NC';
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'time_delay_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { delayMs, normalState },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PressureSequenceValveP' || obj.cls === 'DFV') {
      const thresholdBar = getNumberProp(obj.props, 'P_SOLL', 4.0);
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pressure_sequence_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { thresholdBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'pol2' || obj.cls === 'L24V' || obj.cls === 'E_U001') {
      node = { id, type: 'power_24v', params: { voltageV: 24 }, layout, rawMetadata };
    } else if (obj.cls === 'pol1' || obj.cls === 'L0V' || obj.cls === 'E_U002') {
      node = { id, type: 'power_0v', params: {}, layout, rawMetadata };
    } else if (obj.cls === 'ETriconnection') {
      node = { id, type: 'electrical_junction', params: {}, layout, rawMetadata };
    } else if (
      obj.cls === 'E_S011' ||
      obj.cls === 'E_S031' ||
      obj.cls === 'E_S021' ||
      obj.cls === 'LTaster_s' ||
      obj.cls === 'LSchalter_s'
    ) {
      const lbl = getScalarProp(obj.props, 'label');
      const isDetent = obj.cls === 'E_S031' || obj.cls === 'E_S021' || obj.cls === 'LSchalter_s';
      node = {
        id,
        type: 'pushbutton_no',
        ...(lbl ? { label: lbl } : {}),
        params: { detent: isDetent },
        layout,
        rawMetadata,
      };
    } else if (
      obj.cls === 'E_S012' ||
      obj.cls === 'E_S032' ||
      obj.cls === 'E_S022' ||
      obj.cls === 'LTaster_o' ||
      obj.cls === 'LSchalter_o' ||
      obj.cls === 'LNotAus'
    ) {
      const lbl = getScalarProp(obj.props, 'label');
      const isDetent =
        obj.cls === 'E_S032' ||
        obj.cls === 'E_S022' ||
        obj.cls === 'LSchalter_o' ||
        obj.cls === 'LNotAus' ||
        getBoolProp(obj.props, '_MCP_DETENT');
      node = {
        id,
        type: 'pushbutton_nc',
        ...(lbl ? { label: lbl } : {}),
        params: { detent: isDetent },
        layout,
        rawMetadata,
      };
    } else if (
      obj.cls === 'E_S001' ||
      obj.cls === 'E_S002' ||
      obj.cls === 'LSchliesser' ||
      obj.cls === 'LSchliesser_r' ||
      obj.cls === 'LSchliesser_p' ||
      obj.cls === 'LOeffner' ||
      obj.cls === 'LOeffner_r' ||
      obj.cls === 'LOeffner_p'
    ) {
      const lbl = getScalarProp(obj.props, 'label');
      const switchType = getNumberProp(obj.props, 'SWITCH_TYPE', 0);
      const isLimit =
        switchType === 1 ||
        obj.cls.endsWith('_r') ||
        obj.cls.endsWith('_p') ||
        (lbl !== undefined && allMarkerLabels.has(lbl));
      const isNc = obj.cls === 'E_S002' || obj.cls.startsWith('LOeffner');
      const type = isLimit
        ? isNc
          ? 'limit_switch_nc'
          : 'limit_switch_no'
        : isNc
          ? 'relay_contact_nc'
          : 'relay_contact_no';
      node = {
        id,
        type,
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (
      obj.cls === 'LWechsler' ||
      obj.cls === 'E_S003' ||
      obj.cls === 'E_S013' ||
      obj.cls === 'E_S023'
    ) {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'relay_contact_changeover',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_K001' || obj.cls === 'LRelais' || obj.cls === 'LRelaismagnet') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'relay_coil',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_K008' || obj.cls === 'LRelaismagnet_anzver') {
      const lbl = getScalarProp(obj.props, 'label');
      // FluidSIM 4.5 stores E_K008 DELAY_TIME in tenths of a second (e.g. 50 = 5.0 s = 5000 ms).
      const delayTenths = getNumberProp(obj.props, 'DELAY_TIME', 10);
      node = {
        id,
        type: 'timer_relay_on_delay',
        ...(lbl ? { label: lbl } : {}),
        params: { delayMs: Math.max(10, Math.round(delayTenths * 100)) },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'LRelaismagnet_abfver' || obj.cls === 'E_K009') {
      const lbl = getScalarProp(obj.props, 'label');
      const delayTenths = getNumberProp(obj.props, 'DELAY_TIME', 10);
      node = {
        id,
        type: 'timer_relay_off_delay',
        ...(lbl ? { label: lbl } : {}),
        params: { delayMs: Math.max(10, Math.round(delayTenths * 100)) },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_P010' || obj.cls === 'LZaehler') {
      const lbl = getScalarProp(obj.props, 'label');
      const presetCount = Math.max(1, Math.round(getNumberProp(obj.props, 'N', 3)));
      node = {
        id,
        type: 'electrical_counter',
        ...(lbl ? { label: lbl } : {}),
        params: { presetCount },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_Y001' || obj.cls === 'E_Y002' || obj.cls === 'LMagnetventil') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'valve_solenoid',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'lampe' || obj.cls === 'LLampe' || obj.cls === 'E_H001' || obj.cls === 'E_H002') {
      const lbl = getScalarProp(obj.props, 'label');
      const rgb = getNumberProp(obj.props, 'sig_color', 65280);
      node = {
        id,
        type: 'indicator_lamp',
        ...(lbl ? { label: lbl } : {}),
        params: { color: rgbIntToLampColor(rgb) },
        layout,
        rawMetadata,
      };
    } else {
      preservedDecorativeObjects.push([obj.headerLine, ...obj.props].join('\n'));
      continue;
    }

    if (node) {
      components.push(node);
      compIdByObjIdx.set(objIdx, node.id);
      compTypeByObjIdx.set(objIdx, node.type);
    }
  }

  // Bind each R_SCHALT distance rule to the nearest cylinder (or explicit _MCP_OWNER_ID)
  for (const dr of distanceRules) {
    if (dr.markers.length === 0) continue;
    const explicitOwner = getScalarProp(dr.obj.props, '_MCP_OWNER_ID');
    let targetCyl: ComponentNode | undefined;
    if (explicitOwner) {
      targetCyl = cylinderNodes.find((c) => c.node.id === explicitOwner)?.node;
    }
    if (!targetCyl && cylinderNodes.length > 0) {
      let bestDist = Infinity;
      for (const c of cylinderNodes) {
        const dx = c.cx - dr.cx;
        const dy = c.cy - dr.cy;
        const dist = dx * dx + dy * dy;
        if (dist < bestDist) {
          bestDist = dist;
          targetCyl = c.node;
        }
      }
    }
    if (targetCyl) {
      targetCyl.distanceRule = [...(targetCyl.distanceRule ?? []), ...dr.markers];
    }
  }

  // Build ConnectionEdges from CON PLine / CON ELine / line
  const connections: ConnectionEdge[] = [];
  const usedEdgeIds = new Set<string>();
  const allocEdgeId = (preferred: string): string => {
    let candidate = preferred;
    let suffix = 2;
    while (usedEdgeIds.has(candidate)) {
      candidate = `${preferred}_${suffix++}`;
    }
    usedEdgeIds.add(candidate);
    return candidate;
  };

  const seenPortPairs = new Set<string>();
  const recordEdge = (
    compIdA: string,
    portA: string,
    compIdB: string,
    portB: string,
    domain: 'pneumatic' | 'electrical',
    preferredId: string,
  ): void => {
    if (compIdA === compIdB && portA === portB) return;
    const ka = `${compIdA}:${portA}`;
    const kb = `${compIdB}:${portB}`;
    const pairKey = ka < kb ? `${ka}<->${kb}` : `${kb}<->${ka}`;
    if (seenPortPairs.has(pairKey)) return;
    seenPortPairs.add(pairKey);
    connections.push({
      id: allocEdgeId(preferredId),
      from: { componentId: compIdA, port: portA },
      to: { componentId: compIdB, port: portB },
      domain,
    });
  };

  const directJunctionPortCursor = new Map<string, number>();

  // Helper to resolve an AST object index (either a port child or a direct junction parent) to (compId, portName)
  const resolveEndpoint = (
    endpointIdx: number,
  ): { compId: string; port: string; cls: string; portObj?: RawCtObject } | undefined => {
    const p = parentByChild.get(endpointIdx);
    if (p) {
      const compId = compIdByObjIdx.get(p.parentId);
      const compType = compTypeByObjIdx.get(p.parentId);
      const parentObj = objByIdx.get(p.parentId);
      if (!compId || !compType) return undefined;

      // Map chained 4-gate PTriconnection manifold slices back to canonical ports '1'..'8'
      const sliceIdx = manifoldSliceByObjIdx.get(p.parentId);
      if (sliceIdx !== undefined) {
        const portObj = objByIdx.get(endpointIdx);
        const explicitPort = portObj ? getScalarProp(portObj.props, '_MCP_MANIFOLD_PORT') : undefined;
        if (explicitPort) {
          return { compId, port: explicitPort, cls: parentObj?.cls ?? '', portObj };
        }
        let mappedPort: string | undefined;
        if (sliceIdx === 0 && p.gateNum >= 1 && p.gateNum <= 3) mappedPort = String(p.gateNum);
        else if (sliceIdx === 1 && p.gateNum === 2) mappedPort = '4';
        else if (sliceIdx === 1 && p.gateNum === 3) mappedPort = '5';
        else if (sliceIdx === 2 && p.gateNum >= 2 && p.gateNum <= 4) mappedPort = String(p.gateNum + 4);
        if (!mappedPort) return undefined;
        return { compId, port: mappedPort, cls: parentObj?.cls ?? '', portObj };
      }

      const port =
        parentObj?.cls === 'CompressorFixedP'
          ? p.gateNum === 1
            ? '2'
            : p.gateNum === 2
              ? '1'
              : undefined
          : gateNumberToPortName(compType, p.gateNum);
      if (!port) return undefined;
      return { compId, port, cls: parentObj?.cls ?? '', portObj: objByIdx.get(endpointIdx) };
    }
    // Fallback: CON directly targeting a junction parent object — allocate distinct ports 1..4/8
    const directCompId = compIdByObjIdx.get(endpointIdx);
    const directType = compTypeByObjIdx.get(endpointIdx);
    if (
      directCompId &&
      (directType === 'pneumatic_junction' ||
        directType === 'electrical_junction' ||
        directType === 'pneumatic_manifold')
    ) {
      const maxP = directType === 'pneumatic_manifold' ? 8 : 4;
      const next = (directJunctionPortCursor.get(directCompId) ?? 0) + 1;
      directJunctionPortCursor.set(directCompId, next);
      const port = String(Math.min(next, maxP));
      return { compId: directCompId, port, cls: objByIdx.get(endpointIdx)?.cls ?? '' };
    }
    return undefined;
  };

  interface ParsedPolylineInfo {
    domain: 'pneumatic' | 'electrical';
    anchorCompId: string;
    anchorPort: string;
    segments: Array<{ x1: number; y1: number; x2: number; y2: number }>;
  }
  const parsedPolylines: ParsedPolylineInfo[] = [];

  for (const con of ast.connections) {
    if (getBoolProp(con.props, '_MCP_MANIFOLD_LINK')) continue;
    const epA = resolveEndpoint(con.portObjA);
    const epB = resolveEndpoint(con.portObjB);
    const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const pl of con.props) {
      const m = pl.match(/^L\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (m) {
        segs.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
      }
    }
    if (!epA || !epB) continue;

    const domain: 'pneumatic' | 'electrical' =
      con.kind === 'PLine'
        ? 'pneumatic'
        : con.kind === 'ELine'
          ? 'electrical'
          : epA.portObj?.cls === 'PConnection'
            ? 'pneumatic'
            : 'electrical';

    const customEdgeId = getScalarProp(con.props, '_MCP_EDGE_ID');
    recordEdge(epA.compId, epA.port, epB.compId, epB.port, domain, customEdgeId || `E_${con.portObjA}_${con.portObjB}`);
    if (segs.length > 0) {
      parsedPolylines.push({
        domain,
        anchorCompId: epA.compId,
        anchorPort: epA.port,
        segments: segs,
      });
    }
  }

  // Coincident-port & polyline endpoint/T-tap matching for abutted/rotated FluidSIM ports (e.g., PVS4 @ 270 deg, PTriconnection, ETriconnection)
  const portObjEntries: Array<{
    objIdx: number;
    cls: 'PConnection' | 'EConnection';
    cx: number;
    cy: number;
    compId: string;
    port: string;
  }> = [];
  for (let objIdx = 0; objIdx < ast.objects.length; objIdx++) {
    const obj = ast.objects[objIdx];
    if (obj.cls !== 'PConnection' && obj.cls !== 'EConnection') continue;
    const ep = resolveEndpoint(objIdx);
    if (!ep) continue;
    portObjEntries.push({
      objIdx,
      cls: obj.cls,
      cx: (obj.x1 + obj.x2) / 2,
      cy: (obj.y1 + obj.y2) / 2,
      compId: ep.compId,
      port: ep.port,
    });
  }
  const COINCIDENT_TOL = 1024; // 1.0 mm in FluidSIM units (absorbs rotated port rounding on 90/180/270 deg symbols)
  for (let i = 0; i < portObjEntries.length; i++) {
    const a = portObjEntries[i];
    for (let j = i + 1; j < portObjEntries.length; j++) {
      const b = portObjEntries[j];
      if (a.cls !== b.cls || a.compId === b.compId) continue;
      if (connectedPortObjIndices.has(a.objIdx) && connectedPortObjIndices.has(b.objIdx)) continue;
      if (Math.abs(a.cx - b.cx) <= COINCIDENT_TOL && Math.abs(a.cy - b.cy) <= COINCIDENT_TOL) {
        const domain: 'pneumatic' | 'electrical' = a.cls === 'PConnection' ? 'pneumatic' : 'electrical';
        recordEdge(a.compId, a.port, b.compId, b.port, domain, `E_ABUT_${a.objIdx}_${b.objIdx}`);
        connectedPortObjIndices.add(a.objIdx);
        connectedPortObjIndices.add(b.objIdx);
      }
    }
  }

  // Match any remaining unconnected port sitting directly on an existing polyline segment/vertex (T-tap / rotated port touch)
  const pointNearSegment = (
    px: number,
    py: number,
    seg: { x1: number; y1: number; x2: number; y2: number },
    tol: number,
  ): boolean => {
    const minX = Math.min(seg.x1, seg.x2) - tol;
    const maxX = Math.max(seg.x1, seg.x2) + tol;
    const minY = Math.min(seg.y1, seg.y2) - tol;
    const maxY = Math.max(seg.y1, seg.y2) + tol;
    if (px < minX || px > maxX || py < minY || py > maxY) return false;
    const dx = seg.x2 - seg.x1;
    const dy = seg.y2 - seg.y1;
    const lenSq = dx * dx + dy * dy;
    if (lenSq === 0) {
      return Math.hypot(px - seg.x1, py - seg.y1) <= tol;
    }
    const t = Math.max(0, Math.min(1, ((px - seg.x1) * dx + (py - seg.y1) * dy) / lenSq));
    const projX = seg.x1 + t * dx;
    const projY = seg.y1 + t * dy;
    return Math.hypot(px - projX, py - projY) <= tol;
  };

  // For external (non-MCP-authored) native .ct files, match remaining unconnected ports sitting directly on wire segments
  const hasMcpEdges = ast.connections.some((c) => getScalarProp(c.props, '_MCP_EDGE_ID') !== undefined);
  if (!hasMcpEdges) {
    for (const entry of portObjEntries) {
      if (connectedPortObjIndices.has(entry.objIdx)) continue;
      const entryDomain: 'pneumatic' | 'electrical' = entry.cls === 'PConnection' ? 'pneumatic' : 'electrical';
      for (const pl of parsedPolylines) {
        if (pl.domain !== entryDomain) continue;
        if (pl.anchorCompId === entry.compId && pl.anchorPort === entry.port) continue;
        if (pl.segments.some((s) => pointNearSegment(entry.cx, entry.cy, s, COINCIDENT_TOL))) {
          recordEdge(
            entry.compId,
            entry.port,
            pl.anchorCompId,
            pl.anchorPort,
            entryDomain,
            `E_TAP_${entry.objIdx}`,
          );
          connectedPortObjIndices.add(entry.objIdx);
          break;
        }
      }
    }
  }

  // Synthesize exhaust_silencer (EX1/EX2/EX3) or blind_plug (EX4) nodes for unconnected PConnections
  for (let objIdx = 0; objIdx < ast.objects.length; objIdx++) {
    const obj = ast.objects[objIdx];
    if (obj.cls !== 'PConnection') continue;
    if (connectedPortObjIndices.has(objIdx)) continue;
    const exType = getScalarProp(obj.props, 'ex_type');
    const isExhaust = exType === 'EX3' || exType === 'EX2' || exType === 'EX1';
    const isPlug = exType === 'EX4';
    if (!isExhaust && !isPlug) continue;

    const ep = resolveEndpoint(objIdx);
    if (!ep) continue;
    const ownerCompId = ep.compId;
    const ownerPort = ep.port;

    if (isPlug) {
      const customPlugId = getScalarProp(obj.props, '_MCP_PLUG_ID');
      const customPlugEdgeId = getScalarProp(obj.props, '_MCP_PLUG_EDGE_ID');
      const plugId = allocId(customPlugId || `PLUG_${ownerCompId}_${ownerPort}`);
      const plugEdgeId = allocEdgeId(customPlugEdgeId || `E_PLUG_${ownerCompId}_${ownerPort}`);
      components.push({
        id: plugId,
        type: 'blind_plug',
        params: {},
        layout: {
          x: Math.round((obj.x1 / FS_UNIT_PER_MM) * 10) / 10,
          y: Math.round((obj.y1 / FS_UNIT_PER_MM) * 10) / 10,
        },
        rawMetadata: { embeddedExType: 'EX4', ownerPortObjId: obj.objId },
      });
      connections.push({
        id: plugEdgeId,
        from: { componentId: ownerCompId, port: ownerPort },
        to: { componentId: plugId, port: '1' },
        domain: 'pneumatic',
      });
    } else {
      const customExhId = getScalarProp(obj.props, '_MCP_EXH_ID');
      const customExhEdgeId = getScalarProp(obj.props, '_MCP_EXH_EDGE_ID');
      const exhId = allocId(customExhId || `EXH_${ownerCompId}_${ownerPort}`);
      const exhEdgeId = allocEdgeId(customExhEdgeId || `E_EXH_${ownerCompId}_${ownerPort}`);
      components.push({
        id: exhId,
        type: 'exhaust_silencer',
        params: {},
        layout: {
          x: Math.round((obj.x1 / FS_UNIT_PER_MM) * 10) / 10,
          y: Math.round((obj.y1 / FS_UNIT_PER_MM) * 10) / 10,
        },
        rawMetadata: { embeddedExType: exType, ownerPortObjId: obj.objId },
      });
      connections.push({
        id: exhEdgeId,
        from: { componentId: ownerCompId, port: ownerPort },
        to: { componentId: exhId, port: '1' },
        domain: 'pneumatic',
      });
    }
  }

  const fallbackTitle = filePath
    ? filePath.replace(/^.*[\\/]/, '').replace(/\.ct$/i, '')
    : 'FluidSIM 4.5 Circuit';

  // Preserve sheet dimensions: use explicit MCP sheet metadata if present, otherwise derive from extents (DIN A4 vs DIN A3)
  let maxCompXMm = 0;
  let maxCompYMm = 0;
  for (const c of components) {
    if (c.layout) {
      maxCompXMm = Math.max(maxCompXMm, c.layout.x + 40);
      maxCompYMm = Math.max(maxCompYMm, c.layout.y + 30);
    }
  }
  const inferredWidth = explicitSheetWidthMm ?? (maxCompXMm > 297 ? Math.max(420, Math.ceil(maxCompXMm / 10) * 10) : 297);
  const inferredHeight = explicitSheetHeightMm ?? (maxCompYMm > 210 || inferredWidth >= 420 ? Math.max(297, Math.ceil(maxCompYMm / 10) * 10) : 210);
  const sheetSize =
    inferredWidth >= 420 && inferredHeight >= 297
      ? ('DIN_A3_LANDSCAPE' as const)
      : inferredWidth <= 210 && inferredHeight >= 297
        ? ('DIN_A4_PORTRAIT' as const)
        : ('DIN_A4_LANDSCAPE' as const);

  const metadata: CircuitDocument['metadata'] = {
    title: detectedTitle || fallbackTitle,
    fluidsimVersion: '4.5',
    format: 'fluidsim-4.5-ct',
    sheetWidthMm: inferredWidth,
    sheetHeightMm: inferredHeight,
    sheetSize,
    ...(explicitSheetDomain ? { sheetDomain: explicitSheetDomain } : {}),
    ...(explicitAllowExtElec !== undefined ? { allowExternalElectricalSheet: explicitAllowExtElec } : {}),
  };

  const originalSemanticFingerprint = computeSemanticFingerprint({
    metadata,
    components,
    connections,
  });

  const preservedSections: PreservedCtSections = {
    kind: 'fluidsim-4.5-ct',
    headerLinesB64: container.headerLinesB64,
    profile: container.profile,
    previewBlockB64: container.previewBlockB64,
    ...(container.fsPreviewBlock !== undefined ? { fsPreviewBlock: container.fsPreviewBlock } : {}),
    trailerText: container.trailerText,
    originalCtBody: container.ctBody,
    originalSemanticFingerprint,
    preservedDecorativeObjects,
  };

  return {
    schemaVersion: '1.0',
    metadata,
    components,
    connections,
    rawAst: {
      encoding: 'binary',
      preservedSections: preservedSections as unknown as Record<string, unknown>,
    },
  };
}

function getFluidSimActuationProps(
  side: 'L' | 'R',
  act?: ValveActuationSide,
): string[] {
  const prefix = side === 'L' ? 'AL' : 'AR';
  const springKey = side === 'L' ? 'SPRING_L' : 'SPRING_R';
  const pneuSpringKey = side === 'L' ? 'PNEU_SPRING_L' : 'PNEU_SPRING_R';
  const elPnKey = side === 'L' ? 'ACTUATION_L_EL_PN' : 'ACTUATION_R_EL_PN';
  const meKey = side === 'L' ? 'ACTUATION_L_ME' : 'ACTUATION_R_ME';
  const maKey = side === 'L' ? 'ACTUATION_L_MA' : 'ACTUATION_R_MA';
  const intPilotKey = side === 'L' ? '_MCP_INT_PILOT_L' : '_MCP_INT_PILOT_R';

  const type = act?.type ?? 'none';
  const isSpring = type === 'spring' || (type === 'pneumatic_spring' && act?.springReturn === true);
  const isPneuSpring = type === 'pneumatic_spring';
  const elPn =
    type === 'solenoid'
      ? act?.internalPilot
        ? `${prefix}_PE1_PE2`
        : `${prefix}_PE1`
      : type === 'pneumatic_pilot'
        ? `${prefix}_PE2`
        : `${prefix}N`;
  const me = type === 'roller' || type === 'idle_return_roller' ? `${prefix}_ME2` : `${prefix}N`;
  const ma =
    type === 'detent'
      ? `${prefix}_MA4F`
      : type === 'pushbutton' || act?.manualOverride
        ? `${prefix}_MA5`
        : `${prefix}N`;

  return [
    ` S ${springKey}_FEST B T`,
    ` S ${springKey} S ${isSpring ? 'TRUE' : 'FALSE'}`,
    ...(isPneuSpring ? [` S ${pneuSpringKey}_FEST B T`, ` S ${pneuSpringKey} S TRUE`] : []),
    ` S ${elPnKey}_FEST B T`,
    ` S ${elPnKey} S ${elPn}`,
    ...(act?.internalPilot ? [` S ${intPilotKey} B T`] : []),
    ` S ${meKey}_FEST B T`,
    ` S ${meKey} S ${me}`,
    ` S ${maKey}_FEST B T`,
    ` S ${maKey} S ${ma}`,
  ];
}

/**
 * Serializes a CircuitDocument into FluidSIM 4.5 `.ct` text body + container metadata.
 * If the document originated from a native `.ct` file and its semantic topology has NOT changed,
 * returns the exact original `ctBody` verbatim (100% lossless roundtrip).
 */
export function serializeDocumentToCtContainer(document: CircuitDocument): {
  headerLinesB64?: string[];
  profile?: Partial<DecodedCtContainer['profile']>;
  previewBlockB64?: string;
  fsPreviewBlock?: string;
  ctBody: string;
  trailerText?: string;
} {
  const preserved = document.rawAst?.preservedSections as PreservedCtSections | undefined;
  const hasPreservedCt = preserved?.kind === 'fluidsim-4.5-ct';

  // Fast 100% lossless path when semantic content matches original parsed .ct file
  if (hasPreservedCt && preserved.originalCtBody !== undefined) {
    const currentFp = computeSemanticFingerprint(document);
    if (currentFp === preserved.originalSemanticFingerprint) {
      return {
        headerLinesB64: preserved.headerLinesB64,
        profile: preserved.profile,
        previewBlockB64: preserved.previewBlockB64,
        ...(preserved.fsPreviewBlock !== undefined ? { fsPreviewBlock: preserved.fsPreviewBlock } : {}),
        ctBody: preserved.originalCtBody,
        trailerText: preserved.trailerText,
      };
    }
  }

  // Ensure every component has non-overlapping layout coordinates before emitting .ct geometry
  const workingDoc = document.components.some((c) => !c.layout)
    ? autoLayoutCircuit(document, { incremental: true })
    : document;

  // Fresh or patched authoring path -> emit valid FluidSIM 4.5 .ct text objects, BEGINSYM symbols & connections
  let nextObjId = 0;
  const allocObjId = () => nextObjId++;

  const symAlloc = new CtSymbolAllocator();
  const objectBlocks: string[] = [];
  const gateLines: string[] = [];
  const connectionBlocks: string[] = [];

  interface RawRect {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }
  const occupiedRects: RawRect[] = [];
  const labelCandidates: Array<{
    compId: string;
    label: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }> = [];

  // Identify exhaust_silencer / blind_plug components attached to ANY pneumatic port -> embed as EX3 / EX4!
  const embeddedExhaustByPort = new Map<string, { exhId: string; edgeId: string }>();
  const embeddedPlugByPort = new Map<string, { plugId: string; edgeId: string }>();
  const embeddedTerminatorCompIds = new Set<string>();
  const embeddedTerminatorEdgeIds = new Set<string>();

  const compById = new Map(workingDoc.components.map((c) => [c.id, c]));
  const isTerminator = (t: string): boolean => t === 'exhaust_silencer' || t === 'blind_plug';

  for (const edge of workingDoc.connections) {
    const cFrom = compById.get(edge.from.componentId);
    const cTo = compById.get(edge.to.componentId);
    if (!cFrom || !cTo) continue;

    if (cTo.type === 'exhaust_silencer' && !isTerminator(cFrom.type)) {
      const key = `${cFrom.id}:${edge.from.port}`;
      if (!embeddedExhaustByPort.has(key)) {
        embeddedExhaustByPort.set(key, { exhId: cTo.id, edgeId: edge.id });
        embeddedTerminatorCompIds.add(cTo.id);
        embeddedTerminatorEdgeIds.add(edge.id);
      }
    } else if (cFrom.type === 'exhaust_silencer' && !isTerminator(cTo.type)) {
      const key = `${cTo.id}:${edge.to.port}`;
      if (!embeddedExhaustByPort.has(key)) {
        embeddedExhaustByPort.set(key, { exhId: cFrom.id, edgeId: edge.id });
        embeddedTerminatorCompIds.add(cFrom.id);
        embeddedTerminatorEdgeIds.add(edge.id);
      }
    } else if (cTo.type === 'blind_plug' && !isTerminator(cFrom.type)) {
      const key = `${cFrom.id}:${edge.from.port}`;
      if (!embeddedPlugByPort.has(key)) {
        embeddedPlugByPort.set(key, { plugId: cTo.id, edgeId: edge.id });
        embeddedTerminatorCompIds.add(cTo.id);
        embeddedTerminatorEdgeIds.add(edge.id);
      }
    } else if (cFrom.type === 'blind_plug' && !isTerminator(cTo.type)) {
      const key = `${cTo.id}:${edge.to.port}`;
      if (!embeddedPlugByPort.has(key)) {
        embeddedPlugByPort.set(key, { plugId: cFrom.id, edgeId: edge.id });
        embeddedTerminatorCompIds.add(cFrom.id);
        embeddedTerminatorEdgeIds.add(edge.id);
      }
    }
  }

  // Exact FluidSIM 4.5 raw unrotated (baseW, baseH) matching pneumatics45.ts * 3072 & ctSymbolLibrary.ts
  const getRawBaseSize = (compType: string): { baseW: number; baseH: number } => {
    switch (compType) {
      case 'air_source':
        return { baseW: 18432, baseH: 18432 };
      case 'air_service_unit':
        return { baseW: 122880, baseH: 67584 };
      case 'air_filter':
      case 'air_reservoir':
      case 'quick_exhaust_valve':
      case 'pressure_regulator':
      case 'pressure_switch_differential':
      case 'pressure_gauge':
      case 'vacuum_sucker':
        return { baseW: 24576, baseH: 24576 };
      case 'pneumatic_junction':
      case 'electrical_junction':
        return { baseW: 12288, baseH: 12288 };
      case 'pneumatic_manifold':
        return { baseW: 122880, baseH: 12288 };
      case 'cylinder_single_acting':
      case 'cylinder_double_acting':
      case 'cylinder_rodless':
        return { baseW: 57344, baseH: 32768 };
      case 'swivel_drive':
      case 'air_motor':
        return { baseW: 30720, baseH: 39936 };
      case 'vacuum_suction_nozzle':
        return { baseW: 36864, baseH: 30720 };
      case 'valve_2_2':
      case 'valve_3_2':
      case 'valve_4_2':
      case 'time_delay_valve':
      case 'pressure_sequence_valve':
        return { baseW: 86016, baseH: 36864 };
      case 'valve_5_2':
        return { baseW: 110592, baseH: 36864 };
      case 'valve_5_3':
        return { baseW: 147456, baseH: 36864 };
      case 'flow_control_one_way':
      case 'throttle_valve':
        return { baseW: 46080, baseH: 61440 };
      case 'check_valve':
      case 'check_valve_spring':
      case 'pressure_relief_valve':
        return { baseW: 12288, baseH: 24576 };
      case 'shuttle_valve_or':
      case 'dual_pressure_valve_and':
        return { baseW: 24576, baseH: 18432 };
      case 'power_24v':
      case 'power_0v':
        return { baseW: 18432, baseH: 12288 };
      case 'pushbutton_no':
      case 'pushbutton_nc':
      case 'relay_contact_changeover':
        return { baseW: 15360, baseH: 30720 };
      case 'limit_switch_no':
      case 'limit_switch_nc':
      case 'proximity_switch_magnetic':
      case 'relay_contact_no':
      case 'relay_contact_nc':
      case 'indicator_lamp':
        return { baseW: 12288, baseH: 30720 };
      case 'relay_coil':
        return { baseW: 24576, baseH: 30720 };
      case 'timer_relay_on_delay':
      case 'timer_relay_off_delay':
        return { baseW: 36864, baseH: 30720 };
      case 'electrical_counter':
        return { baseW: 43008, baseH: 30720 };
      case 'valve_solenoid':
        return { baseW: 39936, baseH: 30720 };
      default: {
        const def = getCatalogComponent(compType);
        return {
          baseW: Math.round((def?.defaultSize.width ?? 16) * FS_UNIT_PER_MM),
          baseH: Math.round((def?.defaultSize.height ?? 12) * FS_UNIT_PER_MM),
        };
      }
    }
  };

  // Map "<compId>:<portName>" -> FluidSIM port object ID
  const portObjIdMap = new Map<string, number>();

  for (const comp of workingDoc.components) {
    if (embeddedTerminatorCompIds.has(comp.id)) continue;

    const parentId = allocObjId();
    const xMm = comp.layout?.x ?? 40;
    const yMm = comp.layout?.y ?? 40;
    const x1 = Math.max(4096, Math.round(xMm * FS_UNIT_PER_MM));
    const y1 = Math.max(57344, Math.round(yMm * FS_UNIT_PER_MM));
    const rot = normalizeRotation(comp.rotationDeg ?? comp.layout?.rotationDeg ?? 0);
    const { baseW, baseH } = getRawBaseSize(comp.type);
    const boxW = rot === 90 || rot === 270 ? baseH : baseW;
    const boxH = rot === 90 || rot === 270 ? baseW : baseH;
    const x2 = x1 + boxW;
    const y2 = y1 + boxH;
    const flip = comp.layout?.flipped ? 1 : 0;

    occupiedRects.push({ x1, y1, x2, y2 });

    const catDef = getCatalogComponent(comp.type);
    const isPneumaticLabeled =
      Boolean(comp.label && comp.label.trim().length > 0) && (catDef?.layoutLayer ?? 3) < 10;
    if (isPneumaticLabeled && comp.label) {
      labelCandidates.push({
        compId: comp.id,
        label: comp.label.trim(),
        x1,
        y1,
        x2,
        y2,
      });
    }

    // Golden FluidSIM 4.5 port hitbox is 10240 x 10240 (+/-5120 around rotated port center)
    const addPortObj = (
      gateNum: number,
      cls: 'PConnection' | 'EConnection' | 'UEConnection' | 'UMConnection',
      portName?: string,
      extraProps: string[] = [],
      explicitRawOffset?: { x: number; y: number },
    ): number => {
      const pid = allocObjId();
      let rawOffX: number;
      let rawOffY: number;
      if (explicitRawOffset) {
        rawOffX = explicitRawOffset.x;
        rawOffY = explicitRawOffset.y;
      } else {
        const portDef = portName ? getPortDefinition(comp.type, portName) : undefined;
        rawOffX = portDef ? Math.round(portDef.offset.x * FS_UNIT_PER_MM) : gateNum * 3072;
        rawOffY = portDef ? Math.round(portDef.offset.y * FS_UNIT_PER_MM) : 0;
      }
      const rotOff = rotatePortOffset({ x: rawOffX, y: rawOffY }, baseW, baseH, rot);
      const cx = x1 + Math.round(rotOff.x);
      const cy = y1 + Math.round(rotOff.y);
      const px1 = cx - 5120;
      const py1 = cy - 5120;
      const px2 = cx + 5120;
      const py2 = cy + 5120;
      const lines = [
        `${cls} O${pid} ${px1} ${py1} ${px2} ${py2} 0 0 348163`,
        ...extraProps,
      ];
      objectBlocks.push(lines.join('\n'));
      gateLines.push(`gate${gateNum} # ${parentId} ${pid}`);
      if (portName) {
        portObjIdMap.set(`${comp.id}:${portName}`, pid);
      }
      return pid;
    };

    const pPortProps = (portName: string): string[] => {
      const embedded = embeddedExhaustByPort.get(`${comp.id}:${portName}`);
      if (embedded) {
        return [
          ' S ex_type_FEST B T',
          ' S ex_type S EX3',
          ' S R_H_FEST B T',
          ' S R_H F 0',
          ` S _MCP_EXH_ID S ${embedded.exhId}`,
          ` S _MCP_EXH_EDGE_ID S ${embedded.edgeId}`,
        ];
      }
      const plug = embeddedPlugByPort.get(`${comp.id}:${portName}`);
      if (plug) {
        return [
          ' S ex_type_FEST B T',
          ' S ex_type S EX4',
          ' S R_H_FEST B T',
          ' S R_H F 0',
          ` S _MCP_PLUG_ID S ${plug.plugId}`,
          ` S _MCP_PLUG_EDGE_ID S ${plug.edgeId}`,
        ];
      }
      return [
        ' S ex_type_FEST B T',
        ' S ex_type S EX0',
        ' S R_H_FEST B T',
        ' S R_H F 0',
      ];
    };

    const emitDistanceRule = (ownerComp: ComponentNode): void => {
      if (!ownerComp.distanceRule || ownerComp.distanceRule.length === 0) return;
      const drId = allocObjId();
      const drX1 = x1 + 4096;
      const drY1 = y1 - 28672;
      const drX2 = x1 + 36864;
      const drY2 = y1 - 17408;
      occupiedRects.push({ x1: drX1, y1: drY1, x2: drX2, y2: drY2 });
      const drLines = [
        `R_SCHALT O${drId} ${drX1} ${drY1} ${drX2} ${drY2} 0 0 4253703`,
        ` S _MCP_OWNER_ID S ${ownerComp.id}`,
      ];
      ownerComp.distanceRule.forEach((m, idx) => {
        drLines.push(` S label${idx} S ${m.label}`);
        drLines.push(` S pos${idx} F ${m.positionMm}`);
        drLines.push(` S pos_l_${idx} F ${m.positionMm}`);
        drLines.push(` S pos_r_${idx} F ${m.positionMm}`);
      });
      objectBlocks.push(drLines.join('\n'));
    };

    const emitValveActuationPorts = (startGate: number): void => {
      addPortObj(
        startGate,
        'UEConnection',
        undefined,
        comp.leftActuation?.type === 'solenoid' && comp.leftActuation.label
          ? [` S label S ${comp.leftActuation.label}`]
          : [],
        { x: 0, y: 24576 },
      );
      addPortObj(
        startGate + 1,
        'UEConnection',
        undefined,
        comp.rightActuation?.type === 'solenoid' && comp.rightActuation.label
          ? [` S label S ${comp.rightActuation.label}`]
          : [],
        { x: baseW, y: 24576 },
      );
      addPortObj(
        startGate + 2,
        'UMConnection',
        undefined,
        comp.leftActuation?.type === 'roller' && comp.leftActuation.label
          ? [` S label S ${comp.leftActuation.label}`]
          : [' S state INT 4'],
        { x: 9216, y: 12288 },
      );
      addPortObj(
        startGate + 3,
        'UMConnection',
        undefined,
        comp.rightActuation?.type === 'roller' && comp.rightActuation.label
          ? [` S label S ${comp.rightActuation.label}`]
          : [' S state INT 4'],
        { x: baseW - 9216, y: 12288 },
      );
    };

    const idProp = ` S _MCP_ID S ${comp.id}`;
    const labelProp = comp.label ? [` S label S ${comp.label}`] : [];

    switch (comp.type) {
      case 'air_source': {
        const pBar = Number(comp.params.pressureBar ?? 6);
        const flow = Number(comp.params.maxFlowLMin ?? 1000);
        objectBlocks.push(
          [
            `PPE1 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 2908168`,
            idProp,
            ' S P_LIM_FEST B T',
            ` S P_LIM F ${pBar}`,
            ' S FLOW_FEST B T',
            ` S FLOW F ${flow}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        break;
      }
      case 'air_service_unit': {
        const pBar = Number(comp.params.nominalPressureBar ?? 6);
        const frlSym = symAlloc.alloc(buildWartungseinheit2Sym());
        objectBlocks.push(
          [
            `Wartungseinheit2 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${frlSym}`,
            ' S NN_FLOW_FEST B T',
            ' S NN_FLOW F 750',
            ' S P_SOLL_FEST B T',
            ` S P_SOLL F ${pBar}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'pneumatic_junction': {
        objectBlocks.push(
          [`PTriconnection O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4311043`, idProp].join('\n'),
        );
        for (let g = 1; g <= 4; g++) {
          addPortObj(g, 'PConnection', String(g), pPortProps(String(g)));
        }
        break;
      }
      case 'pneumatic_manifold': {
        // FluidSIM 4.5 C++ loader requires EVERY PTriconnection to have EXACTLY 4 PConnection gates
        // (fewer than 4 gates crashes fl_sim_p.exe with 0xC0000005).
        // Represent an 8-port manifold as 3 chained 4-gate PTriconnection slices spanning 122880 x 12288 (40 x 4 mm):
        //   Slice 0 (x1 .. x1+12288): gates 1..3 -> ports '1','2','3'; gate 4 -> bridge to Slice 1
        //   Slice 1 (x1+55296 .. x1+67584): gate 1 -> bridge; gates 2..3 -> ports '4','5'; gate 4 -> bridge to Slice 2
        //   Slice 2 (x1+110592 .. x1+122880): gate 1 -> bridge; gates 2..4 -> ports '6','7','8'
        const busRole = String(comp.params.busRole ?? 'supply');
        const sliceStep = 55296; // 18 mm horizontal spacing between chained manifold nodes

        const addSlicePort = (
          sliceParentId: number,
          gateNum: number,
          rawCx: number,
          rawCy: number,
          portName?: string,
          extraProps: string[] = [],
        ): number => {
          const pid = allocObjId();
          const px1 = rawCx - 5120;
          const py1 = rawCy - 5120;
          const px2 = rawCx + 5120;
          const py2 = rawCy + 5120;
          objectBlocks.push([`PConnection O${pid} ${px1} ${py1} ${px2} ${py2} 0 0 348163`, ...extraProps].join('\n'));
          gateLines.push(`gate${gateNum} # ${sliceParentId} ${pid}`);
          if (portName) {
            portObjIdMap.set(`${comp.id}:${portName}`, pid);
          }
          return pid;
        };

        const sliceMeta = (sliceIdx: number): string[] => [
          ` S _MCP_MANIFOLD_ID S ${comp.id}`,
          ` S _MCP_MANIFOLD_ROLE S ${busRole}`,
          ` S _MCP_MANIFOLD_SLICE I ${sliceIdx}`,
          ...(sliceIdx === 0 ? labelProp : []),
        ];

        // Slice 0 (parentId already allocated immediately before switch)
        objectBlocks.push(
          [`PTriconnection O${parentId} ${x1} ${y1} ${x1 + 12288} ${y1 + 12288} ${rot} ${flip} 4311043`, ...sliceMeta(0)].join(
            '\n',
          ),
        );
        addSlicePort(parentId, 1, x1, y1 + 6144, '1', [...pPortProps('1'), ' S _MCP_MANIFOLD_PORT S 1']);
        addSlicePort(parentId, 2, x1 + 6144, y1, '2', [...pPortProps('2'), ' S _MCP_MANIFOLD_PORT S 2']);
        addSlicePort(parentId, 3, x1 + 6144, y1 + 12288, '3', [...pPortProps('3'), ' S _MCP_MANIFOLD_PORT S 3']);
        const s0BridgeOut = addSlicePort(parentId, 4, x1 + 12288, y1 + 6144, undefined, [
          ' S ex_type_FEST B T',
          ' S ex_type S EX0',
          ' S R_H_FEST B T',
          ' S R_H F 0',
        ]);

        // Slice 1 (allocate objId right before pushing to preserve strict 0-based object array indexing!)
        const slice1Id = allocObjId();
        const s1x1 = x1 + sliceStep;
        objectBlocks.push(
          [
            `PTriconnection O${slice1Id} ${s1x1} ${y1} ${s1x1 + 12288} ${y1 + 12288} ${rot} ${flip} 4311043`,
            ...sliceMeta(1),
          ].join('\n'),
        );
        const s1BridgeIn = addSlicePort(slice1Id, 1, s1x1, y1 + 6144, undefined, [
          ' S ex_type_FEST B T',
          ' S ex_type S EX0',
          ' S R_H_FEST B T',
          ' S R_H F 0',
        ]);
        addSlicePort(slice1Id, 2, s1x1 + 6144, y1, '4', [...pPortProps('4'), ' S _MCP_MANIFOLD_PORT S 4']);
        addSlicePort(slice1Id, 3, s1x1 + 6144, y1 + 12288, '5', [...pPortProps('5'), ' S _MCP_MANIFOLD_PORT S 5']);
        const s1BridgeOut = addSlicePort(slice1Id, 4, s1x1 + 12288, y1 + 6144, undefined, [
          ' S ex_type_FEST B T',
          ' S ex_type S EX0',
          ' S R_H_FEST B T',
          ' S R_H F 0',
        ]);

        // Slice 2 (allocate objId right before pushing to preserve strict 0-based object array indexing!)
        const slice2Id = allocObjId();
        const s2x1 = x1 + sliceStep * 2;
        objectBlocks.push(
          [
            `PTriconnection O${slice2Id} ${s2x1} ${y1} ${s2x1 + 12288} ${y1 + 12288} ${rot} ${flip} 4311043`,
            ...sliceMeta(2),
          ].join('\n'),
        );
        const s2BridgeIn = addSlicePort(slice2Id, 1, s2x1, y1 + 6144, undefined, [
          ' S ex_type_FEST B T',
          ' S ex_type S EX0',
          ' S R_H_FEST B T',
          ' S R_H F 0',
        ]);
        addSlicePort(slice2Id, 2, s2x1 + 6144, y1, '6', [...pPortProps('6'), ' S _MCP_MANIFOLD_PORT S 6']);
        addSlicePort(slice2Id, 3, s2x1 + 6144, y1 + 12288, '7', [...pPortProps('7'), ' S _MCP_MANIFOLD_PORT S 7']);
        addSlicePort(slice2Id, 4, s2x1 + 12288, y1 + 6144, '8', [...pPortProps('8'), ' S _MCP_MANIFOLD_PORT S 8']);

        // Internal manifold bridge PLine connections (ignored when reparsing semantic graph)
        connectionBlocks.push(
          [
            `CON PLine ${s0BridgeOut} ${s1BridgeIn}`,
            `L ${x1 + 12288} ${y1 + 6144} ${s1x1} ${y1 + 6144}`,
            ' S _MCP_MANIFOLD_LINK B T',
          ].join('\n'),
        );
        connectionBlocks.push(
          [
            `CON PLine ${s1BridgeOut} ${s2BridgeIn}`,
            `L ${s1x1 + 12288} ${y1 + 6144} ${s2x1} ${y1 + 6144}`,
            ' S _MCP_MANIFOLD_LINK B T',
          ].join('\n'),
        );
        break;
      }
      case 'vacuum_suction_nozzle': {
        const vacuumBar = Number(comp.params.vacuumBar ?? -0.7);
        const minSupplyBar = Number(comp.params.minSupplyBar ?? 3.0);
        const vacSym = symAlloc.alloc(buildVacuumNozzleSym());
        objectBlocks.push(
          [
            `PAV1 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${vacSym}`,
            ' S FLIPPED I 1',
            ` S _MCP_VAC_BAR F ${vacuumBar}`,
            ` S _MCP_MIN_SUP F ${minSupplyBar}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '3', pPortProps('3'));
        addPortObj(3, 'PConnection', '1v', pPortProps('1v'));
        break;
      }
      case 'vacuum_sucker': {
        const gripThresholdBar = Number(comp.params.gripThresholdBar ?? -0.3);
        const cupSym = symAlloc.alloc(buildVacuumSuckerSym());
        objectBlocks.push(
          [
            `PAV1S O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${cupSym}`,
            ` S _MCP_GRIP_BAR F ${gripThresholdBar}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1v', pPortProps('1v'));
        break;
      }
      case 'swivel_drive': {
        const maxAngleDeg = Number(comp.params.maxAngleDeg ?? 180);
        const initDeg = Number(comp.params.initialAngleDeg ?? 0);
        const torqueNm = Number(comp.params.torqueNm ?? 5);
        const loadNm = Number(comp.params.externalLoadNm ?? 0);
        const swvSym = symAlloc.alloc(buildSwivelDriveSym());
        objectBlocks.push(
          [
            `PAR1b O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4986883`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${swvSym}`,
            ' S ALPHA_FEST B T',
            ` S ALPHA F ${maxAngleDeg}`,
            ' S l1 F 0',
            ' S l2 F 0',
            ...(initDeg !== 0 ? [` S _MCP_INIT_DEG F ${initDeg}`] : []),
            ...(torqueNm !== 5 ? [` S _MCP_TORQUE F ${torqueNm}`] : []),
            ...(loadNm !== 0 ? [` S _MCP_LOAD_NM F ${loadNm}`] : []),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', 'A', pPortProps('A'), { x: 7168, y: 39936 });
        addPortObj(2, 'PConnection', 'B', pPortProps('B'), { x: 23552, y: 39936 });
        emitDistanceRule(comp);
        break;
      }
      case 'cylinder_single_acting':
      case 'cylinder_double_acting': {
        const isSac = comp.type === 'cylinder_single_acting';
        const stroke = Number(comp.params.strokeMm ?? (isSac ? 50 : 100));
        const bore = Number(comp.params.pistonDiameterMm ?? (isSac ? 20 : 25));
        const rod = Number(comp.params.rodDiameterMm ?? 10);
        const areaCap = Number((Math.PI * Math.pow(bore / 20, 2)).toFixed(5));
        const areaRing = Number(Math.max(0.05, areaCap - Math.PI * Math.pow(rod / 20, 2)).toFixed(5));
        const extLoad = Number(comp.params.externalLoadN ?? 0);
        const initPos = Number(comp.params.initialPositionMm ?? 0);
        const springForceN = Number(comp.params.springForceN ?? 25);
        const cushioning = comp.params.cushioning !== false;
        const cylSyms = buildCylinderSyms(isSac);
        const bodySym = symAlloc.alloc(cylSyms.body);
        const rodSym = symAlloc.alloc(cylSyms.rod);
        const lines = [
          `CylDGPPAB O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4986883`,
          idProp,
          ...labelProp,
          ` S dxf_prim_list V ${bodySym}`,
          ` S dxf_prim_list2 V ${rodSym}`,
          ' S description_FEST B T',
          ` S description S ${isSac ? 'Zylinder, einfachwirkend' : 'Zylinder, doppeltwirkend'}`,
          ' S MoName_FEST B T',
          ` S MoName S ${isSac ? 'Pneu.Actuator.CylinderSA' : 'Pneu.Actuator.CylinderDA'}`,
          ' S F_FEST B T',
          ` S F F ${extLoad}`,
          ' S S_FEST B T',
          ` S S F ${initPos}`,
          ' S HUB_FEST B T',
          ` S HUB F ${stroke}`,
          ' S A_K_FEST B T',
          ` S A_K F ${areaCap}`,
          ' S A_R_FEST B T',
          ` S A_R F ${areaRing}`,
          ' S PISTON_COUNT I 1',
          ' S PISTON_R B T',
          ...(isSac
            ? [' S SPRING_R B T', ...(springForceN !== 25 ? [` S _MCP_SPRING_N F ${springForceN}`] : [])]
            : cushioning
              ? [' S DAMPING_R B T', ' S DAMPING_L B T']
              : []),
        ];
        objectBlocks.push(lines.join('\n'));
        addPortObj(1, 'PConnection', 'A', pPortProps('A'), { x: 4096, y: 32768 });
        if (!isSac) {
          addPortObj(2, 'PConnection', 'B', pPortProps('B'), { x: 53248, y: 32768 });
        }
        emitDistanceRule(comp);
        break;
      }
      case 'air_filter': {
        const flow = Number(comp.params.nominalFlowLMin ?? 500);
        const fltSym = symAlloc.alloc(buildFilterSym());
        objectBlocks.push(
          [
            `FilterP O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${fltSym}`,
            ' S NN_FLOW_FEST B T',
            ` S NN_FLOW F ${flow}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'valve_2_2': {
        const flow = Number(comp.params.nominalFlowLMin ?? 200);
        const isNO = comp.params.normalState === 'NO' || comp.params.normallyOpen === true;
        const vSym = symAlloc.alloc(
          buildValveSym('valve_2_2', {
            leftActuation: comp.leftActuation,
            rightActuation: comp.rightActuation,
            normallyOpen: isNO,
          }),
        );
        const vFlip = comp.layout?.flipped ? 1 : -18432;
        objectBlocks.push(
          [
            `WV_2 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${vFlip} 1617923`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${vSym}`,
            ' S description_FEST B T',
            ' S description S 2/n Way Valve',
            ' S BODY_COUNT I 2',
            ` S NN_FLOW F ${flow}`,
            ...(isNO
              ? [
                  ' S _MCP_NORMAL_STATE S NO',
                  ' S SWITCHED_POS_FEST B T',
                  ' S SWITCHED_POS S (1\tC2C)',
                  ' S SWITCHED_POS_R_FEST B T',
                  ' S SWITCHED_POS_R S (2\tC2P)',
                ]
              : [
                  ' S SWITCHED_POS_FEST B T',
                  ' S SWITCHED_POS S (1\tC2P)',
                  ' S SWITCHED_POS_R_FEST B T',
                  ' S SWITCHED_POS_R S (2\tC2C)',
                ]),
            ...getFluidSimActuationProps('L', comp.leftActuation),
            ...getFluidSimActuationProps('R', comp.rightActuation),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '2', pPortProps('2'));
        addPortObj(2, 'PConnection', '1', pPortProps('1'));
        addPortObj(3, 'PConnection', '12', pPortProps('12'));
        addPortObj(4, 'PConnection', '10', pPortProps('10'));
        emitValveActuationPorts(5);
        break;
      }
      case 'valve_3_2': {
        const flow = Number(comp.params.nominalFlowLMin ?? 120);
        const isNO = comp.params.normalState === 'NO' || comp.params.normallyOpen === true;
        const vSym = symAlloc.alloc(
          buildValveSym('valve_3_2', {
            leftActuation: comp.leftActuation,
            rightActuation: comp.rightActuation,
            normallyOpen: isNO,
          }),
        );
        const vFlip = comp.layout?.flipped ? 1 : -18432;
        objectBlocks.push(
          [
            `WV_3 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${vFlip} 1617923`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${vSym}`,
            ' S description_FEST B T',
            ' S description S 3/n Way Valve',
            ' S BODY_COUNT I 2',
            ` S NN_FLOW F ${flow}`,
            ...(isNO
              ? [
                  ' S _MCP_NORMAL_STATE S NO',
                  ' S SWITCHED_POS_FEST B T',
                  ' S SWITCHED_POS S (1\tC3C)',
                  ' S SWITCHED_POS_R_FEST B T',
                  ' S SWITCHED_POS_R S (2\tC3P)',
                ]
              : [
                  ' S SWITCHED_POS_FEST B T',
                  ' S SWITCHED_POS S (1\tC3P)',
                  ' S SWITCHED_POS_R_FEST B T',
                  ' S SWITCHED_POS_R S (2\tC3C)',
                ]),
            ...getFluidSimActuationProps('L', comp.leftActuation),
            ...getFluidSimActuationProps('R', comp.rightActuation),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '2', pPortProps('2'));
        addPortObj(2, 'PConnection', '1', pPortProps('1'));
        addPortObj(3, 'PConnection', '3', pPortProps('3'));
        addPortObj(4, 'PConnection', '12', pPortProps('12'));
        addPortObj(5, 'PConnection', '10', pPortProps('10'));
        emitValveActuationPorts(6);
        break;
      }
      case 'valve_4_2': {
        const flow = Number(comp.params.nominalFlowLMin ?? 400);
        const initialState = comp.params.initialState === 'left' ? 'left' : 'right';
        const vSym = symAlloc.alloc(
          buildValveSym('valve_4_2', {
            leftActuation: comp.leftActuation,
            rightActuation: comp.rightActuation,
          }),
        );
        const vFlip = comp.layout?.flipped ? 1 : -18432;
        objectBlocks.push(
          [
            `WV_4 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${vFlip} 5109763`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${vSym}`,
            ' S description_FEST B T',
            ' S description S 4/n Way Valve',
            ' S BODY_COUNT I 2',
            ` S NN_FLOW F ${flow}`,
            ...(initialState === 'left' ? [' S _MCP_INITIAL_STATE S left'] : []),
            ...getFluidSimActuationProps('L', comp.leftActuation),
            ...getFluidSimActuationProps('R', comp.rightActuation),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '4', pPortProps('4'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        addPortObj(3, 'PConnection', '1', pPortProps('1'));
        addPortObj(4, 'PConnection', '3', pPortProps('3'));
        addPortObj(5, 'PConnection', '14', pPortProps('14'));
        addPortObj(6, 'PConnection', '12', pPortProps('12'));
        emitValveActuationPorts(7);
        break;
      }
      case 'valve_5_2':
      case 'valve_5_3': {
        const flow = Number(comp.params.nominalFlowLMin ?? 500);
        const bodyCount = comp.type === 'valve_5_3' ? 3 : 2;
        const initialState = comp.params.initialState === 'left' ? 'left' : 'right';
        const centerType = String(comp.params.centerType ?? 'closed');
        const vSym = symAlloc.alloc(
          buildValveSym(comp.type, {
            leftActuation: comp.leftActuation,
            rightActuation: comp.rightActuation,
            centerType,
          }),
        );
        const vFlip = comp.layout?.flipped ? 1 : -30720;
        objectBlocks.push(
          [
            `WV_5 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${vFlip} 5109763`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${vSym}`,
            ' S description_FEST B T',
            ' S description S 5/n Way Valve',
            ` S BODY_COUNT I ${bodyCount}`,
            ` S NN_FLOW F ${flow}`,
            ...(bodyCount === 2 && initialState === 'left' ? [' S _MCP_INITIAL_STATE S left'] : []),
            ...(bodyCount === 3 && centerType !== 'closed' ? [` S _MCP_CENTER_TYPE S ${centerType}`] : []),
            ...getFluidSimActuationProps('L', comp.leftActuation),
            ...getFluidSimActuationProps('R', comp.rightActuation),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '4', pPortProps('4'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        addPortObj(3, 'PConnection', '5', pPortProps('5'));
        addPortObj(4, 'PConnection', '1', pPortProps('1'));
        addPortObj(5, 'PConnection', '3', pPortProps('3'));
        addPortObj(6, 'PConnection', '14', pPortProps('14'));
        addPortObj(7, 'PConnection', '12', pPortProps('12'));
        emitValveActuationPorts(8);
        break;
      }
      case 'flow_control_one_way': {
        const openingPct = Number(comp.params.openingPct ?? 50);
        const freeFlow = comp.params.freeFlowDirection === '2_to_1' ? '2_to_1' : '1_to_2';
        const fcSym = symAlloc.alloc(buildFlowControlOneWaySym());
        objectBlocks.push(
          [
            `DRSV2_pneu O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 6940243`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${fcSym}`,
            ' S LEVEL_FEST B T',
            ` S LEVEL F ${openingPct}`,
            ' S NN_FLOW_FEST B T',
            ' S NN_FLOW F 100',
            ...(freeFlow === '2_to_1' ? [' S _MCP_FREE_FLOW S 2_to_1'] : []),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'throttle_valve': {
        const openingPct = Number(comp.params.openingPct ?? 50);
        const paramsB64 = Buffer.from(JSON.stringify(comp.params), 'utf8').toString('base64');
        const thSym = symAlloc.alloc(buildThrottleValveSym());
        objectBlocks.push(
          [
            `DRSV2_pneu O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 6940243`,
            idProp,
            ' S _MCP_TYPE S throttle_valve',
            ` S _MCP_PARAMS S ${paramsB64}`,
            ...labelProp,
            ` S dxf_prim_list V ${thSym}`,
            ' S LEVEL_FEST B T',
            ` S LEVEL F ${openingPct}`,
            ' S NN_FLOW_FEST B T',
            ' S NN_FLOW F 100',
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'quick_exhaust_valve': {
        const qeSym = symAlloc.alloc(buildQuickExhaustSym());
        objectBlocks.push(
          [
            `DV_P1 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 6940243`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${qeSym}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        addPortObj(3, 'PConnection', '3', pPortProps('3'));
        break;
      }
      case 'check_valve': {
        const crack = Number(comp.params.crackingPressureBar ?? 0.1);
        const chkSyms = buildCheckValveSyms(false);
        const closedSym = symAlloc.alloc(chkSyms.closed);
        const openSym = symAlloc.alloc(chkSyms.open);
        objectBlocks.push(
          [
            `CheckValveP O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 6940243`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${closedSym}`,
            ` S dxf_prim_list2 V ${openSym}`,
            ` S P_V F ${crack}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'check_valve_spring': {
        const crack = Number(comp.params.crackingPressureBar ?? 0.3);
        const hasPilot12 = workingDoc.connections.some(
          (e) =>
            (e.from.componentId === comp.id && e.from.port === '12') ||
            (e.to.componentId === comp.id && e.to.port === '12'),
        );
        const cls = hasPilot12 ? 'CheckValvePilotOperatedSpringLoadedP' : 'CheckValveSpringLoadedP';
        const chkSyms = buildCheckValveSyms(true);
        const closedSym = symAlloc.alloc(chkSyms.closed);
        const openSym = symAlloc.alloc(chkSyms.open);
        objectBlocks.push(
          [
            `${cls} O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 6940243`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${closedSym}`,
            ` S dxf_prim_list2 V ${openSym}`,
            ` S P_V F ${crack}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        if (hasPilot12) {
          addPortObj(3, 'PConnection', '12', pPortProps('12'));
        }
        break;
      }
      case 'shuttle_valve_or': {
        const orSym = symAlloc.alloc(buildShuttleValveOrSym());
        objectBlocks.push(
          [
            `PVS3 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4311043`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${orSym}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '1_2', pPortProps('1_2'));
        addPortObj(3, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'dual_pressure_valve_and': {
        const andSym = symAlloc.alloc(buildDualPressureAndSym());
        objectBlocks.push(
          [
            `DRSV2_pneu O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4311043`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${andSym}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '1_2', pPortProps('1_2'));
        addPortObj(3, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'pressure_regulator': {
        const setBar = Number(comp.params.setPressureBar ?? 4.0);
        const regSym = symAlloc.alloc(buildPressureRegulatorSym());
        objectBlocks.push(
          [
            `PressureReducingValve3WaysAdjustableP O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${regSym}`,
            ' S P_SOLL_FEST B T',
            ` S P_SOLL F ${setBar}`,
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '1', pPortProps('1'));
        addPortObj(2, 'PConnection', '2', pPortProps('2'));
        break;
      }
      case 'pressure_switch_differential': {
        const pBar = Number(comp.params.pressureBar ?? -0.5);
        const hyst = Number(comp.params.hysteresisBar ?? 0.05);
        const trigMode = String(comp.params.triggerMode ?? 'auto');
        const pswSym = symAlloc.alloc(buildPressureSwitchSym());
        objectBlocks.push(
          [
            `PSW1 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
            ...labelProp,
            ` S dxf_prim_list V ${pswSym}`,
            ' S P_SOLL_FEST B T',
            ` S P_SOLL F ${pBar}`,
            ` S _MCP_HYST F ${hyst}`,
            ...(trigMode !== 'auto' ? [` S _MCP_TRIG_MODE S ${trigMode}`] : []),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', 'P1', pPortProps('P1'));
        addPortObj(2, 'PConnection', 'P2', pPortProps('P2'));
        break;
      }
      case 'power_24v': {
        objectBlocks.push(
          [`pol2 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4126728`, idProp].join('\n'),
        );
        addPortObj(1, 'EConnection', 'OUT');
        break;
      }
      case 'power_0v': {
        objectBlocks.push(
          [`pol1 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 184328`, idProp].join('\n'),
        );
        addPortObj(1, 'EConnection', 'IN');
        break;
      }
      case 'electrical_junction': {
        objectBlocks.push(
          [`ETriconnection O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4321283`, idProp].join('\n'),
        );
        for (let g = 1; g <= 4; g++) {
          addPortObj(g, 'EConnection', String(g));
        }
        break;
      }
      case 'pushbutton_no': {
        const cls = comp.params.detent ? 'E_S031' : 'E_S011';
        objectBlocks.push(
          [`${cls} O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4142088`, idProp, ...labelProp].join(
            '\n',
          ),
        );
        addPortObj(1, 'EConnection', '13');
        addPortObj(2, 'EConnection', '14');
        break;
      }
      case 'pushbutton_nc': {
        const isDetent = Boolean(comp.params.detent);
        objectBlocks.push(
          [
            `E_S012 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4454408`,
            idProp,
            ...(isDetent ? [' S _MCP_DETENT B T'] : []),
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', '11');
        addPortObj(2, 'EConnection', '12');
        break;
      }
      case 'relay_contact_no':
      case 'limit_switch_no': {
        const switchType = comp.type === 'limit_switch_no' ? 1 : 0;
        objectBlocks.push(
          [
            `E_S001 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3665928`,
            idProp,
            ` S SWITCH_TYPE I ${switchType}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', '13');
        addPortObj(2, 'EConnection', '14');
        break;
      }
      case 'relay_contact_nc':
      case 'limit_switch_nc': {
        const switchType = comp.type === 'limit_switch_nc' ? 1 : 0;
        objectBlocks.push(
          [
            `E_S002 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 1472008`,
            idProp,
            ` S SWITCH_TYPE I ${switchType}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', '11');
        addPortObj(2, 'EConnection', '12');
        break;
      }
      case 'relay_coil': {
        objectBlocks.push(
          [`E_K001 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 645133`, idProp, ...labelProp].join(
            '\n',
          ),
        );
        addPortObj(1, 'EConnection', 'A1');
        addPortObj(2, 'EConnection', 'A2');
        break;
      }
      case 'timer_relay_on_delay': {
        const delayTenths = Math.max(0.1, Math.round((Number(comp.params.delayMs ?? 1000) / 100) * 10) / 10);
        objectBlocks.push(
          [
            `E_K008 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 1105928`,
            idProp,
            ' S DELAY_TIME_FEST B T',
            ` S DELAY_TIME F ${delayTenths}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', 'A1');
        addPortObj(2, 'EConnection', 'A2');
        break;
      }
      case 'electrical_counter': {
        const preset = Number(comp.params.presetCount ?? 3);
        objectBlocks.push(
          [
            `E_P010 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 2508808`,
            idProp,
            ' S J_FEST B T',
            ` S J F ${preset}`,
            ' S N_FEST B T',
            ` S N F ${preset}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', 'A1');
        addPortObj(2, 'EConnection', 'A2');
        addPortObj(3, 'EConnection', 'R1');
        addPortObj(4, 'EConnection', 'R2');
        break;
      }
      case 'valve_solenoid': {
        objectBlocks.push(
          [`E_Y001 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 9113608`, idProp, ...labelProp].join(
            '\n',
          ),
        );
        addPortObj(1, 'EConnection', 'A1');
        addPortObj(2, 'EConnection', 'A2');
        break;
      }
      case 'indicator_lamp': {
        const rgb = lampColorToRgbInt(String(comp.params.color ?? 'green'));
        objectBlocks.push(
          [
            `lampe O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4126728`,
            idProp,
            ` S sig_color I ${rgb}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', 'X1');
        addPortObj(2, 'EConnection', 'X2');
        break;
      }
      case 'relay_contact_changeover': {
        objectBlocks.push(
          [`LWechsler O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3665928`, idProp, ...labelProp].join(
            '\n',
          ),
        );
        addPortObj(1, 'EConnection', '11');
        addPortObj(2, 'EConnection', '12');
        addPortObj(3, 'EConnection', '14');
        break;
      }
      case 'timer_relay_off_delay': {
        const delayTenths = Math.max(0.1, Math.round((Number(comp.params.delayMs ?? 1000) / 100) * 10) / 10);
        objectBlocks.push(
          [
            `LRelaismagnet_abfver O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 1105928`,
            idProp,
            ' S DELAY_TIME_FEST B T',
            ` S DELAY_TIME F ${delayTenths}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', 'A1');
        addPortObj(2, 'EConnection', 'A2');
        break;
      }
      default: {
        // Extension catalog types: always choose a FluidSIM 4.5 native class whose required gate count matches
        // what we emit (NEVER emit PTriconnection or ETriconnection with != 4 gates, as fl_sim_p.exe crashes!).
        const isElec =
          comp.type.startsWith('relay_') ||
          comp.type.startsWith('timer_relay_') ||
          comp.type.startsWith('proximity_');
        const paramsB64 = Buffer.from(JSON.stringify(comp.params), 'utf8').toString('base64');
        const actLProp = comp.leftActuation
          ? [` S _MCP_ACT_L S ${Buffer.from(JSON.stringify(comp.leftActuation), 'utf8').toString('base64')}`]
          : [];
        const actRProp = comp.rightActuation
          ? [` S _MCP_ACT_R S ${Buffer.from(JSON.stringify(comp.rightActuation), 'utf8').toString('base64')}`]
          : [];

        const nativeFallbackMap: Record<string, { cls: string; ports: string[] }> = {
          cylinder_rodless: { cls: 'CylDGPPAB', ports: ['A', 'B'] },
          air_motor: { cls: 'PAR1b', ports: ['A', 'B'] },
          air_reservoir: { cls: 'FilterP', ports: ['1', '2'] },
          pressure_relief_valve: { cls: 'CheckValveSpringLoadedP', ports: ['1', '3'] },
          pressure_gauge: { cls: 'PSW1', ports: ['1'] },
          proximity_switch_magnetic: { cls: 'E_S001', ports: ['13', '14'] },
          time_delay_valve: { cls: 'WV_3', ports: ['2', '1', '3', '12', '10'] },
          pressure_sequence_valve: { cls: 'WV_3', ports: ['2', '1', '3', '12', '10'] },
          exhaust_silencer: { cls: 'PSW1', ports: ['1'] },
          blind_plug: { cls: 'PSW1', ports: ['1'] },
        };
        const mapped = nativeFallbackMap[comp.type];
        const baseCls = mapped ? mapped.cls : isElec ? 'E_K001' : 'PTriconnection';

        const extraSymProps: string[] = [];
        if (baseCls === 'CylDGPPAB') {
          const syms = buildCylinderSyms(false);
          extraSymProps.push(` S dxf_prim_list V ${symAlloc.alloc(syms.body)}`);
          extraSymProps.push(` S dxf_prim_list2 V ${symAlloc.alloc(syms.rod)}`);
        } else if (baseCls === 'PAR1b') {
          extraSymProps.push(` S dxf_prim_list V ${symAlloc.alloc(buildSwivelDriveSym())}`);
        } else if (baseCls === 'FilterP') {
          extraSymProps.push(` S dxf_prim_list V ${symAlloc.alloc(buildFilterSym())}`);
        } else if (baseCls === 'CheckValveSpringLoadedP') {
          const syms = buildCheckValveSyms(true);
          extraSymProps.push(` S dxf_prim_list V ${symAlloc.alloc(syms.closed)}`);
          extraSymProps.push(` S dxf_prim_list2 V ${symAlloc.alloc(syms.open)}`);
        } else if (baseCls === 'PSW1') {
          extraSymProps.push(` S dxf_prim_list V ${symAlloc.alloc(buildPressureSwitchSym())}`);
        } else if (baseCls === 'WV_3') {
          extraSymProps.push(
            ` S dxf_prim_list V ${symAlloc.alloc(
              buildValveSym('valve_3_2', {
                leftActuation: { type: 'pneumatic_pilot' },
                rightActuation: { type: 'spring' },
              }),
            )}`,
          );
        }

        objectBlocks.push(
          [
            `${baseCls} O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4311043`,
            idProp,
            ` S _MCP_TYPE S ${comp.type}`,
            ` S _MCP_PARAMS S ${paramsB64}`,
            ...extraSymProps,
            ...actLProp,
            ...actRProp,
            ...labelProp,
          ].join('\n'),
        );

        if (mapped) {
          for (const portName of mapped.ports) {
            const gNum = portNameToGateNumber(comp.type, portName);
            addPortObj(gNum, isElec ? 'EConnection' : 'PConnection', portName, isElec ? [] : pPortProps(portName));
          }
        } else if (baseCls === 'PTriconnection' || baseCls === 'ETriconnection') {
          // Enforce strict 4-gate FluidSIM 4.5 invariant on any junction fallback
          const referencedPorts = new Set<string>();
          for (const e of workingDoc.connections) {
            if (e.from.componentId === comp.id) referencedPorts.add(e.from.port);
            if (e.to.componentId === comp.id) referencedPorts.add(e.to.port);
          }
          const byGate = new Map<number, string>();
          for (const portName of referencedPorts) {
            const gNum = portNameToGateNumber(comp.type, portName);
            if (gNum >= 1 && gNum <= 4 && !byGate.has(gNum)) {
              byGate.set(gNum, portName);
            }
          }
          for (let g = 1; g <= 4; g++) {
            const portName = byGate.get(g) ?? String(g);
            addPortObj(g, isElec ? 'EConnection' : 'PConnection', portName, isElec ? [] : pPortProps(portName));
          }
        } else {
          const referencedPorts = new Set<string>();
          for (const e of workingDoc.connections) {
            if (e.from.componentId === comp.id) referencedPorts.add(e.from.port);
            if (e.to.componentId === comp.id) referencedPorts.add(e.to.port);
          }
          if (referencedPorts.size === 0) {
            referencedPorts.add(isElec ? 'A1' : '1');
            if (isElec) referencedPorts.add('A2');
          }
          for (const portName of referencedPorts) {
            const gNum = portNameToGateNumber(comp.type, portName);
            addPortObj(gNum, isElec ? 'EConnection' : 'PConnection', portName, isElec ? [] : pPortProps(portName));
          }
        }

        emitDistanceRule(comp);
        break;
      }
    }
  }

  // Emit preserved decorative objects (CAD_RECT, text, etc.) if present from an edited native .ct file,
  // or emit a standard FluidSIM title `text` object carrying sheet metadata at top-left (y = 4..12 mm).
  const sheetMetaProps: string[] = [
    ` S _MCP_SHEET_W F ${workingDoc.metadata.sheetWidthMm}`,
    ` S _MCP_SHEET_H F ${workingDoc.metadata.sheetHeightMm}`,
    ...(workingDoc.metadata.sheetDomain ? [` S _MCP_SHEET_DOMAIN S ${workingDoc.metadata.sheetDomain}`] : []),
    ...(workingDoc.metadata.allowExternalElectricalSheet !== undefined
      ? [` S _MCP_ALLOW_EXT_ELEC B ${workingDoc.metadata.allowExternalElectricalSheet ? 'T' : 'F'}`]
      : []),
  ];

  const titleRect: RawRect = { x1: 18432, y1: 12288, x2: 368640, y2: 36864 };
  occupiedRects.push(titleRect);

  if (hasPreservedCt && preserved.preservedDecorativeObjects.length > 0) {
    let attachedSheetMeta = false;
    for (const rawBlock of preserved.preservedDecorativeObjects) {
      const newId = allocObjId();
      let reindexed = rawBlock.replace(/^([A-Za-z0-9_]+)\s+O\d+(\s+)/, `$1 O${newId}$2`);
      if (!attachedSheetMeta && reindexed.startsWith('text ')) {
        reindexed = [reindexed, ...sheetMetaProps].join('\n');
        attachedSheetMeta = true;
      }
      objectBlocks.push(reindexed);
    }
    if (!attachedSheetMeta) {
      const metaId = allocObjId();
      objectBlocks.push(
        [
          `text O${metaId} ${titleRect.x1} ${titleRect.y1} ${titleRect.x2} ${titleRect.y2} 0 0 1167363`,
          ' S height I 16',
          ' S font_name S Arial',
          ` S text S ${(workingDoc.metadata.title || 'FluidSIM 4.5 Circuit').replace(/[\r\n]+/g, ' ').trim()}`,
          ...sheetMetaProps,
        ].join('\n'),
      );
    }
  } else {
    const titleId = allocObjId();
    const safeTitle = (workingDoc.metadata.title || 'FluidSIM 4.5 Circuit').replace(/[\r\n]+/g, ' ').trim();
    objectBlocks.push(
      [
        `text O${titleId} ${titleRect.x1} ${titleRect.y1} ${titleRect.x2} ${titleRect.y2} 0 0 1167363`,
        ' S height I 16',
        ' S font_name S Arial',
        ` S text S ${safeTitle}`,
        ...sheetMetaProps,
      ].join('\n'),
    );
  }

  // Emit collision-free visible component label `text` objects (marked with _MCP_LABEL_FOR so reparsing skips them)
  const rectsOverlap = (a: RawRect, b: RawRect, pad = 1024): boolean =>
    a.x1 < b.x2 + pad && a.x2 + pad > b.x1 && a.y1 < b.y2 + pad && a.y2 + pad > b.y1;

  for (const cand of labelCandidates) {
    const safeLabel = cand.label.replace(/[\r\n]+/g, ' ').trim();
    if (!safeLabel) continue;
    const lblW = Math.max(14336, Math.min(49152, safeLabel.length * 4096 + 4096));
    const lblH = 10240;
    const midY = cand.y1 + Math.round((cand.y2 - cand.y1 - lblH) / 2);
    const midX = cand.x1 + Math.round((cand.x2 - cand.x1 - lblW) / 2);
    const gap = 3072;

    const trials: Array<{ x1: number; y1: number }> = [
      { x1: cand.x2 + gap, y1: midY }, // Right
      { x1: cand.x1 - lblW - gap, y1: midY }, // Left
      { x1: midX, y1: cand.y2 + gap }, // Below
      { x1: midX, y1: cand.y1 - lblH - gap }, // Above
      { x1: cand.x2 + gap, y1: cand.y1 }, // Top-right
      { x1: cand.x1 - lblW - gap, y1: cand.y1 }, // Top-left
      { x1: cand.x2 + gap, y1: cand.y2 - lblH }, // Bottom-right
      { x1: cand.x1 - lblW - gap, y1: cand.y2 - lblH }, // Bottom-left
      { x1: cand.x2 + gap * 3, y1: midY }, // Far right
      { x1: midX, y1: cand.y2 + gap * 3 }, // Far below
    ];

    for (const t of trials) {
      const r: RawRect = { x1: t.x1, y1: t.y1, x2: t.x1 + lblW, y2: t.y1 + lblH };
      if (r.x1 < 4096 || r.y1 < titleRect.y2 + 20 * 1024) continue;
      if (!occupiedRects.some((occ) => rectsOverlap(r, occ, 1024))) {
        occupiedRects.push(r);
        const lblId = allocObjId();
        objectBlocks.push(
          [
            `text O${lblId} ${r.x1} ${r.y1} ${r.x2} ${r.y2} 0 0 1167363`,
            ' S height I 10',
            ' S font_name S Arial',
            ` S text S ${safeLabel}`,
            ` S _MCP_LABEL_FOR S ${cand.compId}`,
          ].join('\n'),
        );
        break;
      }
    }
  }

  // Emit CON PLine / CON ELine edges (with orthogonal L polyline segments when routed)
  for (const edge of workingDoc.connections) {
    if (embeddedTerminatorEdgeIds.has(edge.id)) continue;
    const pA = portObjIdMap.get(`${edge.from.componentId}:${edge.from.port}`);
    const pB = portObjIdMap.get(`${edge.to.componentId}:${edge.to.port}`);
    if (pA === undefined || pB === undefined) continue;
    const conKind = edge.domain === 'pneumatic' ? 'PLine' : 'ELine';
    const conLines = [`CON ${conKind} ${pA} ${pB}`];
    if (edge.waypoints && edge.waypoints.length >= 2) {
      for (let w = 0; w < edge.waypoints.length - 1; w++) {
        const a = edge.waypoints[w];
        const b = edge.waypoints[w + 1];
        conLines.push(
          `L ${Math.round(a.x * FS_UNIT_PER_MM)} ${Math.round(a.y * FS_UNIT_PER_MM)} ${Math.round(b.x * FS_UNIT_PER_MM)} ${Math.round(b.y * FS_UNIT_PER_MM)}`,
        );
      }
    }
    conLines.push(` S _MCP_EDGE_ID S ${edge.id}`);
    connectionBlocks.push(conLines.join('\n'));
  }

  const ctBody = [...objectBlocks, '0 0 0 # 0 0 0 0 0 0', ...gateLines, ...connectionBlocks].join('\n');
  const trailerText = symAlloc.renderTrailer();

  return {
    ...(hasPreservedCt
      ? {
          headerLinesB64: preserved.headerLinesB64,
          profile: preserved.profile,
          previewBlockB64: preserved.previewBlockB64,
          ...(preserved.fsPreviewBlock !== undefined ? { fsPreviewBlock: preserved.fsPreviewBlock } : {}),
        }
      : {}),
    ctBody,
    trailerText,
  };
}

export interface CtTextInvariantReport {
  ok: boolean;
  badJunctions: Array<{ cls: string; objId: number; gateCount: number }>;
}

/**
 * Verifies FluidSIM 4.5 C++ loader structural invariants on a decoded .ct body:
 * every PTriconnection and ETriconnection MUST have exactly 4 child gates (fewer crashes fl_sim_p.exe).
 */
export function verifyCtTextInvariants(ctBody: string): CtTextInvariantReport {
  const ast = parseCtBodyAst(ctBody);
  const gateCountByParent = new Map<number, number>();
  for (const g of ast.gates) {
    gateCountByParent.set(g.parentId, (gateCountByParent.get(g.parentId) ?? 0) + 1);
  }
  const badJunctions: Array<{ cls: string; objId: number; gateCount: number }> = [];
  for (let i = 0; i < ast.objects.length; i++) {
    const obj = ast.objects[i];
    if (obj.cls === 'PTriconnection' || obj.cls === 'ETriconnection') {
      const count = gateCountByParent.get(i) ?? 0;
      if (count !== 4) {
        badJunctions.push({ cls: obj.cls, objId: obj.objId, gateCount: count });
      }
    }
  }
  return {
    ok: badJunctions.length === 0,
    badJunctions,
  };
}

export interface CtVisualLayoutInvariantReport {
  ok: boolean;
  symCount: number;
  missingSymbols: Array<{ cls: string; objId: number; prop: string; symIdx: number }>;
  missingDxfPrimList: Array<{ cls: string; objId: number }>;
  negativeCoordObjects: Array<{ cls: string; objId: number; x1: number; y1: number }>;
  titleCollisions: Array<{ cls: string; objId: number; y1: number; titleY2: number }>;
  overlaps: Array<{ a: string; b: string }>;
}

const DXF_SYMBOL_REQUIRED_CLASSES = new Set([
  'CylDGPPAB',
  'WV_2',
  'WV_3',
  'WV_4',
  'WV_5',
  'DRSV2_pneu',
  'FilterP',
  'CheckValveP',
  'CheckValveSpringLoadedP',
  'CheckValvePilotOperatedSpringLoadedP',
  'Wartungseinheit2',
  'PAR1b',
  'PAV1',
  'PAV1S',
  'PSW1',
]);

/**
 * Verifies FluidSIM 4.5 visual rendering & raw-AST layout invariants on a decoded `.ct` file:
 * 1. Every `S dxf_prim_list V <n>` / `dxf_prim_list2 V <n>` references an existing `SYM <n>` in `BEGINSYM..ENDSYM`.
 * 2. Every symbol-rendered component class (`CylDGPPAB`, `WV_*`, `DRSV2_pneu`, `FilterP`, `CheckValve*`, `Wartungseinheit2`, etc.) emits `dxf_prim_list`.
 * 3. Every non-port object has strictly positive coordinates (`x1 > 0 && y1 > 0`).
 * 4. Every component, `R_SCHALT`, and component label sits `>= 20 * 1024` below the title `text` object's `y2`.
 * 5. Zero overlapping pairs among all non-port objects (components, `R_SCHALT`, `text`) in raw FluidSIM coordinates.
 */
export function verifyCtVisualLayoutInvariants(
  ctBody: string,
  trailerText: string,
): CtVisualLayoutInvariantReport {
  const ast = parseCtBodyAst(ctBody);

  // Parse defined SYM <n> blocks inside BEGINSYM ... ENDSYM
  const symIds = new Set<number>();
  let inSymSection = false;
  for (const rawLine of trailerText.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === 'BEGINSYM') {
      inSymSection = true;
      continue;
    }
    if (line === 'ENDSYM') {
      inSymSection = false;
      continue;
    }
    if (inSymSection) {
      const m = line.match(/^SYM\s+(\d+)$/);
      if (m) symIds.add(Number(m[1]));
    }
  }

  const missingSymbols: CtVisualLayoutInvariantReport['missingSymbols'] = [];
  const missingDxfPrimList: CtVisualLayoutInvariantReport['missingDxfPrimList'] = [];
  const negativeCoordObjects: CtVisualLayoutInvariantReport['negativeCoordObjects'] = [];
  const titleCollisions: CtVisualLayoutInvariantReport['titleCollisions'] = [];
  const overlaps: CtVisualLayoutInvariantReport['overlaps'] = [];

  const nonPortObjs: RawCtObject[] = [];
  let titleObj: RawCtObject | undefined;

  for (const obj of ast.objects) {
    if (PORT_CLASSES.has(obj.cls)) continue;
    nonPortObjs.push(obj);

    if (obj.x1 <= 0 || obj.y1 <= 0) {
      negativeCoordObjects.push({ cls: obj.cls, objId: obj.objId, x1: obj.x1, y1: obj.y1 });
    }

    if (obj.cls === 'text' && !getScalarProp(obj.props, '_MCP_LABEL_FOR') && !titleObj) {
      titleObj = obj;
    }

    const dxf1 = getScalarProp(obj.props, 'dxf_prim_list');
    const dxf2 = getScalarProp(obj.props, 'dxf_prim_list2');
    if (DXF_SYMBOL_REQUIRED_CLASSES.has(obj.cls) && dxf1 === undefined) {
      missingDxfPrimList.push({ cls: obj.cls, objId: obj.objId });
    }
    if (dxf1 !== undefined) {
      const idx = Number(dxf1);
      if (!Number.isInteger(idx) || !symIds.has(idx)) {
        missingSymbols.push({ cls: obj.cls, objId: obj.objId, prop: 'dxf_prim_list', symIdx: idx });
      }
    }
    if (dxf2 !== undefined) {
      const idx = Number(dxf2);
      if (!Number.isInteger(idx) || !symIds.has(idx)) {
        missingSymbols.push({ cls: obj.cls, objId: obj.objId, prop: 'dxf_prim_list2', symIdx: idx });
      }
    }
  }

  if (titleObj) {
    const minAllowedY = titleObj.y2 + 20 * 1024;
    for (const obj of nonPortObjs) {
      if (obj === titleObj) continue;
      if (obj.y1 < minAllowedY) {
        titleCollisions.push({ cls: obj.cls, objId: obj.objId, y1: obj.y1, titleY2: titleObj.y2 });
      }
    }
  }

  for (let i = 0; i < nonPortObjs.length; i++) {
    const a = nonPortObjs[i];
    for (let j = i + 1; j < nonPortObjs.length; j++) {
      const b = nonPortObjs[j];
      const ox = a.x1 < b.x2 && a.x2 > b.x1;
      const oy = a.y1 < b.y2 && a.y2 > b.y1;
      if (ox && oy) {
        overlaps.push({ a: `${a.cls}#O${a.objId}`, b: `${b.cls}#O${b.objId}` });
      }
    }
  }

  return {
    ok:
      missingSymbols.length === 0 &&
      missingDxfPrimList.length === 0 &&
      negativeCoordObjects.length === 0 &&
      titleCollisions.length === 0 &&
      overlaps.length === 0,
    symCount: symIds.size,
    missingSymbols,
    missingDxfPrimList,
    negativeCoordObjects,
    titleCollisions,
    overlaps,
  };
}

