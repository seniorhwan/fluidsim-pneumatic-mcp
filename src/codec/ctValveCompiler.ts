/**
 * Authentic FluidSIM Pneumatics 4.5 Configurable Valve Compiler (WV_2, WV_3, WV_4, WV_5).
 *
 * Eliminates the FluidSIM 4.5 F9 simulation fatal crash (Error Code 692 in Module 97098)
 * by emitting 100% authentic solver state-machine properties verified directly against
 * official FluidSIM 4.5 golden `.ct` circuits:
 *   - Exact `CV_ID` grammar: `<rSpr><rMA><rME><rElPn><lSpr><lMA><lME><lElPn><posResetIdx><rBody><lBody>`
 *   - Mandatory `VALUECLASS`, `POS`, `POS_RESET`, `SWITCHED_POS`, `SWITCHED_POS_R`, `SWITCHED_POS_M`
 *   - Mandatory `OFFSET_*`, `DOMINANT`, `AFL`, `AFR`, `BODY_COUNT`, `CONF_L`, `CONF_R`, `DIR`, `DIR2`, `NN_FLOW`
 *   - Authentic actuation codes (`AL_PE1` + `PILOT_L B T` for internally piloted solenoid — NEVER invalid `AL_PE1_PE2`!)
 *   - Canonical rot=0, flip=0 ISO 1219 valve vector primitives (`SymPrimitive[]`)
 */

import type { ComponentNode, ValveActuationSide } from '../contracts/circuit';
import type { SymPrimitive } from './ctTransform';
import { getFluidSim45Prototype } from './prototypes/fluidsim45Prototypes';

export type FluidSimValveClass = 'WV_2' | 'WV_3' | 'WV_4' | 'WV_5';

export interface CompiledValveSpec {
  cls: FluidSimValveClass;
  flipOffset: number;
  gdiFlags: number;
  bodyCount: 2 | 3;
  cvId: string;
  props: string[];
  symPrimitives: SymPrimitive[];
  conDescrProps: string[];
}

export interface ValveSolverInvariantReport {
  ok: boolean;
  checkedValves: number;
  checkedJunctions: number;
  valveErrors: Array<{ cls: string; objId: number; reason: string }>;
  junctionErrors: Array<{ cls: string; objId: number; gateCount: number; reason: string }>;
}

interface EncodedActuationSide {
  spring: boolean;
  pneuSpring: boolean;
  maCode: string; // ALN / AL_MA1 / AL_MA3 / AL_MA4F / AL_MA5 (or AR...)
  meCode: string; // ALN / AL_ME2 / AL_ME3 (or AR...)
  elPnCode: string; // ALN / AL_PE1 / AL_PE2 (or AR...)
  internalPilot: boolean;
  cvSpringBit: '0' | '1';
  cvMaTok: string;
  cvMeTok: string;
  cvElPnTok: string;
}

function encodeSide(side: ValveActuationSide | undefined, isLeft: boolean): EncodedActuationSide {
  const prefix = isLeft ? 'AL' : 'AR';
  const none = isLeft ? 'ALN' : 'ARN';

  let spring = false;
  let pneuSpring = false;
  let maCode = none;
  let meCode = none;
  let elPnCode = none;
  let internalPilot = false;

  if (side) {
    switch (side.type) {
      case 'spring':
        spring = true;
        break;
      case 'pneumatic_spring':
        pneuSpring = true;
        if (side.springReturn !== false) spring = true;
        break;
      case 'pushbutton':
        maCode = `${prefix}_MA5`;
        break;
      case 'detent':
        maCode = `${prefix}_MA4F`;
        break;
      case 'roller':
        meCode = `${prefix}_ME2`;
        break;
      case 'idle_return_roller':
        meCode = `${prefix}_ME3`;
        break;
      case 'pneumatic_pilot':
        elPnCode = `${prefix}_PE2`;
        break;
      case 'solenoid':
        // FluidSIM 4.5 strictly uses AL_PE1 / AR_PE1 + optional PILOT_L/R B T (NEVER AL_PE1_PE2!)
        elPnCode = `${prefix}_PE1`;
        if (side.internalPilot) internalPilot = true;
        break;
      case 'none':
      default:
        break;
    }

    // Composite manual override alongside solenoid / pilot
    if (side.manualOverride && maCode === none) {
      maCode = `${prefix}_MA1`;
    }
    if (side.springReturn && !spring) {
      spring = true;
    }
  }

  const stripPrefix = (code: string): string => {
    if (code === none) return 'N';
    return code.slice(2); // e.g. "_MA5", "_MA4F", "_ME2", "_PE1", "_PE2"
  };

  return {
    spring,
    pneuSpring,
    maCode,
    meCode,
    elPnCode,
    internalPilot,
    cvSpringBit: spring ? '1' : '0',
    cvMaTok: stripPrefix(maCode),
    cvMeTok: stripPrefix(meCode),
    cvElPnTok: stripPrefix(elPnCode),
  };
}

