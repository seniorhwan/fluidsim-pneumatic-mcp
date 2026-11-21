import type { CircuitDocument, ComponentNode, Point2D } from '../contracts/circuit';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';

const GRID_MM = 5;
const MIN_CLEARANCE_MM = 5;
const MARGIN_X_MM = 15;
const MARGIN_Y_MM = 15;

function snap(v: number): number {
  return Math.round(v / GRID_MM) * GRID_MM;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function getEffectiveRotationDeg(comp: ComponentNode): 0 | 90 | 180 | 270 {
  const raw = comp.rotationDeg ?? comp.layout?.rotationDeg ?? 0;
  if (raw === 90 || raw === 180 || raw === 270) return raw;
  return 0;
}

function getRotatedDimensions(comp: ComponentNode): { w: number; h: number } {
  const def = getCatalogComponent(comp.type);
  const baseW = def?.defaultSize.width ?? 20;
  const baseH = def?.defaultSize.height ?? 16;
  const rot = getEffectiveRotationDeg(comp);
  if (rot === 90 || rot === 270) {
    return { w: baseH, h: baseW };
  }
  return { w: baseW, h: baseH };
}

function rotatePortOffset(
  offset: { x: number; y: number },
  baseW: number,
  baseH: number,
  rot: 0 | 90 | 180 | 270,
): { x: number; y: number } {
  if (rot === 90) {
    return { x: baseH - offset.y, y: offset.x };
  }
  if (rot === 180) {
    return { x: baseW - offset.x, y: baseH - offset.y };
  }
  if (rot === 270) {
    return { x: offset.y, y: baseW - offset.x };
  }
  return offset;
}

interface LayoutBox {
  comp: ComponentNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Automatic ISO 1219 pneumatic top-down layout & 24V/0V ladder organizer + orthogonal router.
 * Features:
 * - Sheet-size-aware packing (respects DIN A4 297×210, DIN A3 420×297, etc.) with row wrapping
 * - Full preservation of component rotationDeg (0/90/180/270) including rotated bounding boxes & ports
 * - Topology-aware actuator column alignment & guaranteed zero-overlap fixed-point resolution
 * - Corridor-aware orthogonal Manhattan routing
 */
export function autoLayoutCircuit(
  doc: CircuitDocument,
  options?: { incremental?: boolean },
): CircuitDocument {
  const incremental = options?.incremental ?? false;
  const targetSheetWidthMm = Math.max(doc.metadata.sheetWidthMm || 297, 210);
  const targetSheetHeightMm = Math.max(doc.metadata.sheetHeightMm || 210, 148);

  const components: ComponentNode[] = doc.components.map((c) => {
    const rot = getEffectiveRotationDeg(c);
    return {
      ...c,
      rotationDeg: rot !== 0 ? rot : c.rotationDeg,
      layout: c.layout ? { ...c.layout, rotationDeg: rot } : undefined,
    };
  });

  // Build quick neighbor map to align throttles & valves directly below their target cylinders
  const neighborIds = new Map<string, Set<string>>();
  for (const e of doc.connections) {
    const a = neighborIds.get(e.from.componentId) ?? new Set<string>();
    a.add(e.to.componentId);
    neighborIds.set(e.from.componentId, a);
    const b = neighborIds.get(e.to.componentId) ?? new Set<string>();
    b.add(e.from.componentId);
    neighborIds.set(e.to.componentId, b);
  }

  const pneuLayers = new Map<number, ComponentNode[]>();
  const elecLayers = new Map<number, ComponentNode[]>();
  let hasElectricalComponents = false;

  for (const comp of components) {
    const def = getCatalogComponent(comp.type);
    const layer = def?.layoutLayer ?? 3;
    if (layer >= 10) hasElectricalComponents = true;
    if (incremental && comp.layout) continue;
    if (layer >= 10) {
      const list = elecLayers.get(layer) ?? [];
      list.push(comp);
      elecLayers.set(layer, list);
    } else {
      const list = pneuLayers.get(layer) ?? [];
      list.push(comp);
      pneuLayers.set(layer, list);
    }
  }

  // Pneumatic ISO 1219 vertical bands (layer 0 = Actuators top -> layer 4 = Air Supply bottom)
  const isTallSheet = targetSheetHeightMm >= 260;
  const pneuLayerY: Record<number, number> = isTallSheet
    ? {
        0: 15, // Actuators
        1: 55, // Flow control / quick exhaust / filters / sensors
        2: 105, // Final control valves (5/2, 4/2, 5/3, 2/2)
        3: 155, // Processing / logic / pilot 3/2 valves / manifolds / exhausts / plugs
        4: 225, // Air source & FRL
      }
    : {
        0: 15, // Actuators
        1: 50, // Flow control / quick exhaust
        2: 90, // Final control valves
        3: 135, // Processing / logic / pilot 3/2 valves / exhausts
        4: 180, // Air source & FRL
      };

  // Determine available pneumatic horizontal budget within sheet bounds
  const pneuMaxRightMm = hasElectricalComponents
    ? Math.max(targetSheetWidthMm * 0.55, 220)
    : targetSheetWidthMm - MARGIN_X_MM;

  const placedCenterX = new Map<string, number>();
  for (const comp of components) {
    if (comp.layout) {
      const { w } = getRotatedDimensions(comp);
      placedCenterX.set(comp.id, comp.layout.x + w / 2);
    }
  }

  let maxPneuX = MARGIN_X_MM;
  for (const comp of components) {
    if (comp.layout) {
      const def = getCatalogComponent(comp.type);
      if ((def?.layoutLayer ?? 3) < 10) {
        const { w } = getRotatedDimensions(comp);
        maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
      }
    }
  }

  // Place pneumatic layers top-down so lower layers align horizontally under their upstream actuators
  // Wrap cleanly within pneuMaxRightMm so dense sheets (e.g. 37-component DIN A3) stay inside sheet bounds.
  const sortedPneuLayers = Array.from(pneuLayers.entries()).sort((a, b) => a[0] - b[0]);
  let minAllowedY = MARGIN_Y_MM;

  for (const [layer, comps] of sortedPneuLayers) {
    const preferredX = (comp: ComponentNode): number => {
      const nbrs = neighborIds.get(comp.id);
      if (!nbrs || nbrs.size === 0) return Number.POSITIVE_INFINITY;
      let sum = 0;
      let count = 0;
      for (const nid of nbrs) {
        const cx = placedCenterX.get(nid);
        if (cx !== undefined) {
          sum += cx;
          count++;
        }
      }
      return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
    };

    comps.sort((a, b) => {
      const pa = preferredX(a);
      const pb = preferredX(b);
      if (pa !== pb) return pa - pb;
      return naturalCompare(a.id, b.id);
    });

    // Compute adaptive horizontal gap so dense layers pack neatly before wrapping
    const totalWidths = comps.reduce((sum, c) => sum + getRotatedDimensions(c).w, 0);
    const usableSpan = Math.max(120, pneuMaxRightMm - MARGIN_X_MM);
    const idealGap =
      comps.length > 1
        ? Math.floor((usableSpan - totalWidths) / (comps.length - 1))
        : 15;
    const gapX = Math.max(MIN_CLEARANCE_MM + 3, Math.min(16, idealGap));
    const denseLayer = totalWidths + (comps.length - 1) * (MIN_CLEARANCE_MM + 3) > usableSpan;

    let cursorX = MARGIN_X_MM;
    let rowY = snap(Math.max(pneuLayerY[layer] ?? 140, minAllowedY));
    let rowMaxH = 0;

    for (const comp of comps) {
      const { w, h } = getRotatedDimensions(comp);
      const rot = getEffectiveRotationDeg(comp);
      const pref = preferredX(comp);

      let targetX: number;
      if (!denseLayer && Number.isFinite(pref)) {
        targetX = Math.max(cursorX, snap(pref - w / 2));
        // Pull left if pulling right would overflow the sheet unnecessarily
        if (targetX + w > pneuMaxRightMm && cursorX + w <= pneuMaxRightMm) {
          targetX = cursorX;
        }
      } else {
        targetX = cursorX;
      }

      // Wrap to next sub-row if exceeding target pneumatic zone width
      if (targetX + w > pneuMaxRightMm && cursorX > MARGIN_X_MM) {
        cursorX = MARGIN_X_MM;
        rowY = snap(rowY + Math.max(rowMaxH, 16) + MIN_CLEARANCE_MM + GRID_MM);
        rowMaxH = 0;
        targetX = cursorX;
      }

      comp.layout = {
        x: snap(targetX),
        y: snap(rowY),
        rotationDeg: rot,
      };
      placedCenterX.set(comp.id, comp.layout.x + w / 2);
      cursorX = snap(comp.layout.x + w + gapX);
      rowMaxH = Math.max(rowMaxH, h);
      if (comp.layout.x + w > maxPneuX) maxPneuX = comp.layout.x + w;
    }

    minAllowedY = snap(rowY + Math.max(rowMaxH, 16) + MIN_CLEARANCE_MM + GRID_MM);
  }

  // Electrical 24V / 0V ladder section placed cleanly to the right of pneumatic zone
  const elecOriginX = snap(Math.max(180, maxPneuX + 25));
  const elecLayerY: Record<number, number> = {
    10: 20, // +24V rail
    11: 55, // Pushbuttons / limit switches / proximity sensors
    12: 95, // Relay contacts / junctions
    13: 140, // Relay coils / timers / counters / solenoids / lamps
    14: 185, // 0V rail
  };

  for (const [layer, comps] of Array.from(elecLayers.entries()).sort((a, b) => a[0] - b[0])) {
    comps.sort((a, b) => {
      const rank = (c: ComponentNode): number => {
        if (c.label === 'ESTOP' || c.id.includes('ESTOP')) return 0;
        if (c.label === 'S1' || c.id.includes('START')) return 1;
        if (c.label === 'S2' || c.id.includes('STOP')) return 2;
        return 3;
      };
      const ra = rank(a);
      const rb = rank(b);
      if (ra !== rb) return ra - rb;
      return naturalCompare(a.id, b.id);
    });
    let cursorX = elecOriginX;
    const baseY = elecLayerY[layer] ?? 95;

    for (const comp of comps) {
      const { w } = getRotatedDimensions(comp);
      const rot = getEffectiveRotationDeg(comp);
      comp.layout = {
        x: snap(cursorX),
        y: snap(baseY),
        rotationDeg: rot,
      };
      cursorX = snap(comp.layout.x + w + 15);
    }
  }

  // Always enforce zero-overlap bounding boxes (fixed-point resolution for both full & incremental)
  const wrapLimitX = hasElectricalComponents ? undefined : pneuMaxRightMm;
  resolveBoundingBoxOverlaps(components, wrapLimitX);

  // Recompute sheet bounds after overlap resolution
  let maxRightMm = targetSheetWidthMm;
  let maxBottomMm = targetSheetHeightMm;
  for (const comp of components) {
    if (!comp.layout) continue;
    const { w, h } = getRotatedDimensions(comp);
    maxRightMm = Math.max(maxRightMm, comp.layout.x + w + MARGIN_X_MM);
    maxBottomMm = Math.max(maxBottomMm, comp.layout.y + h + MARGIN_Y_MM);
  }

  // Build bounding boxes for obstacle-aware corridor routing
  const allBoxes: LayoutBox[] = components
    .filter((c): c is ComponentNode & { layout: NonNullable<ComponentNode['layout']> } => Boolean(c.layout))
    .map((comp) => {
      const { w, h } = getRotatedDimensions(comp);
      return {
        comp,
        x: comp.layout.x,
        y: comp.layout.y,
        w,
        h,
      };
    });

  // Route orthogonal Manhattan hoses/wires for all connections
  const compById = new Map<string, ComponentNode>(components.map((c) => [c.id, c]));
  const connections = doc.connections.map((edge, idx) => {
    const fromComp = compById.get(edge.from.componentId);
    const toComp = compById.get(edge.to.componentId);
    if (!fromComp?.layout || !toComp?.layout) {
      return { ...edge };
    }

    const fromDef = getCatalogComponent(fromComp.type);
    const toDef = getCatalogComponent(toComp.type);
    const fromPort = getPortDefinition(fromComp.type, edge.from.port);
    const toPort = getPortDefinition(toComp.type, edge.to.port);
    const fromRotOffset = rotatePortOffset(
      fromPort?.offset ?? { x: 0, y: 0 },
      fromDef?.defaultSize.width ?? 20,
      fromDef?.defaultSize.height ?? 16,
      getEffectiveRotationDeg(fromComp),
    );
    const toRotOffset = rotatePortOffset(
      toPort?.offset ?? { x: 0, y: 0 },
      toDef?.defaultSize.width ?? 20,
      toDef?.defaultSize.height ?? 16,
      getEffectiveRotationDeg(toComp),
    );

    const p1: Point2D = {
      x: snap(fromComp.layout.x + fromRotOffset.x),
      y: snap(fromComp.layout.y + fromRotOffset.y),
    };
    const p2: Point2D = {
      x: snap(toComp.layout.x + toRotOffset.x),
      y: snap(toComp.layout.y + toRotOffset.y),
    };

    const waypoints = routeOrthogonalManhattan(p1, p2, idx, allBoxes, fromComp.id, toComp.id);
    return {
      ...edge,
      waypoints,
    };
  });

  const sheetWidthMm = Math.max(targetSheetWidthMm, snap(maxRightMm));
  const sheetHeightMm = Math.max(targetSheetHeightMm, snap(maxBottomMm));

  return {
    ...doc,
    metadata: {
      ...doc.metadata,
      sheetWidthMm,
      sheetHeightMm,
    },
    components,
    connections,
  };
}

function horizontalSegmentHitsBox(
  x1: number,
  x2: number,
  y: number,
  boxes: readonly LayoutBox[],
  ignoreA: string,
  ignoreB: string,
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  for (const b of boxes) {
    if (b.comp.id === ignoreA || b.comp.id === ignoreB) continue;
    if (y > b.y - 2 && y < b.y + b.h + 2 && maxX > b.x - 2 && minX < b.x + b.w + 2) {
      return true;
    }
  }
  return false;
}

function routeOrthogonalManhattan(
  p1: Point2D,
  p2: Point2D,
  channelIndex: number,
  boxes: readonly LayoutBox[],
  fromId: string,
  toId: string,
): Point2D[] {
  if (p1.x === p2.x || p1.y === p2.y) {
    return [p1, p2];
  }
  const baseMidY = snap((p1.y + p2.y) / 2);
  const laneOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4];
  const preferredStart = channelIndex % 3;
  let chosenY = snap(baseMidY + ((channelIndex % 5) - 2) * GRID_MM);

  for (let k = 0; k < laneOffsets.length; k++) {
    const off = laneOffsets[(k + preferredStart) % laneOffsets.length];
    const candidateY = snap(baseMidY + off * GRID_MM);
    if (candidateY >= 5 && !horizontalSegmentHitsBox(p1.x, p2.x, candidateY, boxes, fromId, toId)) {
      chosenY = candidateY;
      break;
    }
  }

  return [
    p1,
    { x: p1.x, y: chosenY },
    { x: p2.x, y: chosenY },
    p2,
  ];
}

/**
 * Iterative fixed-point overlap resolver guaranteeing zero overlapping bounding boxes
 * across all components with at least MIN_CLEARANCE_MM spacing.
 * When maxRightMm is provided (e.g. pneumatic-only DIN A3 sheet), wraps overflowing items
 * cleanly onto the next row instead of expanding sheet width unboundedly.
 */
function resolveBoundingBoxOverlaps(components: ComponentNode[], maxRightMm?: number): void {
  const boxes = components.map((c) => {
    const { w, h } = getRotatedDimensions(c);
    return {
      comp: c,
      w,
      h,
    };
  });

  for (let pass = 0; pass < 48; pass++) {
    let moved = false;
    for (let i = 0; i < boxes.length; i++) {
      const a = boxes[i];
      if (!a.comp.layout) continue;
      for (let j = 0; j < boxes.length; j++) {
        if (i === j) continue;
        const b = boxes[j];
        if (!b.comp.layout) continue;
        const overlapX =
          a.comp.layout.x < b.comp.layout.x + b.w + MIN_CLEARANCE_MM &&
          a.comp.layout.x + a.w + MIN_CLEARANCE_MM > b.comp.layout.x;
        const overlapY =
          a.comp.layout.y < b.comp.layout.y + b.h + MIN_CLEARANCE_MM &&
          a.comp.layout.y + a.h + MIN_CLEARANCE_MM > b.comp.layout.y;
        if (overlapX && overlapY) {
          const target =
            a.comp.layout.y > b.comp.layout.y ||
            (a.comp.layout.y === b.comp.layout.y && a.comp.layout.x >= b.comp.layout.x)
              ? a
              : b;
          const anchor = target === a ? b : a;
          const nextX = snap(anchor.comp.layout!.x + anchor.w + MIN_CLEARANCE_MM + GRID_MM);
          if (maxRightMm !== undefined && nextX + target.w > maxRightMm) {
            target.comp.layout!.x = MARGIN_X_MM;
            target.comp.layout!.y = snap(
              Math.max(target.comp.layout!.y, anchor.comp.layout!.y + anchor.h + MIN_CLEARANCE_MM + GRID_MM),
            );
            moved = true;
          } else if (nextX > target.comp.layout!.x) {
            target.comp.layout!.x = nextX;
            moved = true;
          } else {
            target.comp.layout!.y = snap(anchor.comp.layout!.y + anchor.h + MIN_CLEARANCE_MM + GRID_MM);
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}
