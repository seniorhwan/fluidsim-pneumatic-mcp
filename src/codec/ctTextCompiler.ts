/**
 * Prototype-Driven FluidSIM 4.5 `.ct` Compiler & F6/F9 Invariant Verifier (v2)
 *
 * - Preserves 100% lossless roundtrip for untouched native golden `.ct` files.
 * - Compiles every directional valve (`WV_2`..`WV_5`) via `compileFluidSim45Valve`
 *   (authentic `CV_ID`, `VALUECLASS`, `POS`, `POS_RESET`, `OFFSET_*`, `DOMINANT`,
 *   `AFL`/`AFR`, `DIR`/`DIR2`, `CONF_L`/`CONF_R`, `PILOT_L`/`PILOT_R` — NEVER `AL_PE1_PE2`).
 * - Derives all component classes, boxes, ports, exit normals, and `BEGINSYM` DXF blocks
 *   from the official `FLUIDSIM45_PROTOTYPES` registry.
 * - Applies unified D4 orientation algebra (`ctTransform.ts`: `rot` × `FLIPPED 0..3`).
 * - Emits strictly 3-gate `PTriconnection`/`ETriconnection` (4 only when all 4 ports are
 *   genuinely wired — NEVER bogus `S state INT 4` hidden 4th gates).
 * - Routes all hoses & wires through the unified channel-allocated `routeCtConnections` engine.
 * - Places all component designation labels & `sectionLabel` headers collision-free via `ctLabelPlacer.ts`.
 */

import type {
  CircuitDocument,
  ComponentNode,
  ConnectionEdge,
  FluidSimFlippedCode,
  ValveActuationSide,
} from '../contracts/circuit';
import { isDefaultA4Header, type DecodedCtContainer } from './ctBinaryCodec';
import {
  getFluidSimPrintableBounds,
  routeCtConnections,
  verifyCtWireGeometryInvariants,
  type CtRoutingEdge,
  type CtRoutingObstacle,
  type CtRoutingPort,
  type CtWireGeometryReport,
} from './ctWireRouter';
import { autoLayoutCircuit } from '../authoring/layoutRouter';
import { normalizeCircuitTopology } from '../authoring/topologyNormalizer';
import { CtSymbolAllocator, isDirectionalValveType } from './ctSymbolLibrary';
import { getFluidSim45Prototype } from './prototypes/fluidsim45Prototypes';
import {
  compileFluidSim45Valve,
  verifyCtValveSolverInvariants,
  type ValveSolverInvariantReport,
} from './ctValveCompiler';
import {
  FS_UNIT_PER_MM,
  mirrorToFlippedCode,
  normalizeRotationDeg,
  transformBox,
  transformNormal,
  transformPoint,
} from './ctTransform';
import { placeSchematicLabels, type LabelableSymbol, type WireSegmentMm } from './ctLabelPlacer';
import {
  computeSemanticFingerprint,
  parseCtBodyAst,
  type PreservedCtSections,
  type RawCtObject,
} from './ctTextCodec';

const PORT_CLASSES = new Set(['PConnection', 'EConnection', 'UEConnection', 'UMConnection']);

function getScalarProp(props: string[], key: string): string | undefined {
  const prefix = ` S ${key} `;
  for (const line of props) {
    if (line.startsWith(prefix)) {
      const rest = line.slice(prefix.length).trim();
      const sp = rest.indexOf(' ');
      return sp >= 0 ? rest.slice(sp + 1) : rest;
    }
  }
  return undefined;
}

function lampColorToRgbInt(color: string): number {
  switch (color.toLowerCase()) {
    case 'red':
      return 255;
    case 'yellow':
    case 'amber':
      return 65535;
    case 'blue':
      return 16711680;
    case 'white':
      return 16777215;
    case 'green':
    default:
      return 65280;
  }
}

function buildComponentSolverProps(comp: ComponentNode): string[] {
  const props: string[] = [];
  const p = comp.params;
  switch (comp.type) {
    case 'air_source':
      props.push(` S P_LIM F ${typeof p.pressureBar === 'number' ? p.pressureBar : 6.0}`);
      props.push(` S FLOW F ${typeof p.maxFlowLMin === 'number' ? p.maxFlowLMin : 1000}`);
      break;
    case 'air_service_unit':
      props.push(` S P_SOLL F ${typeof p.nominalPressureBar === 'number' ? p.nominalPressureBar : 6.0}`);
      break;
    case 'air_filter':
      props.push(` S NN_FLOW F ${typeof p.nominalFlowLMin === 'number' ? p.nominalFlowLMin : 500}`);
      break;
    case 'pressure_regulator':
      props.push(` S P_SOLL F ${typeof p.setPressureBar === 'number' ? p.setPressureBar : 4.0}`);
      break;
    case 'pressure_relief_valve':
      props.push(` S P_SOLL F ${typeof p.reliefPressureBar === 'number' ? p.reliefPressureBar : 6.0}`);
      break;
    case 'flow_control_one_way':
      props.push(` S LEVEL F ${typeof p.openingPct === 'number' ? p.openingPct : 50}`);
      if (p.freeFlowDirection === '2_to_1') props.push(' S _MCP_FREE_FLOW S 2_to_1');
      break;
    case 'throttle_valve':
    case 'nozzle':
    case 'orifice':
      props.push(` S LEVEL F ${typeof p.openingPct === 'number' ? p.openingPct : 50}`);
      if (comp.type === 'orifice') props.push(' S _MCP_TYPE S orifice');
      break;
    case 'check_valve':
    case 'check_valve_spring':
    case 'check_valve_pilot_open':
      props.push(
        ` S P_V F ${typeof p.crackingPressureBar === 'number' ? p.crackingPressureBar : comp.type === 'check_valve' ? 0.1 : 0.2}`,
      );
      break;
    case 'air_reservoir':
      props.push(` S V F ${typeof p.volumeL === 'number' ? p.volumeL : 1.0}`);
      break;
    case 'time_delay_valve': {
      const delayMs = typeof p.delayMs === 'number' ? p.delayMs : 1000;
      props.push(` S DELAY_TIME F ${Math.max(1, Math.round(delayMs / 100))}`);
      break;
    }
    case 'pressure_sequence_valve':
      props.push(` S P_SOLL F ${typeof p.thresholdBar === 'number' ? p.thresholdBar : 4.0}`);
      break;
    case 'pressure_switch_differential':
    case 'pressure_switch_pew':
      props.push(
        ` S P_SOLL F ${typeof p.pressureBar === 'number' ? p.pressureBar : comp.type === 'pressure_switch_pew' ? 2.5 : -0.5}`,
      );
      if (typeof p.hysteresisBar === 'number') props.push(` S _MCP_HYST F ${p.hysteresisBar}`);
      if (typeof p.triggerMode === 'string') props.push(` S _MCP_TRIG_MODE S ${p.triggerMode}`);
      break;
    case 'vacuum_suction_nozzle':
      props.push(` S _MCP_VAC_BAR F ${typeof p.vacuumBar === 'number' ? p.vacuumBar : -0.7}`);
      props.push(` S _MCP_MIN_SUP F ${typeof p.minSupplyBar === 'number' ? p.minSupplyBar : 3.0}`);
      break;
    case 'vacuum_sucker':
      props.push(` S _MCP_GRIP_BAR F ${typeof p.gripThresholdBar === 'number' ? p.gripThresholdBar : -0.3}`);
      break;
    case 'cylinder_single_acting':
    case 'cylinder_double_acting':
    case 'cylinder_rodless': {
      const isSingle = comp.type === 'cylinder_single_acting';
      const isRodless = comp.type === 'cylinder_rodless';
      const stroke = typeof p.strokeMm === 'number' ? p.strokeMm : isRodless ? 200 : isSingle ? 50 : 100;
      const bore = typeof p.pistonDiameterMm === 'number' ? p.pistonDiameterMm : 20;
      const rod = typeof p.rodDiameterMm === 'number' ? p.rodDiameterMm : 8;
      const areaCap = Number((Math.PI * (bore / 20) ** 2).toFixed(5));
      const areaRing = Number(Math.max(0.05, areaCap - Math.PI * (rod / 20) ** 2).toFixed(5));
      props.push(` S HUB F ${stroke}`);
      props.push(` S A_K F ${areaCap}`);
      props.push(` S A_R F ${isRodless ? areaCap : areaRing}`);
      props.push(` S F F ${typeof p.externalLoadN === 'number' ? p.externalLoadN : 0}`);
      props.push(` S S F ${typeof p.initialPositionMm === 'number' ? p.initialPositionMm : 0}`);
      if (isSingle) {
        props.push(' S SPRING_R B T');
        if (typeof p.springForceN === 'number' && p.springForceN !== 25) {
          props.push(` S _MCP_SPRING_N F ${p.springForceN}`);
        }
      }
      if (isRodless) {
        props.push(' S SLEDGE B T');
      }
      if (p.cushioning === true) {
        props.push(' S DAMPING_L B T', ' S DAMPING_R B T');
      }
      break;
    }
    case 'swivel_drive': {
      const alpha = typeof p.maxAngleDeg === 'number' ? p.maxAngleDeg : 180;
      props.push(` S ALPHA F ${alpha}`);
      if (typeof p.initialAngleDeg === 'number' && p.initialAngleDeg !== 0) {
        props.push(` S _MCP_INIT_DEG F ${p.initialAngleDeg}`);
      }
      if (typeof p.torqueNm === 'number' && p.torqueNm !== 5) props.push(` S _MCP_TORQUE F ${p.torqueNm}`);
      if (typeof p.externalLoadNm === 'number' && p.externalLoadNm !== 0) {
        props.push(` S _MCP_LOAD_NM F ${p.externalLoadNm}`);
      }
      if (comp.distanceRule && comp.distanceRule.length > 0) {
        const b64 = Buffer.from(JSON.stringify(comp.distanceRule), 'utf8').toString('base64');
        props.push(` S _MCP_DR_JSON S ${b64}`);
      }
      break;
    }
    case 'air_motor':
      if (typeof p.displacementCc === 'number') props.push(` S _MCP_DISP_CC F ${p.displacementCc}`);
      break;
    case 'pushbutton_nc':
      if (p.detent === true) props.push(' S _MCP_DETENT B T');
      break;
    case 'proximity_switch_magnetic':
      if (p.normalState === 'NC') props.push(' S _MCP_NORMAL_STATE S NC');
      break;
    case 'limit_switch_no':
    case 'limit_switch_nc':
      props.push(' S SWITCH_TYPE I 1');
      break;
    case 'timer_relay_on_delay':
    case 'timer_relay_off_delay': {
      const delayMs = typeof p.delayMs === 'number' ? p.delayMs : 1000;
      props.push(` S DELAY_TIME F ${Math.max(1, Math.round(delayMs / 100))}`);
      break;
    }
    case 'electrical_counter':
      props.push(` S N I ${typeof p.presetCount === 'number' ? p.presetCount : 3}`);
      break;
    case 'indicator_lamp':
      props.push(` S sig_color I ${lampColorToRgbInt(typeof p.color === 'string' ? p.color : 'green')}`);
      break;
    default:
      break;
  }
  return props;
}