function getValveBodyCodes(comp: ComponentNode): {
  cls: FluidSimValveClass;
  description: string;
  bodyCount: 2 | 3;
  flipOffset: number;
  gdiFlags: number;
  leftState: string;
  rightState: string;
  midState?: string;
  leftBodyCv: string;
  rightBodyCv: string;
  midBodyCv?: string;
  offsets: string[];
  conDescrCount: number;
} {
  const isNormallyOpen =
    comp.params.normallyOpen === true || String(comp.params.normalState ?? '').toUpperCase() === 'NO';

  switch (comp.type) {
    case 'valve_2_2': {
      const leftCode = isNormallyOpen ? 'C2C' : 'C2P';
      const rightCode = isNormallyOpen ? 'C2P' : 'C2C';
      return {
        cls: 'WV_2',
        description: '2/n Way Valve',
        bodyCount: 2,
        flipOffset: -18432,
        gdiFlags: 1617923,
        leftState: `(1\t${leftCode})`,
        rightState: `(2\t${rightCode})`,
        leftBodyCv: leftCode.slice(1),
        rightBodyCv: rightCode.slice(1),
        offsets: [
          ' S OFFSET_(2tC4C) I 0',
          ' S OFFSET_(2tC2C) I -18',
          ' S OFFSET_(1tC4P) I 24',
          ' S OFFSET_(1tC2P) I 6',
        ],
        conDescrCount: 8,
      };
    }
    case 'valve_3_2': {
      const leftCode = isNormallyOpen ? 'C3C' : 'C3P';
      const rightCode = isNormallyOpen ? 'C3P' : 'C3C';
      return {
        cls: 'WV_3',
        description: '3/n Way Valve',
        bodyCount: 2,
        flipOffset: -18432,
        gdiFlags: 1617923,
        leftState: `(1\t${leftCode})`,
        rightState: `(2\t${rightCode})`,
        leftBodyCv: leftCode.slice(1),
        rightBodyCv: rightCode.slice(1),
        offsets: [
          ' S OFFSET_(2tC4C) I 0',
          ' S OFFSET_(2tC3C) I -18',
          ' S OFFSET_(1tC4P) I 24',
          ' S OFFSET_(1tC3P) I 6',
        ],
        conDescrCount: 9,
      };
    }
    case 'valve_4_2':
      return {
        cls: 'WV_4',
        description: '4/n Way Valve',
        bodyCount: 2,
        flipOffset: -18432,
        gdiFlags: 3102723,
        leftState: '(1\tC4CP)',
        rightState: '(2\tC4PC)',
        leftBodyCv: '4CP',
        rightBodyCv: '4PC',
        offsets: [
          ' S OFFSET_(1tC4CP) I 6',
          ' S OFFSET_(2tC4PC) I -18',
          ' S OFFSET_(2tC4C) I 0',
          ' S OFFSET_(1tC4P) I 24',
        ],
        conDescrCount: 10,
      };
    case 'valve_5_3': {
      const centerType = String(comp.params.centerType ?? 'closed').toLowerCase();
      const midCode =
        centerType === 'exhaust' || centerType === 'open_exhaust'
          ? 'C5E'
          : centerType === 'pressurized'
            ? 'C5P'
            : 'C5C';
      return {
        cls: 'WV_5',
        description: '5/n Way Valve',
        bodyCount: 3,
        flipOffset: -30720,
        gdiFlags: 3102723,
        leftState: '(1\tC5CPB)',
        midState: `(2\t${midCode})`,
        rightState: '(3\tC5PCB)',
        leftBodyCv: '5CPB',
        midBodyCv: midCode.slice(1),
        rightBodyCv: '5PCB',
        offsets: [
          ' S OFFSET_(1tC5CPB) I 6',
          ' S OFFSET_(3tC5PCB) I -30',
          ' S OFFSET_(2tC4C) I 0',
          ' S OFFSET_(1tC4P) I 24',
        ],
        conDescrCount: 11,
      };
    }
    case 'valve_5_2':
    default:
      return {
        cls: 'WV_5',
        description: '5/n Way Valve',
        bodyCount: 2,
        flipOffset: -30720,
        gdiFlags: 3102723,
        leftState: '(1\tC5CPB)',
        rightState: '(2\tC5PCB)',
        leftBodyCv: '5CPB',
        rightBodyCv: '5PCB',
        offsets: [
          ' S OFFSET_(1tC5CPB) I 6',
          ' S OFFSET_(2tC5PCB) I -30',
          ' S OFFSET_(2tC4C) I 0',
          ' S OFFSET_(1tC4P) I 24',
        ],
        conDescrCount: 11,
      };
  }
}

