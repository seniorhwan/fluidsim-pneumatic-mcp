import crypto from 'node:crypto';
import type {
  CircuitDocument,
  ComponentNode,
  ConnectionEdge,
  DistanceRuleMarker,
  ValveActuationSide,
} from '../contracts/circuit';
import type { DecodedCtContainer } from './ctBinaryCodec';
import { getPortDefinition } from '../catalog/pneumatics45';

/**
 * Lossless FluidSIM 4.5 `.ct` text AST parser & serializer + Semantic IR bridge.
 * Empirically verified against real Festo FluidSIM `.ct` files in `fixtures/golden/`.
 */

const FS_UNIT_PER_MM = 1024;

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

    // FluidSIM 4.2/4.5 connection: "CON PLine <a> <b>" or "CON ELine <a> <b>"
    const conMatch = line.match(/^CON\s+(PLine|ELine)\s+(\d+)\s+(\d+)$/);
    if (conMatch) {
      curCon = {
        kind: conMatch[1] as 'PLine' | 'ELine',
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
  const elPnKey = side === 'L' ? 'ACTUATION_L_EL_PN' : 'ACTUATION_R_EL_PN';
  const meKey = side === 'L' ? 'ACTUATION_L_ME' : 'ACTUATION_R_ME';
  const maKey = side === 'L' ? 'ACTUATION_L_MA' : 'ACTUATION_R_MA';

  const spring = getBoolProp(props, springKey);
  const elPn = getScalarProp(props, elPnKey) ?? '';
  const me = getScalarProp(props, meKey) ?? '';
  const ma = getScalarProp(props, maKey) ?? '';

  if (elPn.includes('PE1') || solenoidLabel) {
    return { type: 'solenoid', ...(solenoidLabel ? { label: solenoidLabel } : {}) };
  }
  if (elPn.includes('PE2')) {
    return { type: 'pneumatic_pilot' };
  }
  if ((me && !me.endsWith('N')) || rollerLabel) {
    return { type: 'roller', ...(rollerLabel ? { label: rollerLabel } : {}) };
  }
  if (ma && !ma.endsWith('N')) {
    if (ma.includes('4F')) {
      return { type: 'detent' };
    }
    return { type: 'pushbutton' };
  }
  if (spring) {
    return { type: 'spring' };
  }
  return { type: 'none' };
}

function gateNumberToPortName(type: string, gateNum: number): string | undefined {
  switch (type) {
    case 'air_source':
      return gateNum === 1 ? '1' : undefined;
    case 'air_service_unit':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : undefined;
    case 'pneumatic_junction':
    case 'electrical_junction':
      return gateNum >= 1 && gateNum <= 4 ? String(gateNum) : undefined;
    case 'cylinder_single_acting':
      return gateNum === 1 ? 'A' : undefined;
    case 'cylinder_double_acting':
      return gateNum === 1 ? 'A' : gateNum === 2 ? 'B' : undefined;
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
    case 'flow_control_one_way':
    case 'pressure_regulator':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : undefined;
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
    case 'exhaust_silencer':
      return gateNum === 1 ? '1' : undefined;
    default:
      return String(gateNum);
  }
}

function portNameToGateNumber(type: string, portName: string): number {
  switch (type) {
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
      return portName === 'B' ? 2 : 1;
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
    components: doc.components.map((c) => ({
      id: c.id,
      type: c.type,
      label: c.label ?? null,
      params: c.params,
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
  const cylinderNodes: Array<{ node: ComponentNode; cx: number; cy: number }> = [];
  const preservedDecorativeObjects: string[] = [];

  // Track which port objects (by 0-based index) are actually wired via CON/line
  const connectedPortObjIndices = new Set<number>();
  for (const con of ast.connections) {
    connectedPortObjIndices.add(con.portObjA);
    connectedPortObjIndices.add(con.portObjB);
  }

  // Title heuristic: first `text` object or filename
  let detectedTitle = '';
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
      const txt = getScalarProp(obj.props, 'text');
      if (!detectedTitle && txt && txt.trim().length > 0) {
        detectedTitle = txt.trim();
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

    const layout = {
      x: Math.round((obj.x1 / FS_UNIT_PER_MM) * 10) / 10,
      y: Math.round((obj.y1 / FS_UNIT_PER_MM) * 10) / 10,
      rotationDeg: normalizeRotation(obj.rot),
      flipped: obj.flip !== 0,
    };

    const rawMetadata: Record<string, unknown> = {
      fluidsimClass: obj.cls,
      fluidsimObjId: obj.objId,
    };

    let node: ComponentNode | null = null;

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
        layout,
        rawMetadata,
      };
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
    } else if (obj.cls === 'PPE2' || obj.cls === 'CompressorFixedP') {
      const nominalPressureBar =
        obj.cls === 'CompressorFixedP'
          ? getNumberProp(obj.props, 'P_LIM', 6.0)
          : getNumberProp(obj.props, 'P_SOLL', 6.0);
      node = {
        id,
        type: 'air_service_unit',
        params: { nominalPressureBar },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PTriconnection') {
      node = {
        id,
        type: 'pneumatic_junction',
        params: {},
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
        layout,
        rawMetadata,
      };
      cylinderNodes.push({
        node,
        cx: (obj.x1 + obj.x2) / 2,
        cy: (obj.y1 + obj.y2) / 2,
      });
    } else if (obj.cls === 'WV_3' || obj.cls === 'WV_5') {
      const is32 = obj.cls === 'WV_3';
      const bodyCount = getNumberProp(obj.props, 'BODY_COUNT', 2);
      const type = is32 ? 'valve_3_2' : bodyCount === 3 ? 'valve_5_3' : 'valve_5_2';

      const ueGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'UEConnection');
      const umGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'UMConnection');
      const leftSol = ueGates[0] ? getScalarProp(objByIdx.get(ueGates[0].childId)?.props ?? [], 'label') : undefined;
      const rightSol = ueGates[1] ? getScalarProp(objByIdx.get(ueGates[1].childId)?.props ?? [], 'label') : undefined;
      const leftRol = umGates[0] ? getScalarProp(objByIdx.get(umGates[0].childId)?.props ?? [], 'label') : undefined;
      const rightRol = umGates[1] ? getScalarProp(objByIdx.get(umGates[1].childId)?.props ?? [], 'label') : undefined;

      const leftActuation = mapValveActuationSide(obj.props, 'L', leftSol, leftRol);
      const rightActuation = mapValveActuationSide(obj.props, 'R', rightSol, rightRol);
      const nominalFlowLMin = getNumberProp(obj.props, 'NN_FLOW', is32 ? 120 : 500);
      const lbl = getScalarProp(obj.props, 'label');

      const normalState = getScalarProp(obj.props, '_MCP_NORMAL_STATE') === 'NO' ? 'NO' : 'NC';
      const initialState = getScalarProp(obj.props, '_MCP_INITIAL_STATE') === 'left' ? 'left' : 'right';
      const centerTypeRaw = getScalarProp(obj.props, '_MCP_CENTER_TYPE');
      const centerType =
        centerTypeRaw === 'exhausted' || centerTypeRaw === 'pressurized' ? centerTypeRaw : 'closed';

      node = {
        id,
        type,
        ...(lbl ? { label: lbl } : {}),
        params: is32
          ? { normalState, nominalFlowLMin }
          : bodyCount === 3
            ? { centerType, nominalFlowLMin }
            : { initialState, nominalFlowLMin },
        leftActuation,
        rightActuation,
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'DV_P1' || obj.cls === 'CheckValveP') {
      const level = obj.cls === 'CheckValveP' ? 100 : getNumberProp(obj.props, 'LEVEL', 50);
      const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
      const freeFlowDirection = getScalarProp(obj.props, '_MCP_FREE_FLOW') === '2_to_1' ? '2_to_1' : '1_to_2';
      node = {
        id,
        type: 'flow_control_one_way',
        params: { openingPct, freeFlowDirection },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'pol2') {
      node = { id, type: 'power_24v', params: { voltageV: 24 }, layout, rawMetadata };
    } else if (obj.cls === 'pol1') {
      node = { id, type: 'power_0v', params: {}, layout, rawMetadata };
    } else if (obj.cls === 'ETriconnection') {
      node = { id, type: 'electrical_junction', params: {}, layout, rawMetadata };
    } else if (obj.cls === 'E_S011' || obj.cls === 'E_S031') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pushbutton_no',
        ...(lbl ? { label: lbl } : {}),
        params: { detent: obj.cls === 'E_S031' },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_S012') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'pushbutton_nc',
        ...(lbl ? { label: lbl } : {}),
        params: { detent: getBoolProp(obj.props, '_MCP_DETENT') },
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_S001' || obj.cls === 'E_S002') {
      const lbl = getScalarProp(obj.props, 'label');
      const switchType = getNumberProp(obj.props, 'SWITCH_TYPE', 0);
      const isLimit = switchType === 1 || (lbl !== undefined && allMarkerLabels.has(lbl));
      const isNc = obj.cls === 'E_S002';
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
    } else if (obj.cls === 'E_K001') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'relay_coil',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_K008') {
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
    } else if (obj.cls === 'E_P010') {
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
    } else if (obj.cls === 'E_Y001') {
      const lbl = getScalarProp(obj.props, 'label');
      node = {
        id,
        type: 'valve_solenoid',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'lampe') {
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

  for (const con of ast.connections) {
    const pA = parentByChild.get(con.portObjA);
    const pB = parentByChild.get(con.portObjB);
    if (!pA || !pB) continue;

    const compIdA = compIdByObjIdx.get(pA.parentId);
    const compIdB = compIdByObjIdx.get(pB.parentId);
    const typeA = compTypeByObjIdx.get(pA.parentId);
    const typeB = compTypeByObjIdx.get(pB.parentId);
    if (!compIdA || !compIdB || !typeA || !typeB) continue;

    const clsA = objByIdx.get(pA.parentId)?.cls;
    const clsB = objByIdx.get(pB.parentId)?.cls;
    const portA =
      clsA === 'CompressorFixedP'
        ? pA.gateNum === 1
          ? '2'
          : pA.gateNum === 2
            ? '1'
            : undefined
        : gateNumberToPortName(typeA, pA.gateNum);
    const portB =
      clsB === 'CompressorFixedP'
        ? pB.gateNum === 1
          ? '2'
          : pB.gateNum === 2
            ? '1'
            : undefined
        : gateNumberToPortName(typeB, pB.gateNum);
    if (!portA || !portB) continue;

    const portObjA = objByIdx.get(con.portObjA);
    const domain: 'pneumatic' | 'electrical' =
      con.kind === 'PLine'
        ? 'pneumatic'
        : con.kind === 'ELine'
          ? 'electrical'
          : portObjA?.cls === 'PConnection'
            ? 'pneumatic'
            : 'electrical';

    const customEdgeId = getScalarProp(con.props, '_MCP_EDGE_ID');
    const edgeId = allocEdgeId(customEdgeId || `E_${con.portObjA}_${con.portObjB}`);
    connections.push({
      id: edgeId,
      from: { componentId: compIdA, port: portA },
      to: { componentId: compIdB, port: portB },
      domain,
    });
  }

  // Synthesize exhaust_silencer nodes for unconnected valve exhaust PConnections marked EX3
  for (let objIdx = 0; objIdx < ast.objects.length; objIdx++) {
    const obj = ast.objects[objIdx];
    if (obj.cls !== 'PConnection') continue;
    if (connectedPortObjIndices.has(objIdx)) continue;
    const exType = getScalarProp(obj.props, 'ex_type');
    if (exType !== 'EX3') continue;

    const owner = parentByChild.get(objIdx);
    if (!owner) continue;
    const ownerCompId = compIdByObjIdx.get(owner.parentId);
    const ownerType = compTypeByObjIdx.get(owner.parentId);
    if (!ownerCompId || !ownerType) continue;
    const ownerPort = gateNumberToPortName(ownerType, owner.gateNum);
    if (!ownerPort) continue;

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
      rawMetadata: { embeddedExType: 'EX3', ownerPortObjId: obj.objId },
    });
    connections.push({
      id: exhEdgeId,
      from: { componentId: ownerCompId, port: ownerPort },
      to: { componentId: exhId, port: '1' },
      domain: 'pneumatic',
    });
  }

  const fallbackTitle = filePath
    ? filePath.replace(/^.*[\\/]/, '').replace(/\.ct$/i, '')
    : 'FluidSIM 4.5 Circuit';

  const metadata = {
    title: detectedTitle || fallbackTitle,
    fluidsimVersion: '4.5' as const,
    format: 'fluidsim-4.5-ct' as const,
    sheetWidthMm: 297,
    sheetHeightMm: 210,
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
  const elPnKey = side === 'L' ? 'ACTUATION_L_EL_PN' : 'ACTUATION_R_EL_PN';
  const meKey = side === 'L' ? 'ACTUATION_L_ME' : 'ACTUATION_R_ME';
  const maKey = side === 'L' ? 'ACTUATION_L_MA' : 'ACTUATION_R_MA';

  const type = act?.type ?? 'none';
  const isSpring = type === 'spring';
  const elPn = type === 'solenoid' ? `${prefix}_PE1` : type === 'pneumatic_pilot' ? `${prefix}_PE2` : `${prefix}N`;
  const me = type === 'roller' || type === 'idle_return_roller' ? `${prefix}_ME2` : `${prefix}N`;
  const ma =
    type === 'detent'
      ? `${prefix}_MA4F`
      : type === 'pushbutton'
        ? `${prefix}_MA5`
        : `${prefix}N`;

  return [
    ` S ${springKey}_FEST B T`,
    ` S ${springKey} S ${isSpring ? 'TRUE' : 'FALSE'}`,
    ` S ${elPnKey}_FEST B T`,
    ` S ${elPnKey} S ${elPn}`,
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

  // Fresh or patched authoring path -> emit valid FluidSIM 4.5 .ct text objects & connections
  let nextObjId = 0;
  const allocObjId = () => nextObjId++;

  const objectBlocks: string[] = [];
  const gateLines: string[] = [];
  const connectionBlocks: string[] = [];

  // Identify exhaust_silencer components attached to a single valve exhaust port -> embed as EX3!
  const embeddedExhaustByValvePort = new Map<string, { exhId: string; edgeId: string }>();
  const embeddedExhaustCompIds = new Set<string>();
  const embeddedExhaustEdgeIds = new Set<string>();

  const compById = new Map(document.components.map((c) => [c.id, c]));
  for (const edge of document.connections) {
    const cFrom = compById.get(edge.from.componentId);
    const cTo = compById.get(edge.to.componentId);
    if (!cFrom || !cTo) continue;

    if (cTo.type === 'exhaust_silencer' && (cFrom.type === 'valve_3_2' || cFrom.type === 'valve_5_2' || cFrom.type === 'valve_5_3')) {
      const key = `${cFrom.id}:${edge.from.port}`;
      if (!embeddedExhaustByValvePort.has(key)) {
        embeddedExhaustByValvePort.set(key, { exhId: cTo.id, edgeId: edge.id });
        embeddedExhaustCompIds.add(cTo.id);
        embeddedExhaustEdgeIds.add(edge.id);
      }
    } else if (cFrom.type === 'exhaust_silencer' && (cTo.type === 'valve_3_2' || cTo.type === 'valve_5_2' || cTo.type === 'valve_5_3')) {
      const key = `${cTo.id}:${edge.to.port}`;
      if (!embeddedExhaustByValvePort.has(key)) {
        embeddedExhaustByValvePort.set(key, { exhId: cFrom.id, edgeId: edge.id });
        embeddedExhaustCompIds.add(cFrom.id);
        embeddedExhaustEdgeIds.add(edge.id);
      }
    }
  }

  // Map "<compId>:<portName>" -> FluidSIM port object ID
  const portObjIdMap = new Map<string, number>();

  for (const comp of document.components) {
    if (embeddedExhaustCompIds.has(comp.id)) continue;

    const parentId = allocObjId();
    const xMm = comp.layout?.x ?? 40;
    const yMm = comp.layout?.y ?? 40;
    const x1 = Math.round(xMm * FS_UNIT_PER_MM);
    const y1 = Math.round(yMm * FS_UNIT_PER_MM);
    const x2 = x1 + 24 * FS_UNIT_PER_MM;
    const y2 = y1 + 24 * FS_UNIT_PER_MM;
    const rot = comp.layout?.rotationDeg ?? 0;
    const flip = comp.layout?.flipped ? 1 : 0;

    const addPortObj = (
      gateNum: number,
      cls: 'PConnection' | 'EConnection' | 'UEConnection' | 'UMConnection',
      portName?: string,
      extraProps: string[] = [],
    ): number => {
      const pid = allocObjId();
      const portDef = portName ? getPortDefinition(comp.type, portName) : undefined;
      const offX = portDef ? Math.round(portDef.offset.x * FS_UNIT_PER_MM) : gateNum * 3072;
      const offY = portDef ? Math.round(portDef.offset.y * FS_UNIT_PER_MM) : 0;
      const px1 = x1 + offX - 2048;
      const py1 = y1 + offY - 2048;
      const px2 = x1 + offX + 2048;
      const py2 = y1 + offY + 2048;
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
      const embedded = embeddedExhaustByValvePort.get(`${comp.id}:${portName}`);
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
      return [
        ' S ex_type_FEST B T',
        ' S ex_type S EX0',
        ' S R_H_FEST B T',
        ' S R_H F 0',
      ];
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
        objectBlocks.push(
          [
            `PPE2 O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 3527683`,
            idProp,
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
        const lines = [
          `CylDGPPAB O${parentId} ${x1} ${y1} ${x1 + 57344} ${y1 + 32768} ${rot} ${flip} 4986883`,
          idProp,
          ...labelProp,
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
        addPortObj(1, 'PConnection', 'A', pPortProps('A'));
        if (!isSac) {
          addPortObj(2, 'PConnection', 'B', pPortProps('B'));
        }
        if (comp.distanceRule && comp.distanceRule.length > 0) {
          const drId = allocObjId();
          const drLines = [
            `R_SCHALT O${drId} ${x1 + 10240} ${y1 - 24576} ${x1 + 40960} ${y1 - 12288} 0 0 4253703`,
            ` S _MCP_OWNER_ID S ${comp.id}`,
          ];
          comp.distanceRule.forEach((m, idx) => {
            drLines.push(` S label${idx} S ${m.label}`);
            drLines.push(` S pos${idx} F ${m.positionMm}`);
            drLines.push(` S pos_l_${idx} F ${m.positionMm}`);
            drLines.push(` S pos_r_${idx} F ${m.positionMm}`);
          });
          objectBlocks.push(drLines.join('\n'));
        }
        break;
      }
      case 'valve_3_2': {
        const flow = Number(comp.params.nominalFlowLMin ?? 120);
        const normalState = comp.params.normalState === 'NO' ? 'NO' : 'NC';
        objectBlocks.push(
          [
            `WV_3 O${parentId} ${x1} ${y1} ${x1 + 86016} ${y1 + 36864} ${rot} ${flip} 1617923`,
            idProp,
            ...labelProp,
            ' S description_FEST B T',
            ' S description S 3/n Way Valve',
            ' S BODY_COUNT I 2',
            ` S NN_FLOW F ${flow}`,
            ...(normalState === 'NO' ? [' S _MCP_NORMAL_STATE S NO'] : []),
            ...getFluidSimActuationProps('L', comp.leftActuation),
            ...getFluidSimActuationProps('R', comp.rightActuation),
          ].join('\n'),
        );
        addPortObj(1, 'PConnection', '2', pPortProps('2'));
        addPortObj(2, 'PConnection', '1', pPortProps('1'));
        addPortObj(3, 'PConnection', '3', pPortProps('3'));
        addPortObj(4, 'PConnection', '12', pPortProps('12'));
        addPortObj(5, 'PConnection', '10', pPortProps('10'));
        addPortObj(
          6,
          'UEConnection',
          undefined,
          comp.leftActuation?.type === 'solenoid' && comp.leftActuation.label
            ? [` S label S ${comp.leftActuation.label}`]
            : [],
        );
        addPortObj(
          7,
          'UEConnection',
          undefined,
          comp.rightActuation?.type === 'solenoid' && comp.rightActuation.label
            ? [` S label S ${comp.rightActuation.label}`]
            : [],
        );
        addPortObj(
          8,
          'UMConnection',
          undefined,
          comp.leftActuation?.type === 'roller' && comp.leftActuation.label
            ? [` S label S ${comp.leftActuation.label}`]
            : [' S state INT 4'],
        );
        addPortObj(
          9,
          'UMConnection',
          undefined,
          comp.rightActuation?.type === 'roller' && comp.rightActuation.label
            ? [` S label S ${comp.rightActuation.label}`]
            : [' S state INT 4'],
        );
        break;
      }
      case 'valve_5_2':
      case 'valve_5_3': {
        const flow = Number(comp.params.nominalFlowLMin ?? 500);
        const bodyCount = comp.type === 'valve_5_3' ? 3 : 2;
        const initialState = comp.params.initialState === 'left' ? 'left' : 'right';
        const centerType = String(comp.params.centerType ?? 'closed');
        objectBlocks.push(
          [
            `WV_5 O${parentId} ${x1} ${y1} ${x1 + 110592} ${y1 + 36864} ${rot} ${flip} 5109763`,
            idProp,
            ...labelProp,
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
        addPortObj(
          8,
          'UEConnection',
          undefined,
          comp.leftActuation?.type === 'solenoid' && comp.leftActuation.label
            ? [` S label S ${comp.leftActuation.label}`]
            : [],
        );
        addPortObj(
          9,
          'UEConnection',
          undefined,
          comp.rightActuation?.type === 'solenoid' && comp.rightActuation.label
            ? [` S label S ${comp.rightActuation.label}`]
            : [],
        );
        addPortObj(
          10,
          'UMConnection',
          undefined,
          comp.leftActuation?.type === 'roller' && comp.leftActuation.label
            ? [` S label S ${comp.leftActuation.label}`]
            : [' S state INT 4'],
        );
        addPortObj(
          11,
          'UMConnection',
          undefined,
          comp.rightActuation?.type === 'roller' && comp.rightActuation.label
            ? [` S label S ${comp.rightActuation.label}`]
            : [' S state INT 4'],
        );
        break;
      }
      case 'flow_control_one_way': {
        const openingPct = Number(comp.params.openingPct ?? 50);
        const freeFlow = comp.params.freeFlowDirection === '2_to_1' ? '2_to_1' : '1_to_2';
        objectBlocks.push(
          [
            `DV_P1 O${parentId} ${x1} ${y1} ${x1 + 15360} ${y1 + 43008} ${rot} ${flip} 6940243`,
            idProp,
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
      case 'power_24v': {
        objectBlocks.push(
          [`pol2 O${parentId} ${x1} ${y1} ${x1 + 18432} ${y1 + 12288} ${rot} ${flip} 4126728`, idProp].join('\n'),
        );
        addPortObj(1, 'EConnection', 'OUT');
        break;
      }
      case 'power_0v': {
        objectBlocks.push(
          [`pol1 O${parentId} ${x1} ${y1} ${x1 + 18432} ${y1 + 12288} ${rot} ${flip} 184328`, idProp].join('\n'),
        );
        addPortObj(1, 'EConnection', 'IN');
        break;
      }
      case 'electrical_junction': {
        objectBlocks.push(
          [`ETriconnection O${parentId} ${x1} ${y1} ${x1 + 12288} ${y1 + 12288} ${rot} ${flip} 4321283`, idProp].join('\n'),
        );
        for (let g = 1; g <= 4; g++) {
          addPortObj(g, 'EConnection', String(g));
        }
        break;
      }
      case 'pushbutton_no': {
        const cls = comp.params.detent ? 'E_S031' : 'E_S011';
        objectBlocks.push(
          [`${cls} O${parentId} ${x1} ${y1} ${x1 + 15360} ${y1 + 30720} ${rot} ${flip} 4142088`, idProp, ...labelProp].join(
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
            `E_S012 O${parentId} ${x1} ${y1} ${x1 + 15360} ${y1 + 30720} ${rot} ${flip} 4454408`,
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
            `E_S001 O${parentId} ${x1} ${y1} ${x1 + 12288} ${y1 + 30720} ${rot} ${flip} 3665928`,
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
            `E_S002 O${parentId} ${x1} ${y1} ${x1 + 12288} ${y1 + 30720} ${rot} ${flip} 1472008`,
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
          [`E_K001 O${parentId} ${x1} ${y1} ${x1 + 24576} ${y1 + 30720} ${rot} ${flip} 645133`, idProp, ...labelProp].join(
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
            `E_K008 O${parentId} ${x1} ${y1} ${x1 + 36864} ${y1 + 30720} ${rot} ${flip} 1105928`,
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
            `E_P010 O${parentId} ${x1} ${y1} ${x1 + 43008} ${y1 + 30720} ${rot} ${flip} 2508808`,
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
          [`E_Y001 O${parentId} ${x1} ${y1} ${x1 + 39936} ${y1 + 30720} ${rot} ${flip} 9113608`, idProp, ...labelProp].join(
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
            `lampe O${parentId} ${x1} ${y1} ${x1 + 12288} ${y1 + 30720} ${rot} ${flip} 4126728`,
            idProp,
            ` S sig_color I ${rgb}`,
            ...labelProp,
          ].join('\n'),
        );
        addPortObj(1, 'EConnection', 'X1');
        addPortObj(2, 'EConnection', 'X2');
        break;
      }
      default: {
        // Unverified catalog extension types (e.g., shuttle_valve_or, dual_pressure_valve_and, timer_relay_off_delay, standalone exhaust_silencer)
        // Stored with explicit _MCP_TYPE and _MCP_PARAMS metadata so roundtrips remain 100% lossless!
        const isElec =
          comp.type.startsWith('relay_') ||
          comp.type.startsWith('timer_relay_') ||
          comp.type.startsWith('proximity_');
        const baseCls = isElec ? 'E_K001' : 'PTriconnection';
        const paramsB64 = Buffer.from(JSON.stringify(comp.params), 'utf8').toString('base64');
        const actLProp = comp.leftActuation
          ? [` S _MCP_ACT_L S ${Buffer.from(JSON.stringify(comp.leftActuation), 'utf8').toString('base64')}`]
          : [];
        const actRProp = comp.rightActuation
          ? [` S _MCP_ACT_R S ${Buffer.from(JSON.stringify(comp.rightActuation), 'utf8').toString('base64')}`]
          : [];
        objectBlocks.push(
          [
            `${baseCls} O${parentId} ${x1} ${y1} ${x2} ${y2} ${rot} ${flip} 4311043`,
            idProp,
            ` S _MCP_TYPE S ${comp.type}`,
            ` S _MCP_PARAMS S ${paramsB64}`,
            ...actLProp,
            ...actRProp,
            ...labelProp,
          ].join('\n'),
        );
        // Allocate ports referenced by connections (or default gate1)
        const referencedPorts = new Set<string>();
        for (const e of document.connections) {
          if (e.from.componentId === comp.id) referencedPorts.add(e.from.port);
          if (e.to.componentId === comp.id) referencedPorts.add(e.to.port);
        }
        if (referencedPorts.size === 0) referencedPorts.add('1');
        for (const portName of referencedPorts) {
          const gNum = portNameToGateNumber(comp.type, portName);
          addPortObj(gNum, isElec ? 'EConnection' : 'PConnection', portName, isElec ? [] : pPortProps(portName));
        }
        break;
      }
    }
  }

  // Emit preserved decorative objects (CAD_RECT, text, etc.) if present from an edited native .ct file,
  // or emit a standard FluidSIM title `text` object for freshly authored .ct circuits.
  if (hasPreservedCt && preserved.preservedDecorativeObjects.length > 0) {
    for (const rawBlock of preserved.preservedDecorativeObjects) {
      // Re-index O<id> to avoid collisions with newly allocated object IDs
      const newId = allocObjId();
      const reindexed = rawBlock.replace(/^([A-Za-z0-9_]+)\s+O\d+(\s+)/, `$1 O${newId}$2`);
      objectBlocks.push(reindexed);
    }
  } else if (document.metadata.title) {
    const titleId = allocObjId();
    const safeTitle = document.metadata.title.replace(/[\r\n]+/g, ' ').trim();
    if (safeTitle.length > 0) {
      objectBlocks.push(
        [
          `text O${titleId} 10240 6144 122880 18432 0 0 1167363`,
          ` S text S ${safeTitle}`,
        ].join('\n'),
      );
    }
  }

  // Emit CON PLine / CON ELine edges (with orthogonal L polyline segments when routed)
  for (const edge of document.connections) {
    if (embeddedExhaustEdgeIds.has(edge.id)) continue;
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

  return {
    ...(hasPreservedCt
      ? {
          headerLinesB64: preserved.headerLinesB64,
          profile: preserved.profile,
          previewBlockB64: preserved.previewBlockB64,
          ...(preserved.fsPreviewBlock !== undefined ? { fsPreviewBlock: preserved.fsPreviewBlock } : {}),
          trailerText: preserved.trailerText,
        }
      : {}),
    ctBody,
  };
}