export function serializeDocumentToCtContainer(document: CircuitDocument): {
  headerLinesB64?: string[];
  profile?: DecodedCtContainer['profile'];
  previewBlockB64?: string;
  fsPreviewBlock?: string;
  ctBody: string;
  trailerText: string;
} {
  // 1. Lossless bypass for untouched native golden `.ct` files
  const preserved = document.rawAst?.preservedSections as PreservedCtSections | undefined;
  if (preserved && preserved.kind === 'fluidsim-4.5-ct') {
    const currentFingerprint = computeSemanticFingerprint(document);
    if (preserved.originalSemanticFingerprint === currentFingerprint) {
      return {
        headerLinesB64: preserved.headerLinesB64,
        profile: preserved.profile,
        previewBlockB64: preserved.previewBlockB64,
        fsPreviewBlock: preserved.fsPreviewBlock,
        ctBody: preserved.originalCtBody,
        trailerText: preserved.trailerText,
      };
    }
  }

  // 2. Normalize IR v2 (named nets -> 3-gate junction chains, inline portTerminators -> embedded metadata)
  const norm = normalizeCircuitTopology(document);
  const needsLayout = norm.document.components.some((c) => !c.layout);
  const laidOut = needsLayout ? autoLayoutCircuit(norm.document) : norm.document;

  const sheetWidthMm = Math.max(210, laidOut.metadata.sheetWidthMm || 297);
  const sheetHeightMm = Math.max(148, laidOut.metadata.sheetHeightMm || 210);
  const printable = getFluidSimPrintableBounds(sheetWidthMm, sheetHeightMm);

  // Compute uniform mm -> FluidSIM raw-unit scale so all components stay strictly inside printable bounds
  let maxLayoutXMm = sheetWidthMm;
  let maxLayoutYMm = sheetHeightMm;
  for (const c of laidOut.components) {
    if (!c.layout) continue;
    const proto = getFluidSim45Prototype(c.type);
    const rot = normalizeRotationDeg(c.rotationDeg ?? c.layout.rotationDeg);
    const flip = (c.flipped ?? mirrorToFlippedCode(c.mirror)) as FluidSimFlippedCode;
    const box = transformBox(proto?.sizeMm.width ?? 20, proto?.sizeMm.height ?? 12, rot, flip);
    maxLayoutXMm = Math.max(maxLayoutXMm, c.layout.x + box.w + 15);
    maxLayoutYMm = Math.max(maxLayoutYMm, c.layout.y + box.h + 15);
  }
  const usableW = printable.maxX - printable.minX - 24 * 1024;
  const usableH = printable.maxY - printable.minY - 56 * 1024;
  const scaleX = usableW / Math.max(180, maxLayoutXMm);
  const scaleY = usableH / Math.max(140, maxLayoutYMm);
  const unitPerMm = Math.max(1280, Math.min(FS_UNIT_PER_MM, Math.floor(Math.min(scaleX, scaleY) / 64) * 64));
  const originOffsetX = printable.minX + 10 * 1024;
  const titleY1 = printable.minY + 4 * 1024;
  const titleY2 = titleY1 + 12 * 1024;
  const originOffsetY = titleY2 + 24 * 1024; // guarantees >= 20*1024 clearance below title text

  const mmToRawX = (mm: number): number => Math.max(printable.minX + 1024, Math.round(originOffsetX + mm * unitPerMm));
  const mmToRawY = (mm: number): number =>
    Math.max(originOffsetY, Math.round(originOffsetY + Math.max(0, mm - 32) * unitPerMm));
  const lenToRaw = (mm: number): number => Math.max(2048, Math.round(mm * unitPerMm));

  // 3. Identify standalone exhaust_silencer & blind_plug nodes attached to a single host port -> embed as EX3/EX4
  const embeddedExhByHostPort = new Map<string, { exhId: string; edgeId: string; exType: 'EX3' | 'EX4' }>();
  const collapsedCompIds = new Set<string>();
  const collapsedEdgeIds = new Set<string>();

  const edgesByComp = new Map<string, ConnectionEdge[]>();
  for (const e of laidOut.connections) {
    const a = edgesByComp.get(e.from.componentId) ?? [];
    a.push(e);
    edgesByComp.set(e.from.componentId, a);
    const b = edgesByComp.get(e.to.componentId) ?? [];
    b.push(e);
    edgesByComp.set(e.to.componentId, b);
  }

  for (const c of laidOut.components) {
    if (c.type !== 'exhaust_silencer' && c.type !== 'blind_plug') continue;
    const incident = edgesByComp.get(c.id) ?? [];
    if (incident.length !== 1) continue;
    const edge = incident[0];
    const hostId = edge.from.componentId === c.id ? edge.to.componentId : edge.from.componentId;
    const hostPort = edge.from.componentId === c.id ? edge.to.port : edge.from.port;
    const hostComp = laidOut.components.find((x) => x.id === hostId);
    if (!hostComp) continue;
    embeddedExhByHostPort.set(`${hostId}::${hostPort}`, {
      exhId: c.id,
      edgeId: edge.id,
      exType: c.type === 'blind_plug' ? 'EX4' : 'EX3',
    });
    collapsedCompIds.add(c.id);
    collapsedEdgeIds.add(edge.id);
  }

  const wiredPortsByComp = new Map<string, Set<string>>();
  for (const e of laidOut.connections) {
    if (collapsedEdgeIds.has(e.id)) continue;
    const sA = wiredPortsByComp.get(e.from.componentId) ?? new Set<string>();
    sA.add(e.from.port);
    wiredPortsByComp.set(e.from.componentId, sA);
    const sB = wiredPortsByComp.get(e.to.componentId) ?? new Set<string>();
    sB.add(e.to.port);
    wiredPortsByComp.set(e.to.componentId, sB);
  }

  // 4. Emit AST object blocks, child port gates, R_SCHALT distance rules, and collect routing data
  const symAlloc = new CtSymbolAllocator();
  interface EmittedObj {
    objId: number;
    cls: string;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    rot: number;
    flip: number;
    flags: number;
    props: string[];
  }
  const emittedObjects: EmittedObj[] = [];
  const emittedGates: Array<{ gateNum: number; parentId: number; childId: number }> = [];
  const routingObstacles: CtRoutingObstacle[] = [];
  const routingPorts = new Map<number, CtRoutingPort>();
  const portObjIdByCompPort = new Map<string, number>();
  const portObjIdByEdgeEnd = new Map<string, number>();
  const labelableSymbols: LabelableSymbol[] = [];
  const reservedLabelBoxesMm: Array<{ x: number; y: number; width: number; height: number }> = [];

  const pushObj = (obj: Omit<EmittedObj, 'objId'>): number => {
    const objId = emittedObjects.length;
    emittedObjects.push({ ...obj, objId });
    return objId;
  };

  // Precompute raw bounding boxes of all non-collapsed components for collision-free bus placement
  const compRawCenter = new Map<string, { cx: number; cy: number; x1: number; y1: number; x2: number; y2: number }>();
  for (const c of laidOut.components) {
    if (collapsedCompIds.has(c.id)) continue;
    const p = getFluidSim45Prototype(c.type);
    const r = normalizeRotationDeg(c.rotationDeg ?? c.layout?.rotationDeg);
    const f = (c.flipped ?? mirrorToFlippedCode(c.mirror)) as FluidSimFlippedCode;
    const tb = transformBox(p?.sizeMm.width ?? 20, p?.sizeMm.height ?? 12, r, f);
    const cx1 = mmToRawX(c.layout?.x ?? 20);
    const cy1 = mmToRawY(c.layout?.y ?? 40);
    const cx2 = cx1 + lenToRaw(tb.w);
    const cy2 = cy1 + lenToRaw(tb.h);
    compRawCenter.set(c.id, { cx: Math.round((cx1 + cx2) / 2), cy: Math.round((cy1 + cy2) / 2), x1: cx1, y1: cy1, x2: cx2, y2: cy2 });
  }

  // Title text object with MCP sheet metadata (object 0)
  const titleText = laidOut.metadata.title || 'FluidSIM 4.5 Pneumatic Circuit';
  const titleX1 = printable.minX + 10 * 1024;
  const titleX2 = titleX1 + Math.max(80 * 1024, titleText.length * 4 * 1024);
  pushObj({
    cls: 'text',
    x1: titleX1,
    y1: titleY1,
    x2: titleX2,
    y2: titleY2,
    rot: 0,
    flip: 0,
    flags: 0,
    props: [
      ` S text S ${titleText}`,
      ` S _MCP_SHEET_W F ${sheetWidthMm}`,
      ` S _MCP_SHEET_H F ${sheetHeightMm}`,
      ` S _MCP_UNIT_PER_MM I ${unitPerMm}`,
      ` S _MCP_ORIGIN_X I ${originOffsetX}`,
      ` S _MCP_ORIGIN_Y I ${originOffsetY}`,
      ...(laidOut.metadata.sheetDomain ? [` S _MCP_SHEET_DOMAIN S ${laidOut.metadata.sheetDomain}`] : []),
      ...(laidOut.metadata.allowExternalElectricalSheet !== undefined
        ? [` S _MCP_ALLOW_EXT_ELEC B ${laidOut.metadata.allowExternalElectricalSheet ? 'T' : 'F'}`]
        : []),
    ],
  });

  const manifoldBridgePairs: Array<{ portA: number; portB: number; kind: 'PLine' | 'ELine' }> = [];

  for (const comp of laidOut.components) {
    if (collapsedCompIds.has(comp.id)) continue;

    const proto = getFluidSim45Prototype(comp.type);
    const rot = normalizeRotationDeg(comp.rotationDeg ?? comp.layout?.rotationDeg);
    const flip = (comp.flipped ?? mirrorToFlippedCode(comp.mirror)) as FluidSimFlippedCode;
    const baseW = proto?.sizeMm.width ?? 20;
    const baseH = proto?.sizeMm.height ?? 12;
    const tBox = transformBox(baseW, baseH, rot, flip);

    const lxMm = comp.layout?.x ?? 20;
    const lyMm = comp.layout?.y ?? 40;
    const x1 = mmToRawX(lxMm);
    const y1 = mmToRawY(lyMm);
    const x2 = x1 + lenToRaw(tBox.w);
    const y2 = y1 + lenToRaw(tBox.h);

    const commonMcpProps: string[] = [
      ` S _MCP_ID S ${comp.id}`,
      ...(comp.label ? [` S _MCP_LABEL S ${comp.label}`] : []),
      ...(comp.sectionLabel ? [` S _MCP_SECTION_LABEL S ${comp.sectionLabel}`] : []),
      ...(comp.group ? [` S _MCP_GROUP S ${comp.group}`] : []),
    ];

    // Special Case A: pneumatic_manifold -> horizontal chain of authentic 3-gate PTriconnection slices
    if (comp.type === 'pneumatic_manifold') {
      const busRole = String(comp.params.busRole ?? 'supply');
      const wiredPorts = Array.from(wiredPortsByComp.get(comp.id) ?? ['1', '2', '3']).sort((a, b) => Number(a) - Number(b));
      for (let pn = 1; pn <= 8; pn++) {
        if (embeddedExhByHostPort.has(`${comp.id}::${pn}`) && !wiredPorts.includes(String(pn))) {
          wiredPorts.push(String(pn));
        }
      }
      wiredPorts.sort((a, b) => Number(a) - Number(b));
      const sliceCount = Math.max(2, wiredPorts.length);
      const sliceStepRaw = Math.max(16 * 1024, Math.floor(lenToRaw(tBox.w) / Math.max(1, sliceCount - 1)));

      let prevRightPortId: number | null = null;
      for (let s = 0; s < sliceCount; s++) {
        const sx = x1 + s * sliceStepRaw;
        const sy = Math.round((y1 + y2) / 2);
        const half = 6144;
        const sliceObjId = pushObj({
          cls: 'PTriconnection',
          x1: sx - half,
          y1: sy - half,
          x2: sx + half,
          y2: sy + half,
          rot: 0,
          flip: 0,
          flags: 6553603,
          props: [
            ` S _MCP_MANIFOLD_ID S ${comp.id}`,
            ` S _MCP_MANIFOLD_ROLE S ${busRole}`,
            ` S _MCP_MANIFOLD_SLICE I ${s}`,
            ' F con_descr1 x_offset I 0',
            ' F con_descr1 y_offset I 0',
            ' F con_descr2 x_offset I 0',
            ' F con_descr2 y_offset I 0',
            ' F con_descr3 x_offset I 0',
            ' F con_descr3 y_offset I 0',
          ],
        });
        routingObstacles.push({
          ownerId: sliceObjId,
          cls: 'PTriconnection',
          x1: sx - half,
          y1: sy - half,
          x2: sx + half,
          y2: sy + half,
        });

        const assignedPort = wiredPorts[s];
        const embedded = assignedPort ? embeddedExhByHostPort.get(`${comp.id}::${assignedPort}`) : undefined;
        // Strictly 3 co-located gates per PTriconnection slice matching real FluidSIM 4.5
        const gateCoords: Array<{ gn: number; px: number; py: number; norm: 'W' | 'N' | 'E'; isManifoldPort: boolean }> = [
          { gn: 1, px: sx, py: sy, norm: 'W', isManifoldPort: false },
          { gn: 2, px: sx, py: sy, norm: 'N', isManifoldPort: true },
          { gn: 3, px: sx, py: sy, norm: 'E', isManifoldPort: false },
        ];
        let leftPid = -1;
        let rightPid = -1;
        for (const gc of gateCoords) {
          const pProps: string[] = [];
          if (gc.isManifoldPort && assignedPort) {
            pProps.push(` S _MCP_MANIFOLD_PORT S ${assignedPort}`);
            if (embedded) {
              pProps.push(` S ex_type S ${embedded.exType}`);
              pProps.push(
                embedded.exType === 'EX4'
                  ? ` S _MCP_PLUG_ID S ${embedded.exhId}`
                  : ` S _MCP_EXH_ID S ${embedded.exhId}`,
              );
              pProps.push(
                embedded.exType === 'EX4'
                  ? ` S _MCP_PLUG_EDGE_ID S ${embedded.edgeId}`
                  : ` S _MCP_EXH_EDGE_ID S ${embedded.edgeId}`,
              );
            }
          }
          const pid = pushObj({
            cls: 'PConnection',
            x1: gc.px - 5120,
            y1: gc.py - 5120,
            x2: gc.px + 5120,
            y2: gc.py + 5120,
            rot: 0,
            flip: 0,
            flags: 6553603,
            props: pProps,
          });
          emittedGates.push({ gateNum: gc.gn, parentId: sliceObjId, childId: pid });
          routingPorts.set(pid, {
            objId: pid,
            parentId: sliceObjId,
            cls: 'PConnection',
            cx: gc.px,
            cy: gc.py,
            hidden: false,
            exitNormal: gc.norm,
          });
          if (gc.gn === 1) leftPid = pid;
          if (gc.gn === 3) rightPid = pid;
          if (gc.isManifoldPort && assignedPort) {
            portObjIdByCompPort.set(`${comp.id}::${assignedPort}`, pid);
          }
        }
        if (prevRightPortId !== null && leftPid >= 0) {
          manifoldBridgePairs.push({ portA: prevRightPortId, portB: leftPid, kind: 'PLine' });
        }
        prevRightPortId = rightPid;
      }

      labelableSymbols.push({
        id: comp.id,
        type: comp.type,
        label: comp.label,
        sectionLabel: comp.sectionLabel,
        boxMm: { x: lxMm, y: lyMm, width: tBox.w, height: tBox.h },
      });
      continue;
    }

    // Special Case B: PTriconnection / ETriconnection -> strictly 3 gates (multi-fanout buses expand into 3-gate rail tap chains!)
    if (comp.type === 'pneumatic_junction' || comp.type === 'electrical_junction') {
      const isElec = comp.type === 'electrical_junction';
      const cls = isElec ? 'ETriconnection' : 'PTriconnection';
      const connCls = isElec ? 'EConnection' : 'PConnection';
      const lineKind: 'ELine' | 'PLine' = isElec ? 'ELine' : 'PLine';

      const activeIncident = (edgesByComp.get(comp.id) ?? []).filter((e) => !collapsedEdgeIds.has(e.id));
      const portUseCount = new Map<string, number>();
      for (const e of activeIncident) {
        if (e.from.componentId === comp.id) {
          portUseCount.set(e.from.port, (portUseCount.get(e.from.port) ?? 0) + 1);
        }
        if (e.to.componentId === comp.id) {
          portUseCount.set(e.to.port, (portUseCount.get(e.to.port) ?? 0) + 1);
        }
      }
      const hasMultiWirePort = Array.from(portUseCount.values()).some((cnt) => cnt > 1);
      const needsRailExpansion = hasMultiWirePort || activeIncident.length > 3;

      if (needsRailExpansion && activeIncident.length >= 2) {
        const half = 6144;
        const tapItems = activeIncident.map((e) => {
          const isFrom = e.from.componentId === comp.id;
          const myPort = isFrom ? e.from.port : e.to.port;
          const otherId = isFrom ? e.to.componentId : e.from.componentId;
          const otherBox = compRawCenter.get(otherId);
          return {
            edge: e,
            side: (isFrom ? 'from' : 'to') as 'from' | 'to',
            myPort,
            otherX: otherBox?.cx ?? Math.round((x1 + x2) / 2),
            otherY: otherBox?.cy ?? Math.round((y1 + y2) / 2),
          };
        });
        tapItems.sort((a, b) => a.otherX - b.otherX);

        // Compute monotonically spaced tap X positions aligned near partner X coordinates
        const minTapX = printable.minX + 14336;
        const maxTapX = printable.maxX - 14336;
        const minStep = Math.min(16384, Math.max(13312, Math.floor((maxTapX - minTapX) / Math.max(1, tapItems.length))));
        const xs = tapItems.map((t) => Math.max(minTapX, Math.min(maxTapX, t.otherX)));
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] < xs[i - 1] + minStep) xs[i] = xs[i - 1] + minStep;
        }
        if (xs[xs.length - 1] > maxTapX) {
          const shift = xs[xs.length - 1] - maxTapX;
          for (let i = 0; i < xs.length; i++) xs[i] = Math.max(minTapX + i * minStep, xs[i] - shift);
        }

        // Choose a collision-free rail Y near comp's laid-out Y
        const avgOtherY = tapItems.reduce((acc, t) => acc + t.otherY, 0) / tapItems.length;
        const baseSy = Math.round((y1 + y2) / 2);
        const searchDir = avgOtherY >= baseSy ? -1 : 1; // push away from rungs if needed
        let railY = Math.max(originOffsetY + half, Math.min(printable.maxY - half - 4096, baseSy));
        const collidesAtY = (candY: number): boolean => {
          for (const [cid, box] of compRawCenter.entries()) {
            if (cid === comp.id) continue;
            if (candY + half + 1024 > box.y1 && candY - half - 1024 < box.y2) {
              for (const sx of xs) {
                if (sx + half + 1024 > box.x1 && sx - half - 1024 < box.x2) return true;
              }
            }
          }
          return false;
        };
        if (collidesAtY(railY)) {
          for (let step = 1; step <= 24; step++) {
            const c1 = baseSy + searchDir * step * 6144;
            if (c1 >= originOffsetY + half && c1 <= printable.maxY - half - 4096 && !collidesAtY(c1)) {
              railY = c1;
              break;
            }
            const c2 = baseSy - searchDir * step * 6144;
            if (c2 >= originOffsetY + half && c2 <= printable.maxY - half - 4096 && !collidesAtY(c2)) {
              railY = c2;
              break;
            }
          }
        }

        let prevRightPid: number | null = null;
        for (let i = 0; i < tapItems.length; i++) {
          const item = tapItems[i];
          const sx = xs[i];
          const sy = railY;
          const tapObjId = pushObj({
            cls,
            x1: sx - half,
            y1: sy - half,
            x2: sx + half,
            y2: sy + half,
            rot: 0,
            flip: 0,
            flags: 6553603,
            props: [
              ` S _MCP_ELEC_RAIL_OWNER S ${comp.id}`,
              ` S _MCP_ELEC_RAIL_TYPE S ${comp.type}`,
              ' F con_descr1 x_offset I 0',
              ' F con_descr1 y_offset I 0',
              ' F con_descr2 x_offset I 0',
              ' F con_descr2 y_offset I 0',
              ' F con_descr3 x_offset I 0',
              ' F con_descr3 y_offset I 0',
            ],
          });
          routingObstacles.push({ ownerId: tapObjId, cls, x1: sx - half, y1: sy - half, x2: sx + half, y2: sy + half });

          const tapNorm: 'N' | 'S' = item.otherY >= sy ? 'S' : 'N';
          const gateDefs: Array<{ gn: number; norm: 'W' | 'N' | 'S' | 'E'; isTap: boolean }> = [
            { gn: 1, norm: 'W', isTap: false },
            { gn: 2, norm: tapNorm, isTap: true },
            { gn: 3, norm: 'E', isTap: false },
          ];
          let leftPid = -1;
          let rightPid = -1;
          for (const gd of gateDefs) {
            const pProps: string[] = [];
            if (gd.isTap) {
              pProps.push(` S _MCP_ELEC_RAIL_PORT S ${item.myPort}`);
            }
            const pid = pushObj({
              cls: connCls,
              x1: sx - 5120,
              y1: sy - 5120,
              x2: sx + 5120,
              y2: sy + 5120,
              rot: 0,
              flip: 0,
              flags: 6553603,
              props: pProps,
            });
            emittedGates.push({ gateNum: gd.gn, parentId: tapObjId, childId: pid });
            routingPorts.set(pid, {
              objId: pid,
              parentId: tapObjId,
              cls: connCls,
              cx: sx,
              cy: sy,
              hidden: false,
              exitNormal: gd.norm,
            });
            if (gd.gn === 1) leftPid = pid;
            if (gd.gn === 3) rightPid = pid;
            if (gd.isTap) {
              portObjIdByEdgeEnd.set(`${item.edge.id}::${item.side}`, pid);
              if (!portObjIdByCompPort.has(`${comp.id}::${item.myPort}`)) {
                portObjIdByCompPort.set(`${comp.id}::${item.myPort}`, pid);
              }
            }
          }
          if (prevRightPid !== null && leftPid >= 0) {
            manifoldBridgePairs.push({ portA: prevRightPid, portB: leftPid, kind: lineKind });
          }
          prevRightPid = rightPid;
        }
        continue;
      }

      const wired = wiredPortsByComp.get(comp.id) ?? new Set<string>();
      const useFourGates = wired.has('4') || embeddedExhByHostPort.has(`${comp.id}::4`);
      const cx = Math.round((x1 + x2) / 2);
      const cy = Math.round((y1 + y2) / 2);
      const half = 6144;

      const jObjId = pushObj({
        cls,
        x1: cx - half,
        y1: cy - half,
        x2: cx + half,
        y2: cy + half,
        rot: 0,
        flip: 0,
        flags: 6553603,
        props: [
          ...commonMcpProps,
          ' F con_descr1 x_offset I 0',
          ' F con_descr1 y_offset I 0',
          ' F con_descr2 x_offset I 0',
          ' F con_descr2 y_offset I 0',
          ' F con_descr3 x_offset I 0',
          ' F con_descr3 y_offset I 0',
          ...(useFourGates ? [' F con_descr4 x_offset I 0', ' F con_descr4 y_offset I 0'] : []),
        ],
      });
      routingObstacles.push({
        ownerId: jObjId,
        cls,
        x1: cx - half,
        y1: cy - half,
        x2: cx + half,
        y2: cy + half,
      });

      // Co-located gates at (cx, cy) matching real FluidSIM 4.5 PTriconnection/ETriconnection
      const gateDefs: Array<{ portName: string; gn: number; norm: 'W' | 'E' | 'N' | 'S' }> = [
        { portName: '1', gn: 1, norm: 'W' },
        { portName: '2', gn: 2, norm: 'E' },
        { portName: '3', gn: 3, norm: 'N' },
      ];
      if (useFourGates) {
        gateDefs.push({ portName: '4', gn: 4, norm: 'S' });
      }

      for (const gd of gateDefs) {
        const px = cx;
        const py = cy;
        const pProps: string[] = [];
        const embedded = embeddedExhByHostPort.get(`${comp.id}::${gd.portName}`);
        if (embedded) {
          pProps.push(` S ex_type S ${embedded.exType}`);
          pProps.push(
            embedded.exType === 'EX4'
              ? ` S _MCP_PLUG_ID S ${embedded.exhId}`
              : ` S _MCP_EXH_ID S ${embedded.exhId}`,
          );
          pProps.push(
            embedded.exType === 'EX4'
              ? ` S _MCP_PLUG_EDGE_ID S ${embedded.edgeId}`
              : ` S _MCP_EXH_EDGE_ID S ${embedded.edgeId}`,
          );
        }
        const pid = pushObj({
          cls: connCls,
          x1: px - 5120,
          y1: py - 5120,
          x2: px + 5120,
          y2: py + 5120,
          rot: 0,
          flip: 0,
          flags: 6553603,
          props: pProps,
        });
        emittedGates.push({ gateNum: gd.gn, parentId: jObjId, childId: pid });
        routingPorts.set(pid, {
          objId: pid,
          parentId: jObjId,
          cls: connCls,
          cx: px,
          cy: py,
          hidden: false,
          exitNormal: gd.norm,
        });
        portObjIdByCompPort.set(`${comp.id}::${gd.portName}`, pid);
      }

      labelableSymbols.push({
        id: comp.id,
        type: comp.type,
        boxMm: { x: lxMm, y: lyMm, width: tBox.w, height: tBox.h },
        isJunction: true,
      });
      continue;
    }

    // Standard Component Emission (Valves via ctValveCompiler + All Others via FLUIDSIM45_PROTOTYPES)
    const isValve = isDirectionalValveType(comp.type);
    const compiledValve = isValve ? compileFluidSim45Valve(comp) : undefined;
    let cls = compiledValve ? compiledValve.cls : proto?.fluidsimClass ?? 'WV_3';
    if (comp.type === 'pushbutton_no' && comp.params.detent === true) {
      cls = 'E_S031';
    } else if (comp.type === 'pushbutton_nc' && comp.params.detent === true) {
      cls = 'E_S032';
    }
    const extraClassProps: string[] = [];
    if (cls.startsWith('PConnection:')) {
      const exType = cls.split(':')[1] ?? 'EX3';
      cls = 'PConnection';
      extraClassProps.push(` S ex_type S ${exType}`);
    }
    if (comp.type === 'vacuum_suction_nozzle') {
      extraClassProps.push(` S _MCP_ORIG_ROT I ${rot}`);
      const exh3 = embeddedExhByHostPort.get(`${comp.id}::3`);
      if (exh3) {
        extraClassProps.push(` S _MCP_EXH_3_ID S ${exh3.exhId}`);
        extraClassProps.push(` S _MCP_EXH_3_EDGE_ID S ${exh3.edgeId}`);
      }
    }
    if (comp.type === 'swivel_drive') {
      extraClassProps.push(` S _MCP_ORIG_ROT I ${rot}`);
      if (comp.distanceRule && comp.distanceRule.length > 0) {
        const sortedMarkers = [...comp.distanceRule].sort((a, b) => a.positionMm - b.positionMm);
        if (sortedMarkers[0]) extraClassProps.push(` S l1 S ${sortedMarkers[0].label}`);
        if (sortedMarkers[1]) extraClassProps.push(` S l2 S ${sortedMarkers[1].label}`);
      }
    }
    const gdiFlags = compiledValve ? compiledValve.gdiFlags : proto?.gdiFlags ?? 0;
    const emittedRot =
      comp.type === 'vacuum_suction_nozzle'
        ? normalizeRotationDeg(rot + 180)
        : comp.type === 'swivel_drive'
          ? normalizeRotationDeg(rot + 90)
          : rot;

    const { dxf1, dxf2 } = symAlloc.allocateForComponent(comp, emittedRot, flip);

    const objProps: string[] = [
      ...commonMcpProps,
      ...(comp.label ? [` S label S ${comp.label}`] : []),
      ...extraClassProps,
      ...(compiledValve
        ? [...compiledValve.props, ...compiledValve.conDescrProps]
        : [...buildComponentSolverProps(comp), ...(proto?.defaultSolverProps ?? [])]),
      ...(dxf1 !== undefined ? [` S dxf_prim_list V ${dxf1}`] : []),
      ...(dxf2 !== undefined ? [` S dxf_prim_list2 V ${dxf2}`] : []),
    ];

    const compObjId = pushObj({
      cls,
      x1,
      y1,
      x2,
      y2,
      rot: emittedRot,
      flip,
      flags: gdiFlags,
      props: objProps,
    });
    routingObstacles.push({ ownerId: compObjId, cls, x1, y1, x2, y2 });

    const useTwoGatePav1 =
      comp.type === 'vacuum_suction_nozzle' && embeddedExhByHostPort.has(`${comp.id}::3`);
    const gates = useTwoGatePav1
      ? (proto?.gates ?? [])
          .filter((g) => g.portName !== '3')
          .map((g, idx) => ({ ...g, gateIndex: idx + 1 }))
      : (proto?.gates ?? []);
    for (const g of gates) {
      const tPos = transformPoint(g.offsetMm.x, g.offsetMm.y, baseW, baseH, emittedRot, flip);
      const tNorm = transformNormal(g.normal, emittedRot, flip);
      const px = x1 + Math.round(tPos.x * unitPerMm);
      const py = y1 + Math.round(tPos.y * unitPerMm);

      const portProps: string[] = [];
      if (g.portName) {
        const embedded = embeddedExhByHostPort.get(`${comp.id}::${g.portName}`);
        if (embedded) {
          portProps.push(` S ex_type S ${embedded.exType}`);
          portProps.push(
            embedded.exType === 'EX4'
              ? ` S _MCP_PLUG_ID S ${embedded.exhId}`
              : ` S _MCP_EXH_ID S ${embedded.exhId}`,
          );
          portProps.push(
            embedded.exType === 'EX4'
              ? ` S _MCP_PLUG_EDGE_ID S ${embedded.edgeId}`
              : ` S _MCP_EXH_EDGE_ID S ${embedded.edgeId}`,
          );
        }
      }

      const pid = pushObj({
        cls: g.connClass,
        x1: px - 5120,
        y1: py - 5120,
        x2: px + 5120,
        y2: py + 5120,
        rot: 0,
        flip: 0,
        flags: 348163,
        props: portProps,
      });
      emittedGates.push({ gateNum: g.gateIndex, parentId: compObjId, childId: pid });
      routingPorts.set(pid, {
        objId: pid,
        parentId: compObjId,
        cls: g.connClass,
        cx: px,
        cy: py,
        hidden: false,
        exitNormal: tNorm,
      });
      if (g.portName) {
        portObjIdByCompPort.set(`${comp.id}::${g.portName}`, pid);
      }
    }

    // Expand multi-fanout power_24v / power_0v into a horizontal 3-gate ETriconnection bus rail chain
    if (comp.type === 'power_24v' || comp.type === 'power_0v') {
      const railPortName = comp.type === 'power_24v' ? 'OUT' : 'IN';
      const powerPortPid = portObjIdByCompPort.get(`${comp.id}::${railPortName}`);
      const activeIncident = (edgesByComp.get(comp.id) ?? []).filter((e) => !collapsedEdgeIds.has(e.id));
      if (powerPortPid !== undefined && activeIncident.length >= 2) {
        const half = 6144;
        const tapItems = activeIncident.map((e) => {
          const isFrom = e.from.componentId === comp.id;
          const otherId = isFrom ? e.to.componentId : e.from.componentId;
          const otherBox = compRawCenter.get(otherId);
          return {
            edge: e,
            side: (isFrom ? 'from' : 'to') as 'from' | 'to',
            otherX: otherBox?.cx ?? Math.round((x1 + x2) / 2),
            otherY: otherBox?.cy ?? Math.round((y1 + y2) / 2),
          };
        });
        tapItems.sort((a, b) => a.otherX - b.otherX);

        const powerPort = routingPorts.get(powerPortPid);
        const minTapX = printable.minX + 14336;
        const maxTapX = printable.maxX - 14336;
        const minStep = Math.min(16384, Math.max(13312, Math.floor((maxTapX - minTapX) / Math.max(1, tapItems.length))));
        const xs = tapItems.map((t) => Math.max(minTapX, Math.min(maxTapX, t.otherX)));
        for (let i = 1; i < xs.length; i++) {
          if (xs[i] < xs[i - 1] + minStep) xs[i] = xs[i - 1] + minStep;
        }
        if (xs[xs.length - 1] > maxTapX) {
          const shift = xs[xs.length - 1] - maxTapX;
          for (let i = 0; i < xs.length; i++) xs[i] = Math.max(minTapX + i * minStep, xs[i] - shift);
        }

        const avgOtherY = tapItems.reduce((acc, t) => acc + t.otherY, 0) / tapItems.length;
        let maxPartnerY2 = 0;
        let minPartnerY1 = printable.maxY;
        for (const t of tapItems) {
          const otherId = t.edge.from.componentId === comp.id ? t.edge.to.componentId : t.edge.from.componentId;
          const b = compRawCenter.get(otherId);
          if (b) {
            if (b.y2 > maxPartnerY2) maxPartnerY2 = b.y2;
            if (b.y1 < minPartnerY1) minPartnerY1 = b.y1;
          }
        }
        const baseSy = comp.type === 'power_24v'
          ? Math.max(originOffsetY + half, Math.min((powerPort?.cy ?? y2), minPartnerY1 - 16384))
          : Math.min(printable.maxY - half - 4096, Math.max((powerPort?.cy ?? y1), maxPartnerY2 + 16384));
        const searchDir = comp.type === 'power_24v' ? -1 : 1;
        let railY = Math.max(originOffsetY + half, Math.min(printable.maxY - half - 4096, baseSy));
        const collidesAtY = (candY: number): boolean => {
          for (const [cid, box] of compRawCenter.entries()) {
            if (cid === comp.id) continue;
            if (candY + half + 1024 > box.y1 && candY - half - 1024 < box.y2) {
              for (const sx of xs) {
                if (sx + half + 1024 > box.x1 && sx - half - 1024 < box.x2) return true;
              }
            }
          }
          if (candY + half + 1024 > y1 && candY - half - 1024 < y2) {
            for (const sx of xs) {
              if (sx + half + 1024 > x1 && sx - half - 1024 < x2) return true;
            }
          }
          return false;
        };
        if (collidesAtY(railY)) {
          for (let step = 1; step <= 28; step++) {
            const c1 = baseSy + searchDir * step * 6144;
            if (c1 >= originOffsetY + half && c1 <= printable.maxY - half - 4096 && !collidesAtY(c1)) {
              railY = c1;
              break;
            }
            const c2 = baseSy - searchDir * step * 6144;
            if (c2 >= originOffsetY + half && c2 <= printable.maxY - half - 4096 && !collidesAtY(c2)) {
              railY = c2;
              break;
            }
          }
        }

        // Align power_24v / power_0v cleanly to the left of tap[0] on the same railY if obstructed
        const powerObj = emittedObjects[compObjId];
        const powerPortObj = emittedObjects[powerPortPid];
        const powerPortInfo = routingPorts.get(powerPortPid);
        if (powerObj && powerPortObj && powerPortInfo) {
          const pw = powerObj.x2 - powerObj.x1;
          const ph = powerObj.y2 - powerObj.y1;
          const targetPx = Math.max(printable.minX + 4096, xs[0] - pw - 16384);
          const targetPy = Math.max(originOffsetY, Math.min(printable.maxY - ph - 4096, railY - Math.round(ph / 2)));
          const dxMove = targetPx - powerObj.x1;
          const dyMove = targetPy - powerObj.y1;
          const hitsComp = Array.from(compRawCenter.entries()).some(
            ([cid, box]) =>
              cid !== comp.id &&
              targetPx < box.x2 + 2048 &&
              targetPx + pw > box.x1 - 2048 &&
              targetPy < box.y2 + 2048 &&
              targetPy + ph > box.y1 - 2048,
          );
          if (!hitsComp) {
            powerObj.x1 = targetPx;
            powerObj.y1 = targetPy;
            powerObj.x2 = targetPx + pw;
            powerObj.y2 = targetPy + ph;
            const obs = routingObstacles.find((o) => o.ownerId === compObjId);
            if (obs) {
              obs.x1 = powerObj.x1;
              obs.y1 = powerObj.y1;
              obs.x2 = powerObj.x2;
              obs.y2 = powerObj.y2;
            }
            powerPortInfo.cx += dxMove;
            powerPortInfo.cy += dyMove;
            powerPortInfo.exitNormal = 'E';
            powerPortObj.x1 = powerPortInfo.cx - 5120;
            powerPortObj.y1 = powerPortInfo.cy - 5120;
            powerPortObj.x2 = powerPortInfo.cx + 5120;
            powerPortObj.y2 = powerPortInfo.cy + 5120;
          }
        }

        let prevRightPid: number | null = powerPortPid;
        for (let i = 0; i < tapItems.length; i++) {
          const item = tapItems[i];
          const sx = xs[i];
          const sy = railY;
          const tapObjId = pushObj({
            cls: 'ETriconnection',
            x1: sx - half,
            y1: sy - half,
            x2: sx + half,
            y2: sy + half,
            rot: 0,
            flip: 0,
            flags: 6553603,
            props: [
              ` S _MCP_ELEC_RAIL_OWNER S ${comp.id}`,
              ` S _MCP_ELEC_RAIL_TYPE S ${comp.type}`,
              ' F con_descr1 x_offset I 0',
              ' F con_descr1 y_offset I 0',
              ' F con_descr2 x_offset I 0',
              ' F con_descr2 y_offset I 0',
              ' F con_descr3 x_offset I 0',
              ' F con_descr3 y_offset I 0',
            ],
          });
          routingObstacles.push({ ownerId: tapObjId, cls: 'ETriconnection', x1: sx - half, y1: sy - half, x2: sx + half, y2: sy + half });
          const tapNorm: 'N' | 'S' = avgOtherY >= sy ? 'S' : 'N';
          const gateDefs: Array<{ gn: number; norm: 'W' | 'N' | 'S' | 'E'; isTap: boolean }> = [
            { gn: 1, norm: 'W', isTap: false },
            { gn: 2, norm: tapNorm, isTap: true },
            { gn: 3, norm: 'E', isTap: false },
          ];
          let leftPid = -1;
          let rightPid = -1;
          for (const gd of gateDefs) {
            const pProps: string[] = [];
            if (gd.isTap) {
              pProps.push(` S _MCP_ELEC_RAIL_PORT S ${railPortName}`);
            }
            const pid = pushObj({
              cls: 'EConnection',
              x1: sx - 5120,
              y1: sy - 5120,
              x2: sx + 5120,
              y2: sy + 5120,
              rot: 0,
              flip: 0,
              flags: 6553603,
              props: pProps,
            });
            emittedGates.push({ gateNum: gd.gn, parentId: tapObjId, childId: pid });
            routingPorts.set(pid, {
              objId: pid,
              parentId: tapObjId,
              cls: 'EConnection',
              cx: sx,
              cy: sy,
              hidden: false,
              exitNormal: gd.norm,
            });
            if (gd.gn === 1) leftPid = pid;
            if (gd.gn === 3) rightPid = pid;
            if (gd.isTap) {
              portObjIdByEdgeEnd.set(`${item.edge.id}::${item.side}`, pid);
            }
          }
          if (prevRightPid !== null && leftPid >= 0) {
            manifoldBridgePairs.push({ portA: prevRightPid, portB: leftPid, kind: 'ELine' });
          }
          prevRightPid = rightPid;
        }
      }
    }

    if (isValve) {
      let nextGate = gates.length + 1;
      const gy = Math.round((y1 + y2) / 2);
      const emitSideUe = (act: ValveActuationSide | undefined, isLeft: boolean): void => {
        const gx = isLeft ? x1 + 2048 : x2 - 2048;
        const ueProps = act?.type === 'solenoid' && act.label ? [` S label S ${act.label}`] : [];
        const ueId = pushObj({
          cls: 'UEConnection',
          x1: gx - 1024,
          y1: gy - 1024,
          x2: gx + 1024,
          y2: gy + 1024,
          rot: 0,
          flip: 0,
          flags: 0,
          props: ueProps,
        });
        emittedGates.push({ gateNum: nextGate++, parentId: compObjId, childId: ueId });
      };
      const emitSideUm = (act: ValveActuationSide | undefined, isLeft: boolean): void => {
        if (!act || (act.type !== 'roller' && act.type !== 'idle_return_roller') || !act.label) return;
        const gx = isLeft ? x1 + 2048 : x2 - 2048;
        const umId = pushObj({
          cls: 'UMConnection',
          x1: gx - 1024,
          y1: gy - 1024,
          x2: gx + 1024,
          y2: gy + 1024,
          rot: 0,
          flip: 0,
          flags: 0,
          props: [` S label S ${act.label}`],
        });
        emittedGates.push({ gateNum: nextGate++, parentId: compObjId, childId: umId });
      };
      emitSideUe(comp.leftActuation, true);
      emitSideUe(comp.rightActuation, false);
      emitSideUm(comp.leftActuation, true);
      emitSideUm(comp.rightActuation, false);
    }

    const isCylinderWithRule =
      (comp.type === 'cylinder_double_acting' ||
        comp.type === 'cylinder_single_acting' ||
        comp.type === 'cylinder_rodless') &&
      comp.distanceRule &&
      comp.distanceRule.length > 0;
    if (isCylinderWithRule && comp.distanceRule) {
      const drH = 8 * 1024;
      const drY2 = Math.max(titleY2 + 22 * 1024, y1 - 3 * 1024);
      const drY1 = Math.max(titleY2 + 21 * 1024, drY2 - drH);
      const drProps: string[] = [` S _MCP_OWNER_ID S ${comp.id}`];
      comp.distanceRule.forEach((m, idx) => {
        drProps.push(` S label${idx} S ${m.label}`);
        drProps.push(` S pos${idx} F ${m.positionMm}`);
      });
      pushObj({
        cls: 'R_SCHALT',
        x1,
        y1: drY1,
        x2: Math.max(x2, x1 + 30 * 1024),
        y2: drY2,
        rot: 0,
        flip: 0,
        flags: 0,
        props: drProps,
      });
      reservedLabelBoxesMm.push({
        x: lxMm,
        y: Math.max(10, lyMm - 11),
        width: Math.max(tBox.w, 30),
        height: 9,
      });
    }

    const isActuator =
      comp.type === 'cylinder_double_acting' ||
      comp.type === 'cylinder_single_acting' ||
      comp.type === 'cylinder_rodless' ||
      comp.type === 'swivel_drive' ||
      comp.type === 'air_motor';
    labelableSymbols.push({
      id: comp.id,
      type: comp.type,
      label: comp.label,
      sectionLabel: comp.sectionLabel,
      boxMm: { x: lxMm, y: lyMm, width: tBox.w, height: tBox.h },
      isActuator,
      isValve,
    });
  }

  // 5. Route all non-collapsed connections + manifold bridges via unified `routeCtConnections`
  const routingEdges: CtRoutingEdge[] = [];
  const edgeMetaByKey = new Map<
    string,
    { kind: 'PLine' | 'ELine'; fromPid: number; toPid: number; edgeId?: string; isManifoldLink?: boolean }
  >();

  for (let i = 0; i < manifoldBridgePairs.length; i++) {
    const bp = manifoldBridgePairs[i];
    const key = `__mbridge_${i}`;
    routingEdges.push({ key, fromPortId: bp.portA, toPortId: bp.portB, isManifoldBridge: true });
    edgeMetaByKey.set(key, { kind: bp.kind, fromPid: bp.portA, toPid: bp.portB, isManifoldLink: true });
  }

  for (const edge of laidOut.connections) {
    if (collapsedEdgeIds.has(edge.id)) continue;
    const fromPid =
      portObjIdByEdgeEnd.get(`${edge.id}::from`) ??
      portObjIdByCompPort.get(`${edge.from.componentId}::${edge.from.port}`);
    const toPid =
      portObjIdByEdgeEnd.get(`${edge.id}::to`) ??
      portObjIdByCompPort.get(`${edge.to.componentId}::${edge.to.port}`);
    if (fromPid === undefined || toPid === undefined) continue;
    routingEdges.push({ key: edge.id, fromPortId: fromPid, toPortId: toPid });
    edgeMetaByKey.set(edge.id, {
      kind: edge.domain === 'electrical' ? 'ELine' : 'PLine',
      fromPid,
      toPid,
      edgeId: edge.id,
    });
  }

  const routedPaths = routeCtConnections({
    bounds: {
      minX: printable.minX,
      minY: originOffsetY - 6 * 1024,
      maxX: printable.maxX,
      maxY: printable.maxY,
    },
    obstacles: routingObstacles,
    ports: routingPorts,
    edges: routingEdges,
  });

  const wireSegmentsMm: WireSegmentMm[] = [];
  const connectionLines: string[] = [];

  for (const [key, meta] of edgeMetaByKey.entries()) {
    const pts = routedPaths.get(key);
    const portA = routingPorts.get(meta.fromPid);
    const portObjA = emittedObjects[meta.fromPid];
    if (pts && pts.length >= 2 && portA && portObjA) {
      for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        if (a.x === b.x && a.y === b.y) continue;
        const dx1 = a.x - portA.cx + 5120;
        const dy1 = a.y - portA.cy + 5120;
        const dx2 = b.x - portA.cx - 5120;
        const dy2 = b.y - portA.cy - 5120;
        portObjA.props.push(`L ${dx1} ${dy1} ${dx2} ${dy2}`);
        wireSegmentsMm.push({
          x1: (a.x - originOffsetX) / unitPerMm,
          y1: (a.y - originOffsetY) / unitPerMm + 32,
          x2: (b.x - originOffsetX) / unitPerMm,
          y2: (b.y - originOffsetY) / unitPerMm + 32,
          netId: key,
        });
      }
    }
    const connProps: string[] = [];
    if (meta.edgeId) connProps.push(` S _MCP_EDGE_ID S ${meta.edgeId}`);
    if (meta.isManifoldLink) connProps.push(' S _MCP_MANIFOLD_LINK B T');
    connectionLines.push(`CON ${meta.kind} ${meta.fromPid} ${meta.toPid}`);
    for (const cp of connProps) connectionLines.push(cp);
  }

  // 6. Place collision-free component designation labels & section banners
  const placedLabels = placeSchematicLabels({
    symbols: labelableSymbols,
    wireSegmentsMm,
    sheetBoundsMm: {
      x: 4,
      y: 34,
      width: Math.max(120, sheetWidthMm - 8),
      height: Math.max(100, sheetHeightMm - 42),
    },
    reservedBoxesMm: reservedLabelBoxesMm,
  });

  for (const lbl of placedLabels) {
    const lx1 = mmToRawX(lbl.xMm);
    const ly1 = mmToRawY(lbl.yMm);
    const lx2 = lx1 + lenToRaw(lbl.widthMm);
    const ly2 = ly1 + lenToRaw(lbl.heightMm);
    if (ly1 < titleY2 + 21 * 1024 || lx2 > printable.maxX || ly2 > printable.maxY) continue;
    const hitsExisting = emittedObjects.some(
      (o) =>
        !PORT_CLASSES.has(o.cls) &&
        lx1 < o.x2 + 1024 &&
        lx2 > o.x1 - 1024 &&
        ly1 < o.y2 + 1024 &&
        ly2 > o.y1 - 1024,
    );
    if (hitsExisting) continue;
    pushObj({
      cls: 'text',
      x1: lx1,
      y1: ly1,
      x2: lx2,
      y2: ly2,
      rot: 0,
      flip: 0,
      flags: 0,
      props: [
        ` S text S ${lbl.text}`,
        ` S _MCP_LABEL_FOR S ${lbl.ownerId}`,
        ...(lbl.kind === 'section' ? [' S _MCP_LABEL_KIND S section'] : []),
      ],
    });
  }

  const bodyLines: string[] = [];
  for (const obj of emittedObjects) {
    bodyLines.push(
      `${obj.cls} O${obj.objId} ${obj.x1} ${obj.y1} ${obj.x2} ${obj.y2} ${obj.rot} ${obj.flip} ${obj.flags}`,
    );
    for (const p of obj.props) bodyLines.push(p);
  }
  for (const g of emittedGates) {
    bodyLines.push(`gate${g.gateNum} # ${g.parentId} ${g.childId}`);
  }
  for (const cl of connectionLines) {
    bodyLines.push(cl);
  }

  const symBlock = symAlloc.toTrailerSection() || 'BEGINSYM\nENDSYM\n';
  const trailerText = `ENDCT\nBEGINDSD\nENDDSD\n${symBlock}`;
  const isA3 = sheetWidthMm > 300 || sheetHeightMm > 220;
  const keepHeader =
    preserved &&
    preserved.kind === 'fluidsim-4.5-ct' &&
    !(isA3 && isDefaultA4Header(preserved.headerLinesB64));

  return {
    ...(keepHeader ? { headerLinesB64: preserved.headerLinesB64, profile: preserved.profile } : {}),
    ctBody: bodyLines.join('\n'),
    trailerText,
  };
}