/**
 * Generates canonical rot=0, FLIPPED=0 ISO 1219 valve vector primitives (mm)
 * matching the valve's way-count, NC/NO state, and left/right composite actuation symbols.
 */
export function buildValveSymPrimitives(comp: ComponentNode): SymPrimitive[] {
  const proto = getFluidSim45Prototype(comp.type);
  const w = proto?.sizeMm.width ?? 36;
  const h = proto?.sizeMm.height ?? 12;
  const is53 = comp.type === 'valve_5_3';
  const boxW = 8;
  const numBoxes = is53 ? 3 : 2;
  const totalBoxesW = boxW * numBoxes;
  const bx0 = (w - totalBoxesW) / 2;
  const by0 = 2;
  const by1 = h - 2;
  const primitives: SymPrimitive[] = [];

  // Valve squares
  for (let i = 0; i < numBoxes; i++) {
    primitives.push({
      kind: 'rect',
      x1: bx0 + i * boxW,
      y1: by0,
      x2: bx0 + (i + 1) * boxW,
      y2: by1,
    });
  }

  const isNO =
    comp.params.normallyOpen === true || String(comp.params.normalState ?? '').toUpperCase() === 'NO';

  // Internal ISO 1219 flow arrows / T-blocks per square
  if (comp.type === 'valve_2_2' || comp.type === 'valve_3_2') {
    const drawPassBox = (x0: number): void => {
      // Straight upward arrow 1 -> 2
      primitives.push({ kind: 'line', x1: x0 + 2.5, y1: by1, x2: x0 + 2.5, y2: by0 });
      primitives.push({
        kind: 'poly',
        points: [
          { x: x0 + 2.5, y: by0 + 0.3 },
          { x: x0 + 1.6, y: by0 + 2.2 },
          { x: x0 + 3.4, y: by0 + 2.2 },
        ],
        fill: true,
      });
      if (comp.type === 'valve_3_2') {
        // Blocked port 3 T-bar
        primitives.push({ kind: 'line', x1: x0 + 5.8, y1: by1, x2: x0 + 5.8, y2: by1 - 2.2 });
        primitives.push({ kind: 'line', x1: x0 + 4.8, y1: by1 - 2.2, x2: x0 + 6.8, y2: by1 - 2.2 });
      }
    };
    const drawBlockOrExhaustBox = (x0: number): void => {
      // Blocked port 1 T-bar
      primitives.push({ kind: 'line', x1: x0 + 2.5, y1: by1, x2: x0 + 2.5, y2: by1 - 2.2 });
      primitives.push({ kind: 'line', x1: x0 + 1.5, y1: by1 - 2.2, x2: x0 + 3.5, y2: by1 - 2.2 });
      if (comp.type === 'valve_3_2') {
        // Exhaust diagonal arrow 2 -> 3
        primitives.push({ kind: 'line', x1: x0 + 2.5, y1: by0, x2: x0 + 5.8, y2: by1 });
        primitives.push({
          kind: 'poly',
          points: [
            { x: x0 + 5.8, y: by1 - 0.3 },
            { x: x0 + 4.3, y: by1 - 1.8 },
            { x: x0 + 5.9, y: by1 - 2.3 },
          ],
          fill: true,
        });
      } else {
        // Blocked port 2 T-bar
        primitives.push({ kind: 'line', x1: x0 + 2.5, y1: by0, x2: x0 + 2.5, y2: by0 + 2.2 });
        primitives.push({ kind: 'line', x1: x0 + 1.5, y1: by0 + 2.2, x2: x0 + 3.5, y2: by0 + 2.2 });
      }
    };
    if (isNO) {
      drawBlockOrExhaustBox(bx0);
      drawPassBox(bx0 + boxW);
    } else {
      drawPassBox(bx0);
      drawBlockOrExhaustBox(bx0 + boxW);
    }
  } else {
    // 4/2, 5/2, 5/3 arrows
    const drawLeftFlow = (x0: number): void => {
      // 1 -> 4 (left-up), 2 -> 3 (right-down)
      primitives.push({ kind: 'line', x1: x0 + 4, y1: by1, x2: x0 + 2, y2: by0 });
      primitives.push({ kind: 'line', x1: x0 + 6, y1: by0, x2: x0 + 6.5, y2: by1 });
      if (comp.type !== 'valve_4_2') {
        primitives.push({ kind: 'line', x1: x0 + 1.5, y1: by1, x2: x0 + 1.5, y2: by1 - 2 });
        primitives.push({ kind: 'line', x1: x0 + 0.7, y1: by1 - 2, x2: x0 + 2.3, y2: by1 - 2 });
      }
    };
    const drawRightFlow = (x0: number): void => {
      // 1 -> 2 (right-up), 4 -> 5/3 (left-down)
      primitives.push({ kind: 'line', x1: x0 + 4, y1: by1, x2: x0 + 6, y2: by0 });
      primitives.push({ kind: 'line', x1: x0 + 2, y1: by0, x2: x0 + 1.5, y2: by1 });
      if (comp.type !== 'valve_4_2') {
        primitives.push({ kind: 'line', x1: x0 + 6.5, y1: by1, x2: x0 + 6.5, y2: by1 - 2 });
        primitives.push({ kind: 'line', x1: x0 + 5.7, y1: by1 - 2, x2: x0 + 7.3, y2: by1 - 2 });
      }
    };
    drawLeftFlow(bx0);
    if (is53) {
      // Center closed T-blocks
      const mx0 = bx0 + boxW;
      primitives.push({ kind: 'line', x1: mx0 + 2, y1: by0, x2: mx0 + 2, y2: by0 + 2.2 });
      primitives.push({ kind: 'line', x1: mx0 + 1, y1: by0 + 2.2, x2: mx0 + 3, y2: by0 + 2.2 });
      primitives.push({ kind: 'line', x1: mx0 + 6, y1: by0, x2: mx0 + 6, y2: by0 + 2.2 });
      primitives.push({ kind: 'line', x1: mx0 + 5, y1: by0 + 2.2, x2: mx0 + 7, y2: by0 + 2.2 });
      primitives.push({ kind: 'line', x1: mx0 + 4, y1: by1, x2: mx0 + 4, y2: by1 - 2.2 });
      primitives.push({ kind: 'line', x1: mx0 + 3, y1: by1 - 2.2, x2: mx0 + 5, y2: by1 - 2.2 });
      drawRightFlow(bx0 + 2 * boxW);
    } else {
      drawRightFlow(bx0 + boxW);
    }
  }

  // Left & Right actuation end graphics
  const drawSideActuation = (side: ValveActuationSide | undefined, isLeft: boolean): void => {
    if (!side || side.type === 'none') return;
    const edgeX = isLeft ? bx0 : bx0 + totalBoxesW;
    const dir = isLeft ? -1 : 1;

    const drawSpring = (ox: number): void => {
      primitives.push({ kind: 'line', x1: ox, y1: by0 + 2, x2: ox + dir * 1.5, y2: by1 - 2 });
      primitives.push({ kind: 'line', x1: ox + dir * 1.5, y1: by1 - 2, x2: ox + dir * 3, y2: by0 + 2 });
      primitives.push({ kind: 'line', x1: ox + dir * 3, y1: by0 + 2, x2: ox + dir * 4.5, y2: by1 - 2 });
    };

    if (side.type === 'spring') {
      drawSpring(edgeX);
    } else if (side.type === 'pneumatic_spring') {
      drawSpring(edgeX);
      // Pneumatic spring triangle beneath/beside spring
      primitives.push({
        kind: 'poly',
        points: [
          { x: edgeX + dir * 4.5, y: by1 - 2.5 },
          { x: edgeX + dir * 2.5, y: by1 - 1 },
          { x: edgeX + dir * 2.5, y: by1 - 4 },
        ],
      });
    } else if (side.type === 'solenoid') {
      const sx1 = Math.min(edgeX, edgeX + dir * 4.8);
      const sx2 = Math.max(edgeX, edgeX + dir * 4.8);
      primitives.push({ kind: 'rect', x1: sx1, y1: by0 + 1.5, x2: sx2, y2: by1 - 1.5 });
      primitives.push({ kind: 'line', x1: sx1 + 1, y1: by1 - 1.5, x2: sx2 - 1, y2: by0 + 1.5 });
      if (side.internalPilot) {
        primitives.push({
          kind: 'poly',
          points: [
            { x: edgeX + dir * 0.4, y: by0 + 4 },
            { x: edgeX + dir * 1.8, y: by0 + 2.8 },
            { x: edgeX + dir * 1.8, y: by0 + 5.2 },
          ],
        });
      }
      if (side.manualOverride) {
        const mx = edgeX + dir * 5.8;
        primitives.push({ kind: 'line', x1: edgeX + dir * 4.8, y1: by0 + 3, x2: mx, y2: by0 + 3 });
        primitives.push({ kind: 'line', x1: mx, y1: by0 + 1.8, x2: mx, y2: by0 + 4.2 });
      }
    } else if (side.type === 'pneumatic_pilot') {
      const px1 = Math.min(edgeX, edgeX + dir * 4.5);
      const px2 = Math.max(edgeX, edgeX + dir * 4.5);
      primitives.push({ kind: 'rect', x1: px1, y1: by0 + 1.5, x2: px2, y2: by1 - 1.5 });
      primitives.push({
        kind: 'poly',
        points: [
          { x: edgeX + dir * 0.8, y: by0 + 4 },
          { x: edgeX + dir * 3.5, y: by0 + 2.5 },
          { x: edgeX + dir * 3.5, y: by0 + 5.5 },
        ],
      });
    } else if (side.type === 'pushbutton' || side.type === 'detent') {
      primitives.push({ kind: 'line', x1: edgeX, y1: by0 + 2.5, x2: edgeX + dir * 4, y2: by0 + 2.5 });
      primitives.push({ kind: 'line', x1: edgeX, y1: by1 - 2.5, x2: edgeX + dir * 4, y2: by1 - 2.5 });
      primitives.push({ kind: 'line', x1: edgeX + dir * 4, y1: by0 + 1.5, x2: edgeX + dir * 4, y2: by1 - 1.5 });
      if (side.type === 'detent') {
        primitives.push({ kind: 'line', x1: edgeX + dir * 2, y1: by0 + 1, x2: edgeX + dir * 2.8, y2: by0 + 2.5 });
      }
    } else if (side.type === 'roller' || side.type === 'idle_return_roller') {
      primitives.push({ kind: 'line', x1: edgeX, y1: by0 + 3, x2: edgeX + dir * 3, y2: by0 + 3 });
      primitives.push({ kind: 'circle', cx: edgeX + dir * 4.2, cy: by0 + 3, r: 1.2 });
    }
  };

  drawSideActuation(comp.leftActuation, true);
  drawSideActuation(comp.rightActuation, false);

  return primitives;
}

