import type { CircuitDocument, ComponentNode, Point2D } from '../contracts/circuit';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';

const GRID_MM = 5;

function snap(v: number): number {
  return Math.round(v / GRID_MM) * GRID_MM;
}

/**
 * Automatic ISO 1219 pneumatic top-down layout & 24V/0V ladder organizer + orthogonal router.
 * Guarantees grid-snapped, non-overlapping bounding boxes and orthogonal Manhattan waypoints
 * so AI agents never have to compute pixel/mm coordinates.
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
    1: 55, // Flow control / quick exhaust
    2: 90, // Final control valves (5/2, 4/2, 5/3)
    3: 130, // Processing / logic / pilot 3/2 valves / exhausts
    4: 170, // Air source & FRL
  };

  let maxPneuX = 20;
  for (const [layer, comps] of Array.from(pneuLayers.entries()).sort((a, b) => a[0] - b[0])) {
    comps.sort((a, b) => a.id.localeCompare(b.id));
    let cursorX = 20;
    const baseY = pneuLayerY[layer] ?? 130;

    for (const comp of comps) {
      const def = getCatalogComponent(comp.type);
      const w = def?.defaultSize.width ?? 24;
      comp.layout = {
        x: snap(cursorX),
        y: snap(baseY),
        rotationDeg: 0,
      };
      cursorX += w + 18;
      if (cursorX > maxPneuX) maxPneuX = cursorX;
    }
  }

  // Electrical 24V / 0V ladder section placed cleanly to the right of pneumatic zone
  const elecOriginX = snap(Math.max(160, maxPneuX + 25));
  const elecLayerY: Record<number, number> = {
    10: 20, // +24V rail
    11: 50, // Pushbuttons / limit switches / proximity sensors
    12: 85, // Relay contacts / junctions
    13: 130, // Relay coils / timers / counters / solenoids / lamps
    14: 170, // 0V rail
  };

  let maxElecX = elecOriginX;
  for (const [layer, comps] of Array.from(elecLayers.entries()).sort((a, b) => a[0] - b[0])) {
    comps.sort((a, b) => a.id.localeCompare(b.id));
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
      cursorX += w + 16;
      if (cursorX > maxElecX) maxElecX = cursorX;
    }
  }

  // Resolve any accidental overlaps in incremental mode
  if (incremental) {
    resolveBoundingBoxOverlaps(components);
  }

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

    const waypoints = routeOrthogonalManhattan(p1, p2, idx);
    return {
      ...edge,
      waypoints,
    };
  });

  const sheetWidthMm = Math.max(doc.metadata.sheetWidthMm, snap(maxElecX + 40), 297);
  const sheetHeightMm = Math.max(doc.metadata.sheetHeightMm, 210);

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

function routeOrthogonalManhattan(p1: Point2D, p2: Point2D, channelIndex: number): Point2D[] {
  if (p1.x === p2.x || p1.y === p2.y) {
    return [p1, p2];
  }
  // Spread horizontal routing channels by small 5mm lanes to avoid overlapping bus lines
  const laneOffset = ((channelIndex % 5) - 2) * GRID_MM;
  const midY = snap((p1.y + p2.y) / 2 + laneOffset);
  return [
    p1,
    { x: p1.x, y: midY },
    { x: p2.x, y: midY },
    p2,
  ];
}

function resolveBoundingBoxOverlaps(components: ComponentNode[]): void {
  const boxes = components.map((c) => {
    const def = getCatalogComponent(c.type);
    return {
      comp: c,
      w: def?.defaultSize.width ?? 20,
      h: def?.defaultSize.height ?? 16,
    };
  });

  for (let i = 0; i < boxes.length; i++) {
    const a = boxes[i];
    if (!a.comp.layout) continue;
    for (let j = 0; j < i; j++) {
      const b = boxes[j];
      if (!b.comp.layout) continue;
      const overlapX =
        a.comp.layout.x < b.comp.layout.x + b.w + 4 &&
        a.comp.layout.x + a.w + 4 > b.comp.layout.x;
      const overlapY =
        a.comp.layout.y < b.comp.layout.y + b.h + 4 &&
        a.comp.layout.y + a.h + 4 > b.comp.layout.y;
      if (overlapX && overlapY) {
        a.comp.layout.x = snap(b.comp.layout.x + b.w + 15);
      }
    }
  }
}
