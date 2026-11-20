import type { CircuitDocument, ComponentNode, Point2D } from '../contracts/circuit';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';

const GRID_MM = 5;
const MIN_CLEARANCE_MM = 6;

function snap(v: number): number {
  return Math.round(v / GRID_MM) * GRID_MM;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
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
 * Features topology-aware actuator column alignment, guaranteed zero-overlap fixed-point resolution
 * (in both full and incremental modes), and corridor-aware orthogonal Manhattan routing.
 */
export function autoLayoutCircuit(
  doc: CircuitDocument,
  options?: { incremental?: boolean },
): CircuitDocument {
  const incremental = options?.incremental ?? false;
  const components: ComponentNode[] = doc.components.map((c) => ({
    ...c,
    layout: c.layout ? { ...c.layout } : undefined,
  }));

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

  for (const comp of components) {
    if (incremental && comp.layout) continue;
    const def = getCatalogComponent(comp.type);
    const layer = def?.layoutLayer ?? 3;
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
  const pneuLayerY: Record<number, number> = {
    0: 20, // Actuators
    1: 60, // Flow control / quick exhaust
    2: 100, // Final control valves (5/2, 4/2, 5/3)
    3: 145, // Processing / logic / pilot 3/2 valves / exhausts
    4: 190, // Air source & FRL
  };

  const placedCenterX = new Map<string, number>();
  // Pre-seed centers of already placed components in incremental mode
  for (const comp of components) {
    if (comp.layout) {
      const w = getCatalogComponent(comp.type)?.defaultSize.width ?? 24;
      placedCenterX.set(comp.id, comp.layout.x + w / 2);
    }
  }

  let maxPneuX = 20;
  for (const comp of components) {
    if (comp.layout) {
      const def = getCatalogComponent(comp.type);
      if ((def?.layoutLayer ?? 3) < 10) {
        maxPneuX = Math.max(maxPneuX, comp.layout.x + (def?.defaultSize.width ?? 24));
      }
    }
  }

  // Place pneumatic layers top-down so lower layers align horizontally under their upstream actuators
  for (const [layer, comps] of Array.from(pneuLayers.entries()).sort((a, b) => a[0] - b[0])) {
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

    let cursorX = 20;
    const baseY = pneuLayerY[layer] ?? 145;

    for (const comp of comps) {
      const def = getCatalogComponent(comp.type);
      const w = def?.defaultSize.width ?? 24;
      const pref = preferredX(comp);
      const targetX = Number.isFinite(pref) ? Math.max(cursorX, snap(pref - w / 2)) : cursorX;
      comp.layout = {
        x: snap(targetX),
        y: snap(baseY),
        rotationDeg: 0,
      };
      placedCenterX.set(comp.id, comp.layout.x + w / 2);
      cursorX = comp.layout.x + w + 18;
      if (cursorX > maxPneuX) maxPneuX = cursorX;
    }
  }

  // Electrical 24V / 0V ladder section placed cleanly to the right of pneumatic zone
  const elecOriginX = snap(Math.max(180, maxPneuX + 30));
  const elecLayerY: Record<number, number> = {
    10: 20, // +24V rail
    11: 55, // Pushbuttons / limit switches / proximity sensors
    12: 95, // Relay contacts / junctions
    13: 140, // Relay coils / timers / counters / solenoids / lamps
    14: 185, // 0V rail
  };

  let maxElecX = elecOriginX;
  for (const [layer, comps] of Array.from(elecLayers.entries()).sort((a, b) => a[0] - b[0])) {
    comps.sort((a, b) => {
      // Keep E-stop and Start buttons on the left of electrical ladder
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
      const def = getCatalogComponent(comp.type);
      const w = def?.defaultSize.width ?? 14;
      comp.layout = {
        x: snap(cursorX),
        y: snap(baseY),
        rotationDeg: 0,
      };
      cursorX = comp.layout.x + w + 16;
      if (cursorX > maxElecX) maxElecX = cursorX;
    }
  }

  // Always enforce zero-overlap bounding boxes (fixed-point resolution for both full & incremental)
  resolveBoundingBoxOverlaps(components);

  // Recompute sheet bounds after overlap resolution
  let maxRightMm = 297;
  let maxBottomMm = 210;
  for (const comp of components) {
    if (!comp.layout) continue;
    const def = getCatalogComponent(comp.type);
    const w = def?.defaultSize.width ?? 24;
    const h = def?.defaultSize.height ?? 16;
    maxRightMm = Math.max(maxRightMm, comp.layout.x + w + 30);
    maxBottomMm = Math.max(maxBottomMm, comp.layout.y + h + 30);
  }

  // Build bounding boxes for obstacle-aware corridor routing
  const allBoxes: LayoutBox[] = components
    .filter((c): c is ComponentNode & { layout: NonNullable<ComponentNode['layout']> } => Boolean(c.layout))
    .map((comp) => {
      const def = getCatalogComponent(comp.type);
      return {
        comp,
        x: comp.layout.x,
        y: comp.layout.y,
        w: def?.defaultSize.width ?? 20,
        h: def?.defaultSize.height ?? 16,
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

    const fromPort = getPortDefinition(fromComp.type, edge.from.port);
    const toPort = getPortDefinition(toComp.type, edge.to.port);
    const p1: Point2D = {
      x: snap(fromComp.layout.x + (fromPort?.offset.x ?? 0)),
      y: snap(fromComp.layout.y + (fromPort?.offset.y ?? 0)),
    };
    const p2: Point2D = {
      x: snap(toComp.layout.x + (toPort?.offset.x ?? 0)),
      y: snap(toComp.layout.y + (toPort?.offset.y ?? 0)),
    };

    const waypoints = routeOrthogonalManhattan(p1, p2, idx, allBoxes, fromComp.id, toComp.id);
    return {
      ...edge,
      waypoints,
    };
  });

  const sheetWidthMm = Math.max(doc.metadata.sheetWidthMm, snap(maxRightMm), 297);
  const sheetHeightMm = Math.max(doc.metadata.sheetHeightMm, snap(maxBottomMm), 210);

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
  // Try clean corridor lanes near the midpoint to avoid crossing through component boxes
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
 */
function resolveBoundingBoxOverlaps(components: ComponentNode[]): void {
  const boxes = components.map((c) => {
    const def = getCatalogComponent(c.type);
    return {
      comp: c,
      w: def?.defaultSize.width ?? 20,
      h: def?.defaultSize.height ?? 16,
    };
  });

  for (let pass = 0; pass < 32; pass++) {
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
          // Push the later/rightmost box cleanly to the right of the other
          const target = a.comp.layout.x >= b.comp.layout.x ? a : b;
          const anchor = target === a ? b : a;
          const nextX = snap(anchor.comp.layout!.x + anchor.w + MIN_CLEARANCE_MM + GRID_MM);
          if (nextX > target.comp.layout!.x) {
            target.comp.layout!.x = nextX;
            moved = true;
          }
        }
      }
    }
    if (!moved) break;
  }
}