/**
 * Compiles any directional valve ComponentNode into 100% authentic FluidSIM 4.5 WV_* properties
 * that pass both F6 (superficial drawing check) and F9 (FluidSIM solver simulation without Error 692).
 */
export function compileFluidSim45Valve(comp: ComponentNode): CompiledValveSpec {
  const body = getValveBodyCodes(comp);
  const left = encodeSide(comp.leftActuation, true);
  const right = encodeSide(comp.rightActuation, false);

  const flow =
    typeof comp.params.nominalFlowLMin === 'number' && Number.isFinite(comp.params.nominalFlowLMin)
      ? comp.params.nominalFlowLMin
      : 300;

  // Determine initial/reset position
  const initialState = String(comp.params.initialState ?? 'right').toLowerCase();
  const isInitialLeft = initialState === 'left';
  const isCenter = body.bodyCount === 3;

  const posReset = isCenter
    ? body.midState!
    : isInitialLeft
      ? body.leftState
      : body.rightState;
  const posResetIdx = isCenter ? '2' : isInitialLeft ? '0' : '1';

  const valueClass = isCenter
    ? `${body.leftState} ${body.midState} ${body.rightState}`
    : `${body.leftState} ${body.rightState}`;

  // Authentic FluidSIM 4.5 CV_ID formula verified across all 6 golden fixtures:
  // <rSpr><rMA><rME><rElPn><lSpr><lMA><lME><lElPn><posResetIdx><rBody>[<mBody>]<lBody>
  const cvId = isCenter
    ? `${right.cvSpringBit}${right.cvMaTok}${right.cvMeTok}${right.cvElPnTok}${left.cvSpringBit}${left.cvMaTok}${left.cvMeTok}${left.cvElPnTok}${posResetIdx}${body.rightBodyCv}${body.midBodyCv}${body.leftBodyCv}`
    : `${right.cvSpringBit}${right.cvMaTok}${right.cvMeTok}${right.cvElPnTok}${left.cvSpringBit}${left.cvMaTok}${left.cvMeTok}${left.cvElPnTok}${posResetIdx}${body.rightBodyCv}${body.leftBodyCv}`;

  const props: string[] = [
    ...body.offsets,
    ' S description_FEST B T',
    ` S description S ${body.description}`,
    ' F enum UNKNOWN B T',
    ' S PNEU_SPRING_R_FEST B T',
    ` S PNEU_SPRING_R S ${right.pneuSpring ? 'TRUE' : 'FALSE'}`,
    ' S SPRING_L_FEST B T',
    ` S SPRING_L S ${left.spring ? 'TRUE' : 'FALSE'}`,
    ' S SPRING_R_FEST B T',
    ` S SPRING_R S ${right.spring ? 'TRUE' : 'FALSE'}`,
    ' S DOMINANT_FEST B T',
    ' S DOMINANT F 1',
    ' S AFL_FEST B T',
    ' S AFL F 10',
    ' S AFR_FEST B T',
    ' S AFR F 10',
    ` S BODY_COUNT I ${body.bodyCount}`,
    ' S SWITCHED_POS_R_FEST B T',
    ` S SWITCHED_POS_R S ${body.rightState}`,
    ...(body.midState
      ? [' S SWITCHED_POS_M_FEST B T', ` S SWITCHED_POS_M S ${body.midState}`]
      : []),
    ' S ACTUATION_R_EL_PN_FEST B T',
    ` S ACTUATION_R_EL_PN S ${right.elPnCode}`,
    ...(right.internalPilot ? [' S PILOT_R_FEST B T', ' S PILOT_R B T'] : []),
    ' S ACTUATION_R_ME_FEST B T',
    ` S ACTUATION_R_ME S ${right.meCode}`,
    ' S CONF_L I 0',
    ' S ACTUATION_R_MA_FEST B T',
    ` S ACTUATION_R_MA S ${right.maCode}`,
    ' S ACTUATION_L_EL_PN_FEST B T',
    ` S ACTUATION_L_EL_PN S ${left.elPnCode}`,
    ...(left.internalPilot ? [' S PILOT_L_FEST B T', ' S PILOT_L B T'] : []),
    ' S ACTUATION_L_ME_FEST B T',
    ` S ACTUATION_L_ME S ${left.meCode}`,
    ' S ACTUATION_L_MA_FEST B T',
    ` S ACTUATION_L_MA S ${left.maCode}`,
    ' S CONF_R I 0',
    ' S CV_ID_FEST B T',
    ` S CV_ID S ${cvId}`,
    ' S SWITCHED_POS_FEST B T',
    ` S SWITCHED_POS S ${body.leftState}`,
    ' S VALUECLASS_FEST B T',
    ` S VALUECLASS S ${valueClass}`,
    ' S POS_RESET_FEST B T',
    ` S POS_RESET S ${posReset}`,
    ' S DIR_FEST B T',
    ' S DIR S NA',
    ' S NN_FLOW_FEST B T',
    ` S NN_FLOW F ${flow}`,
    ' S POS_FEST B T',
    ` S POS S ${posReset}`,
    ' S DIR2_FEST B T',
    ' S DIR2 S NA',
    ' S PNEU_SPRING_L_FEST B T',
    ` S PNEU_SPRING_L S ${left.pneuSpring ? 'TRUE' : 'FALSE'}`,
  ];

  const conDescrProps: string[] = [];
  for (let i = 1; i <= body.conDescrCount; i++) {
    conDescrProps.push(` F con_descr${i} x_offset I 0`);
    conDescrProps.push(` F con_descr${i} y_offset I 0`);
  }

  return {
    cls: body.cls,
    flipOffset: body.flipOffset,
    gdiFlags: body.gdiFlags,
    bodyCount: body.bodyCount,
    cvId,
    props,
    symPrimitives: buildValveSymPrimitives(comp),
    conDescrProps,
  };
}

