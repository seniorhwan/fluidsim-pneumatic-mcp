import crypto from 'node:crypto';
import type {
  CircuitDocument,
  ComponentNode,
  ConnectionEdge,
  DistanceRuleMarker,
  FluidSimFlippedCode,
  ValveActuationSide,
} from '../contracts/circuit';
import type { DecodedCtContainer } from './ctBinaryCodec';
import { flippedCodeToMirror } from './ctTransform';

/**
 * Lossless FluidSIM 4.5 `.ct` text AST parser + Semantic IR bridge.
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

function getCompLabelProp(props: string[]): string | undefined {
  return getScalarProp(props, '_MCP_LABEL') ?? getScalarProp(props, 'label');
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
  const pilotKey = side === 'L' ? 'PILOT_L' : 'PILOT_R';
  const hasIntPilot =
    getBoolProp(props, intPilotKey) ||
    getBoolProp(props, pilotKey) ||
    elPn.includes('PE3') ||
    (elPn.includes('PE1') && elPn.includes('PE2'));

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
    case 'nozzle':
    case 'orifice':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : undefined;
    case 'check_valve_spring':
    case 'check_valve_pilot_open':
      return gateNum === 1 ? '1' : gateNum === 2 ? '2' : gateNum === 3 ? '12' : undefined;
    case 'pressure_relief_valve':
      return gateNum === 1 ? '1' : gateNum === 2 ? '3' : undefined;
    case 'pressure_switch_differential':
    case 'pressure_switch_pew':
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
    case 'check_valve_pilot_open':
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
    case 'pressure_switch_pew':
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
  if (rgb === 0xffff00 || rgb === 16776960 || rgb === 65535) return 'yellow';
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
  let parsedUnitPerMm = FS_UNIT_PER_MM;
  let parsedOriginX = 0;
  let parsedOriginY = 0;

  for (const obj of ast.objects) {
    if (obj.cls !== 'text' || getScalarProp(obj.props, '_MCP_LABEL_FOR')) continue;
    const upm = getNumberProp(obj.props, '_MCP_UNIT_PER_MM', NaN);
    const ox = getNumberProp(obj.props, '_MCP_ORIGIN_X', NaN);
    const oy = getNumberProp(obj.props, '_MCP_ORIGIN_Y', NaN);
    if (Number.isFinite(upm) && upm >= 512) parsedUnitPerMm = upm;
    if (Number.isFinite(ox)) parsedOriginX = ox;
    if (Number.isFinite(oy)) parsedOriginY = oy;
    break;
  }

  const rawToMmX = (rx: number): number => Math.round(((rx - parsedOriginX) / parsedUnitPerMm) * 10) / 10;
  const rawToMmY = (ry: number): number => Math.round(((ry - parsedOriginY) / parsedUnitPerMm) * 10) / 10;

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
    const flipCode = (obj.flip === 1 || obj.flip === 2 || obj.flip === 3 ? obj.flip : 0) as FluidSimFlippedCode;
    const layout = {
      x: rawToMmX(obj.x1),
      y: rawToMmY(obj.y1),
      rotationDeg: rotDeg,
      ...(flipCode !== 0 ? { flipped: flipCode, mirror: flippedCodeToMirror(flipCode) } : {}),
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

    const elecRailOwner = getScalarProp(obj.props, '_MCP_ELEC_RAIL_OWNER');
    const elecRailType = getScalarProp(obj.props, '_MCP_ELEC_RAIL_TYPE');
    if (elecRailOwner && elecRailType && (obj.cls === 'ETriconnection' || obj.cls === 'PTriconnection')) {
      compIdByObjIdx.set(objIdx, elecRailOwner);
      compTypeByObjIdx.set(objIdx, elecRailType);
      if (
        (elecRailType === 'electrical_junction' || elecRailType === 'pneumatic_junction') &&
        !manifoldIdSet.has(elecRailOwner)
      ) {
        manifoldIdSet.add(elecRailOwner);
        usedIds.add(elecRailOwner);
        components.push({
          id: elecRailOwner,
          type: elecRailType,
          params: {},
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
      const lbl = getCompLabelProp(obj.props);
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
      const lbl = getCompLabelProp(obj.props);
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
      const origRot = getNumberProp(obj.props, '_MCP_ORIG_ROT', rotDeg);
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'vacuum_suction_nozzle',
        ...(lbl ? { label: lbl } : {}),
        params: { vacuumBar, minSupplyBar },
        ...(origRot !== 0 ? { rotationDeg: normalizeRotation(origRot) } : {}),
        layout: { ...layout, rotationDeg: normalizeRotation(origRot) },
        rawMetadata,
      };
    } else if (obj.cls === 'PAV1S') {
      const gripThresholdBar = getNumberProp(obj.props, '_MCP_GRIP_BAR', -0.3);
      const lbl = getCompLabelProp(obj.props);
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
      const origRot = getNumberProp(obj.props, '_MCP_ORIG_ROT', rotDeg);
      const lbl = getCompLabelProp(obj.props);
      let distanceRule: DistanceRuleMarker[] | undefined;
      const drJson = getScalarProp(obj.props, '_MCP_DR_JSON');
      if (drJson) {
        try {
          distanceRule = JSON.parse(Buffer.from(drJson, 'base64').toString('utf8')) as DistanceRuleMarker[];
        } catch {
          distanceRule = undefined;
        }
      }
      if (!distanceRule) {
        const l1 = getScalarProp(obj.props, 'l1');
        const l2 = getScalarProp(obj.props, 'l2');
        const markers: DistanceRuleMarker[] = [];
        if (l1 && l1 !== '0') markers.push({ label: l1, positionMm: 0, toleranceMm: 2 });
        if (l2 && l2 !== '0') markers.push({ label: l2, positionMm: maxAngleDeg, toleranceMm: 2 });
        if (markers.length > 0) distanceRule = markers;
      }
      node = {
        id,
        type: 'swivel_drive',
        ...(lbl ? { label: lbl } : {}),
        params: { maxAngleDeg, initialAngleDeg, torqueNm, externalLoadNm },
        ...(distanceRule ? { distanceRule } : {}),
        ...(origRot !== 0 ? { rotationDeg: normalizeRotation(origRot) } : {}),
        layout: { ...layout, rotationDeg: normalizeRotation(origRot) },
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
      const isRodless = getBoolProp(obj.props, 'SLEDGE');
      const isSingleActing =
        !isRodless &&
        (getBoolProp(obj.props, 'SPRING_R') ||
          (getScalarProp(obj.props, 'description') ?? '').toLowerCase().includes('einfachwirkend') ||
          pGates.length <= 1);
      const strokeMm = getNumberProp(obj.props, 'HUB', isRodless ? 200 : isSingleActing ? 50 : 100);
      const areaCapCm2 = getNumberProp(obj.props, 'A_K', 3.14159);
      const areaRingCm2 = getNumberProp(obj.props, 'A_R', 2.63894);
      const pistonDiameterMm = Math.max(6, Math.round(20 * Math.sqrt(Math.max(0.1, areaCapCm2) / Math.PI)));
      const rodAreaCm2 = Math.max(0.03, areaCapCm2 - areaRingCm2);
      const rodDiameterMm = Math.max(2, Math.round(20 * Math.sqrt(rodAreaCm2 / Math.PI)));
      const externalLoadN = Math.max(0, getNumberProp(obj.props, 'F', 0));
      const initialPositionMm = Math.max(0, getNumberProp(obj.props, 'S', 0));
      const lbl = getCompLabelProp(obj.props);

      const springForceN = getNumberProp(obj.props, '_MCP_SPRING_N', 25);
      node = {
        id,
        type: isRodless
          ? 'cylinder_rodless'
          : isSingleActing
            ? 'cylinder_single_acting'
            : 'cylinder_double_acting',
        ...(lbl ? { label: lbl } : {}),
        params: isRodless
          ? { strokeMm, pistonDiameterMm, externalLoadN, initialPositionMm }
          : isSingleActing
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
    } else if (obj.cls === 'PAR2') {
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'air_motor',
        ...(lbl ? { label: lbl } : {}),
        params: { displacementCc: getNumberProp(obj.props, '_MCP_DISP_CC', 10) },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
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
      const lbl = getCompLabelProp(obj.props);

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
      const lbl = getCompLabelProp(obj.props);
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
        node = {
          id,
          type: 'throttle_valve',
          ...(lbl ? { label: lbl } : {}),
          params: { openingPct },
          ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
          layout,
          rawMetadata,
        };
      }
    } else if (obj.cls === 'DRSV1_pneu') {
      const level = getNumberProp(obj.props, 'LEVEL', 50);
      const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'throttle_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { openingPct },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'NozzleP') {
      const level = getNumberProp(obj.props, 'LEVEL', 50);
      const openingPct = Math.max(1, Math.min(100, level > 0 ? level : 50));
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'nozzle',
        ...(lbl ? { label: lbl } : {}),
        params: { openingPct },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CheckValveP') {
      const crackingPressureBar = getNumberProp(obj.props, 'P_V', 0.1);
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'check_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { crackingPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CheckValveSpringLoadedP') {
      const crackingPressureBar = getNumberProp(obj.props, 'P_V', 0.3);
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'check_valve_spring',
        ...(lbl ? { label: lbl } : {}),
        params: { crackingPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'CheckValvePilotOperatedSpringLoadedP') {
      const crackingPressureBar = getNumberProp(obj.props, 'P_V', 0.2);
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'check_valve_pilot_open',
        ...(lbl ? { label: lbl } : {}),
        params: { crackingPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PVS1') {
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'dual_pressure_valve_and',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PVS2') {
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'quick_exhaust_valve',
        ...(lbl ? { label: lbl } : {}),
        params: {},
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PVS3') {
      const lbl = getCompLabelProp(obj.props);
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
      const lbl = getCompLabelProp(obj.props);
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
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'pressure_regulator',
        ...(lbl ? { label: lbl } : {}),
        params: { setPressureBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PEW') {
      const pGates = objGates.filter((g) => objByIdx.get(g.childId)?.cls === 'PConnection');
      const isSinglePort = pGates.length <= 1;
      const pressureBar = getNumberProp(obj.props, 'P_SOLL', isSinglePort ? 2.5 : -0.5);
      const hysteresisBar = getNumberProp(obj.props, '_MCP_HYST', 0.05);
      const triggerModeRaw = getScalarProp(obj.props, '_MCP_TRIG_MODE');
      const triggerMode =
        triggerModeRaw === 'above' || triggerModeRaw === 'below' ? triggerModeRaw : 'auto';
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: isSinglePort ? 'pressure_switch_pew' : 'pressure_switch_differential',
        ...(lbl ? { label: lbl } : {}),
        params: { pressureBar, hysteresisBar, triggerMode },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'PSW1') {
      const pressureBar = getNumberProp(obj.props, 'P_SOLL', -0.5);
      const hysteresisBar = getNumberProp(obj.props, '_MCP_HYST', 0.05);
      const triggerModeRaw = getScalarProp(obj.props, '_MCP_TRIG_MODE');
      const triggerMode =
        triggerModeRaw === 'above' || triggerModeRaw === 'below' ? triggerModeRaw : 'auto';
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'pressure_switch_differential',
        ...(lbl ? { label: lbl } : {}),
        params: { pressureBar, hysteresisBar, triggerMode },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (
      obj.cls === 'PressureIndicatorP' ||
      obj.cls === 'PressureGaugeP' ||
      obj.cls === 'ManometerP' ||
      obj.cls === 'PM1'
    ) {
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'pressure_gauge',
        ...(lbl ? { label: lbl } : {}),
        params: { minBar: -1, maxBar: 10 },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'AccPneu1' || obj.cls === 'ReservoirP' || obj.cls === 'AirTankP') {
      const volumeL = getNumberProp(obj.props, 'V', 1.0);
      const lbl = getCompLabelProp(obj.props);
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
    } else if (
      obj.cls === 'TimerClosedP' ||
      obj.cls === 'TimerOpenP' ||
      obj.cls === 'TimeDelayValveP' ||
      obj.cls === 'VZ_NC' ||
      obj.cls === 'VZ_NO'
    ) {
      const delayMs = Math.max(10, Math.round(getNumberProp(obj.props, 'DELAY_TIME', 10) * 100));
      const normalState = obj.cls === 'VZ_NO' || obj.cls === 'TimerOpenP' ? 'NO' : 'NC';
      const lbl = getCompLabelProp(obj.props);
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
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'pressure_sequence_valve',
        ...(lbl ? { label: lbl } : {}),
        params: { thresholdBar },
        ...(rotDeg !== 0 ? { rotationDeg: rotDeg } : {}),
        layout,
        rawMetadata,
      };
    } else if (obj.cls === 'E_B001') {
      const lbl = getCompLabelProp(obj.props);
      node = {
        id,
        type: 'proximity_switch_magnetic',
        ...(lbl ? { label: lbl } : {}),
        params: { normalState: getScalarProp(obj.props, '_MCP_NORMAL_STATE') === 'NC' ? 'NC' : 'NO' },
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
      const isDetent =
        obj.cls === 'E_S031' ||
        obj.cls === 'E_S021' ||
        obj.cls === 'LSchalter_s' ||
        getBoolProp(obj.props, '_MCP_DETENT');
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
      // Restore v2 mirror / flipped / group / sectionLabel metadata
      const flipVal = (obj.flip === 1 || obj.flip === 2 || obj.flip === 3 ? obj.flip : 0) as FluidSimFlippedCode;
      if (flipVal !== 0) {
        node.flipped = flipVal;
        node.mirror = flippedCodeToMirror(flipVal);
      }
      const secLbl = getScalarProp(obj.props, '_MCP_SECTION_LABEL');
      if (secLbl) node.sectionLabel = secLbl;
      const grp = getScalarProp(obj.props, '_MCP_GROUP');
      if (grp) node.group = grp;

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
    waypoints?: Array<{ x: number; y: number }>,
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
      ...(waypoints && waypoints.length >= 2 ? { waypoints } : {}),
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

      const portObjForRail = objByIdx.get(endpointIdx);
      const elecRailPort = portObjForRail ? getScalarProp(portObjForRail.props, '_MCP_ELEC_RAIL_PORT') : undefined;
      if (elecRailPort) {
        return { compId, port: elecRailPort, cls: parentObj?.cls ?? '', portObj: portObjForRail };
      }

      let port: string | undefined;
      if (parentObj?.cls === 'CompressorFixedP') {
        port = p.gateNum === 1 ? '2' : p.gateNum === 2 ? '1' : undefined;
      } else if (parentObj?.cls === 'PAV1') {
        const pCount = (gatesByParent.get(p.parentId) ?? []).filter(
          (g) => objByIdx.get(g.childId)?.cls === 'PConnection',
        ).length;
        if (pCount === 2) {
          port = p.gateNum === 1 ? '1' : p.gateNum === 2 ? '1v' : undefined;
        } else {
          port = gateNumberToPortName(compType, p.gateNum);
        }
      } else {
        port = gateNumberToPortName(compType, p.gateNum);
      }
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

  const extractPortObjSegments = (
    portObj: RawCtObject | undefined,
  ): Array<{ x1: number; y1: number; x2: number; y2: number }> => {
    if (!portObj) return [];
    const cx = Math.round((portObj.x1 + portObj.x2) / 2);
    const cy = Math.round((portObj.y1 + portObj.y2) / 2);
    const out: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const pl of portObj.props) {
      const lm = pl.match(/^\s*L\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
      if (!lm) continue;
      out.push({
        x1: cx + Number(lm[1]) - 5120,
        y1: cy + Number(lm[2]) - 5120,
        x2: cx + Number(lm[3]) + 5120,
        y2: cy + Number(lm[4]) + 5120,
      });
    }
    return out;
  };

  for (const con of ast.connections) {
    if (getBoolProp(con.props, '_MCP_MANIFOLD_LINK')) continue;
    const epA = resolveEndpoint(con.portObjA);
    const epB = resolveEndpoint(con.portObjB);
    const segs: Array<{ x1: number; y1: number; x2: number; y2: number }> = [];
    for (const pl of con.props) {
      const m = pl.match(/^\s*L\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)/);
      if (m) {
        segs.push({ x1: Number(m[1]), y1: Number(m[2]), x2: Number(m[3]), y2: Number(m[4]) });
      }
    }
    if (!epA || !epB) continue;

    // FluidSIM 4.5 stores routed orthogonal wire segments (`L dx1 dy1 dx2 dy2`) on portObjA.props
    const portSegs =
      segs.length > 0
        ? segs
        : extractPortObjSegments(epA.portObj).length > 0
          ? extractPortObjSegments(epA.portObj)
          : extractPortObjSegments(epB.portObj);

    const domain: 'pneumatic' | 'electrical' =
      con.kind === 'PLine'
        ? 'pneumatic'
        : con.kind === 'ELine'
          ? 'electrical'
          : epA.portObj?.cls === 'PConnection'
            ? 'pneumatic'
            : 'electrical';

    let waypoints: Array<{ x: number; y: number }> | undefined;
    if (portSegs.length > 0) {
      const pts: Array<{ x: number; y: number }> = [{ x: rawToMmX(portSegs[0].x1), y: rawToMmY(portSegs[0].y1) }];
      for (const s of portSegs) {
        const p1 = { x: rawToMmX(s.x1), y: rawToMmY(s.y1) };
        const p2 = { x: rawToMmX(s.x2), y: rawToMmY(s.y2) };
        const last = pts[pts.length - 1];
        if (Math.hypot(p1.x - last.x, p1.y - last.y) > 0.15) {
          pts.push(p1);
        }
        if (Math.hypot(p2.x - pts[pts.length - 1].x, p2.y - pts[pts.length - 1].y) > 0.15) {
          pts.push(p2);
        }
      }
      if (pts.length >= 2) waypoints = pts;
    }

    const customEdgeId = getScalarProp(con.props, '_MCP_EDGE_ID');
    recordEdge(
      epA.compId,
      epA.port,
      epB.compId,
      epB.port,
      domain,
      customEdgeId || `E_${con.portObjA}_${con.portObjB}`,
      waypoints,
    );
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
          x: rawToMmX(obj.x1),
          y: rawToMmY(obj.y1),
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
          x: rawToMmX(obj.x1),
          y: rawToMmY(obj.y1),
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

  // Synthesize embedded exhaust_silencer on PAV1 port 3 (when PAV1 uses 2-gate native GDI layout)
  for (let objIdx = 0; objIdx < ast.objects.length; objIdx++) {
    const obj = ast.objects[objIdx];
    if (obj.cls !== 'PAV1') continue;
    const exh3Id = getScalarProp(obj.props, '_MCP_EXH_3_ID');
    if (!exh3Id) continue;
    const ownerCompId = compIdByObjIdx.get(objIdx);
    if (!ownerCompId) continue;
    const exh3EdgeId = getScalarProp(obj.props, '_MCP_EXH_3_EDGE_ID');
    const exhId = allocId(exh3Id);
    const exhEdgeId = allocEdgeId(exh3EdgeId || `E_EXH_${ownerCompId}_3`);
    components.push({
      id: exhId,
      type: 'exhaust_silencer',
      params: {},
      layout: {
        x: rawToMmX(obj.x2),
        y: rawToMmY(obj.y1),
      },
      rawMetadata: { embeddedExType: 'EX3', ownerPortObjId: obj.objId },
    });
    connections.push({
      id: exhEdgeId,
      from: { componentId: ownerCompId, port: '3' },
      to: { componentId: exhId, port: '1' },
      domain: 'pneumatic',
    });
  }

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

export {
  serializeDocumentToCtContainer,
  verifyCtTextInvariants,
  verifyCtVisualLayoutInvariants,
  type CtTextInvariantReport,
  type CtVisualLayoutInvariantReport,
} from './ctTextCompiler';