export interface CtTextInvariantReport {
  ok: boolean;
  badJunctions: Array<{ cls: string; objId: number; gateCount: number; reason?: string }>;
  f9Solver: ValveSolverInvariantReport;
}

export function verifyCtTextInvariants(ctBody: string): CtTextInvariantReport {
  const f9Solver = verifyCtValveSolverInvariants(ctBody);
  const badJunctions = f9Solver.junctionErrors.map((e) => ({
    cls: e.cls,
    objId: e.objId,
    gateCount: e.gateCount,
    reason: e.reason,
  }));
  return {
    ok: badJunctions.length === 0 && f9Solver.ok,
    badJunctions,
    f9Solver,
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
  wireGeometry: CtWireGeometryReport;
  f9Solver: ValveSolverInvariantReport;
}

const DXF_SYMBOL_REQUIRED_CLASSES = new Set([
  'CylDGPPAB',
  'WV_2',
  'WV_3',
  'WV_4',
  'WV_5',
  'DRSV2_pneu',
  'DV_P1',
  'FilterP',
  'CheckValveP',
  'CheckValveSpringLoadedP',
  'CheckValvePilotOperatedSpringLoadedP',
  'Wartungseinheit2',
  'PVS1',
  'PVS2',
  'PVS3',
  'NozzleP',
]);

export function verifyCtVisualLayoutInvariants(
  ctBody: string,
  trailerText: string,
  options?: { sheetWidthMm?: number; sheetHeightMm?: number },
): CtVisualLayoutInvariantReport {
  const ast = parseCtBodyAst(ctBody);

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

  const wireGeometry = verifyCtWireGeometryInvariants(ctBody, options);
  const f9Solver = verifyCtValveSolverInvariants(ctBody);

  return {
    ok:
      missingSymbols.length === 0 &&
      missingDxfPrimList.length === 0 &&
      negativeCoordObjects.length === 0 &&
      titleCollisions.length === 0 &&
      overlaps.length === 0 &&
      wireGeometry.ok &&
      f9Solver.ok,
    symCount: symIds.size,
    missingSymbols,
    missingDxfPrimList,
    negativeCoordObjects,
    titleCollisions,
    overlaps,
    wireGeometry,
    f9Solver,
  };
}