const REQUIRED_VALVE_SOLVER_PROPS = [
  'S CV_ID S ',
  'S VALUECLASS S ',
  'S POS S ',
  'S POS_RESET S ',
  'S SWITCHED_POS S ',
  'S SWITCHED_POS_R S ',
  'S OFFSET_',
  'S DOMINANT F ',
  'S AFL F ',
  'S AFR F ',
  'S DIR S ',
  'S DIR2 S ',
  'S CONF_L I ',
  'S CONF_R I ',
  'S BODY_COUNT I ',
] as const;

/**
 * Verifies FluidSIM 4.5 F9 solver safety invariants on a decoded `.ct` body:
 *   1. Every WV_2 / WV_3 / WV_4 / WV_5 valve has all mandatory solver properties (CV_ID, VALUECLASS, POS, etc.)
 *      and NEVER emits invalid AL_PE1_PE2 / AR_PE1_PE2 codes (smoking gun of F9 Error Code 692).
 *   2. Every PTriconnection / ETriconnection emits authentic 3 gates (or 4 only when port 4 is genuinely connected,
 *      NEVER a bogus hidden `S state INT 4` 4th port).
 */
export function verifyCtValveSolverInvariants(ctBody: string): ValveSolverInvariantReport {
  const lines = ctBody.split('\n');
  const objs = new Map<number, { cls: string; props: string[] }>();
  const gatesByParent = new Map<number, number[]>();
  const connectedPorts = new Set<number>();

  let curId = -1;
  for (const ln of lines) {
    const mObj = ln.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+O(\d+)\s+/);
    if (mObj) {
      curId = Number(mObj[2]);
      objs.set(curId, { cls: mObj[1], props: [] });
      continue;
    }
    if (curId >= 0 && ln.startsWith(' ')) {
      objs.get(curId)!.props.push(ln);
      continue;
    }
    curId = -1;
    const mGate = ln.match(/^gate\d+\s+#\s+(\d+)\s+(\d+)/);
    if (mGate) {
      const pid = Number(mGate[1]);
      const cid = Number(mGate[2]);
      const arr = gatesByParent.get(pid) ?? [];
      arr.push(cid);
      gatesByParent.set(pid, arr);
      continue;
    }
    const mCon = ln.match(/^CON\s+[PE]Line\s+(\d+)\s+(\d+)/);
    if (mCon) {
      connectedPorts.add(Number(mCon[1]));
      connectedPorts.add(Number(mCon[2]));
    }
  }

  const valveErrors: ValveSolverInvariantReport['valveErrors'] = [];
  const junctionErrors: ValveSolverInvariantReport['junctionErrors'] = [];
  let checkedValves = 0;
  let checkedJunctions = 0;

  for (const [objId, obj] of objs) {
    if (obj.cls === 'WV_2' || obj.cls === 'WV_3' || obj.cls === 'WV_4' || obj.cls === 'WV_5') {
      checkedValves++;
      const joined = obj.props.join('\n');
      for (const req of REQUIRED_VALVE_SOLVER_PROPS) {
        if (!joined.includes(req)) {
          valveErrors.push({
            cls: obj.cls,
            objId,
            reason: `Missing mandatory FluidSIM 4.5 solver property "${req.trim()}" (causes F9 Error 692).`,
          });
        }
      }
      if (joined.includes('AL_PE1_PE2') || joined.includes('AR_PE1_PE2')) {
        valveErrors.push({
          cls: obj.cls,
          objId,
          reason: 'Invalid actuation token AL_PE1_PE2 / AR_PE1_PE2 (must be AL_PE1/AR_PE1 + PILOT_L/R B T).',
        });
      }
    }

    if (obj.cls === 'PTriconnection' || obj.cls === 'ETriconnection') {
      checkedJunctions++;
      const gates = gatesByParent.get(objId) ?? [];
      // Real FluidSIM 4.5 PTriconnection / ETriconnection has 3 gates (or 4 only when all 4 are real connections,
      // or 0 on legacy FluidSIM 3.x fixtures like 06_electrical_latch_legacy.ct).
      const hasBogusHiddenGate = gates.some((gid) => {
        const child = objs.get(gid);
        return child?.props.some((p) => p.includes('S state INT 4')) ?? false;
      });
      if (hasBogusHiddenGate) {
        junctionErrors.push({
          cls: obj.cls,
          objId,
          gateCount: gates.length,
          reason: 'Emits bogus hidden 4th gate with "S state INT 4"; FluidSIM 4.5 T-junctions must have 3 gates.',
        });
      } else if (gates.length > 4 || (gates.length > 0 && gates.length < 3)) {
        junctionErrors.push({
          cls: obj.cls,
          objId,
          gateCount: gates.length,
          reason: `Unexpected gate count ${gates.length} on ${obj.cls} (expected 3, or 4 when all 4 wired).`,
        });
      } else if (gates.length === 4 && !connectedPorts.has(gates[3])) {
        // Warn/fail if 4th gate is dangling/unconnected
        junctionErrors.push({
          cls: obj.cls,
          objId,
          gateCount: gates.length,
          reason: `4th gate on ${obj.cls} is unconnected; emit 3 gates (gate1..gate3) instead.`,
        });
      }
    }
  }

  return {
    ok: valveErrors.length === 0 && junctionErrors.length === 0,
    checkedValves,
    checkedJunctions,
    valveErrors,
    junctionErrors,
  };
}
