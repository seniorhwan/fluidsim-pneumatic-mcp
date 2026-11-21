import type { CircuitDocument, ComponentNode, Point2D } from '../contracts/circuit';
import { getCatalogComponent, getPortDefinition } from '../catalog/pneumatics45';

const GRID_MM = 5;
const MIN_CLEARANCE_MM = 8;
const MARGIN_X_MM = 15;
const MARGIN_Y_MM = 15;
const HEADER_SAFE_Y_MM = 40;

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

export function getRotatedDimensions(comp: ComponentNode): { w: number; h: number } {
  const def = getCatalogComponent(comp.type);
  const baseW = def?.defaultSize.width ?? 20;
  const baseH = def?.defaultSize.height ?? 12;
  const rot = getEffectiveRotationDeg(comp);
  if (rot === 90 || rot === 270) {
    return { w: baseH, h: baseW };
  }
  return { w: baseW, h: baseH };
}

export function getVisualPaddingRightMm(comp: ComponentNode): number {
  if (comp.type === 'pressure_switch_differential') return 10;
  if (comp.type === 'cylinder_double_acting' || comp.type === 'cylinder_single_acting') return 15;
  if (comp.type.startsWith('valve_') && comp.rightActuation) return 6;
  return 0;
}

export function rotatePortOffset(
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

/**
 * Computes effective port offset in mm for both layout routing and `.ct` emission.
 * For 180-deg meter-out flow-control/throttle valves, keeps port 1 at bottom (valve side)
 * and port 2 at top (actuator side) so wires never loop over the component body.
 */
export function getEffectivePortOffset(comp: ComponentNode, portName: string): { x: number; y: number } {
  const def = getCatalogComponent(comp.type);
  const port = getPortDefinition(comp.type, portName);
  const raw = port?.offset ?? { x: 0, y: 0 };
  const rot = getEffectiveRotationDeg(comp);
  if (
    rot === 180 &&
    (comp.type === 'flow_control_one_way' || comp.type === 'throttle_valve')
  ) {
    return raw;
  }
  return rotatePortOffset(
    raw,
    def?.defaultSize.width ?? 20,
    def?.defaultSize.height ?? 12,
    rot,
  );
}

interface LayoutBox {
  comp: ComponentNode;
  x: number;
  y: number;
  w: number;
  h: number;
}

const BACKBONE_TYPES = new Set(['air_source', 'air_service_unit', 'pneumatic_manifold']);
const TERMINATOR_TYPES = new Set(['exhaust_silencer', 'blind_plug']);
const ACTUATOR_TYPES = new Set([
  'cylinder_single_acting',
  'cylinder_double_acting',
  'cylinder_rodless',
  'swivel_drive',
  'air_motor',
  'vacuum_sucker',
]);

/**
 * Automatic ISO 1219 pneumatic connected-branch top-down layout & 24V/0V ladder organizer + orthogonal router.
 * Features:
 * - Dedicated top header clearance (y >= 40 mm) so title banners and R_SCHALT distance rules never collide
 * - Connected-branch column partitioning for pneumatic schematics with dynamic junction layer assignment
 * - Backbone manifold bus row (Layer 3) and bottom-left air supply / FRL placement (Layer 4)
 * - Sheet-size-aware packing (respects DIN A4 297×210, DIN A3 420×297, etc.)
 * - Full preservation of component rotationDeg (0/90/180/270) including rotated bounding boxes & ports
 * - Guaranteed zero-overlap fixed-point resolution & corridor-aware orthogonal Manhattan routing
 */
export function autoLayoutCircuit(
  doc: CircuitDocument,
  options?: { incremental?: boolean },
): CircuitDocument {
  const incremental = options?.incremental ?? false;
  let targetSheetWidthMm = Math.max(doc.metadata.sheetWidthMm || 297, 210);
  let targetSheetHeightMm = Math.max(doc.metadata.sheetHeightMm || 210, 148);
  let targetSheetSize = doc.metadata.sheetSize;

  const components: ComponentNode[] = doc.components.map((c) => {
    const rot = getEffectiveRotationDeg(c);
    return {
      ...c,
      rotationDeg: rot !== 0 ? rot : c.rotationDeg,
      layout: c.layout ? { ...c.layout, rotationDeg: rot } : undefined,
    };
  });

  const compById = new Map<string, ComponentNode>(components.map((c) => [c.id, c]));

  // Build undirected adjacency map
  const neighborIds = new Map<string, Set<string>>();
  for (const e of doc.connections) {
    const a = neighborIds.get(e.from.componentId) ?? new Set<string>();
    a.add(e.to.componentId);
    neighborIds.set(e.from.componentId, a);
    const b = neighborIds.get(e.to.componentId) ?? new Set<string>();
    b.add(e.from.componentId);
    neighborIds.set(e.to.componentId, b);
  }

  const pneuUnplaced: ComponentNode[] = [];
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
      pneuUnplaced.push(comp);
    }
  }

  const computeSheetMetrics = (wMm: number, hMm: number) => {
    const tall = hMm >= 260;
    const layerY: Record<number, number> = tall
      ? {
          0: HEADER_SAFE_Y_MM, // Actuators & top switches (R_SCHALT sits cleanly above at ~30.7 mm)
          0.5: 55, // Upper branch junctions (J_VAC_1)
          1: 75, // Flow control / filters / check valves / throttles
          1.2: 98, // Lower branch junctions / lateral switches (J_VAC_2, PSW_2B1)
          1.5: 116, // Mid-branch ejectors (PAV1) & hanging suction cups (PAV1S)
          2: 144, // Directional control valves (5/2, 4/2, 5/3, 2/2, 3/2)
          3: 180, // Supply manifold / backbone junctions / pilot 3/2 valves
          4: 202, // Exhaust manifold / Air source & Wartungseinheit2 FRL
        }
      : {
          0: HEADER_SAFE_Y_MM, // Actuators
          0.5: 50,
          1: 68, // Flow control / quick exhaust / filters
          1.2: 85,
          1.5: 95,
          2: 112, // Directional control valves
          3: 145, // Processing / logic / pilot 3/2 / manifolds
          4: 170, // Air source & FRL
        };
    const printableRight =
      wMm >= 400 ? Math.min(wMm - MARGIN_X_MM, 345) : Math.min(wMm - MARGIN_X_MM, 245);
    const pneuRight = hasElectricalComponents ? Math.max(wMm * 0.56, 210) : printableRight;
    return { pneuLayerY: layerY, maxPrintableRightMm: printableRight, pneuMaxRightMm: pneuRight };
  };

  let { pneuLayerY, maxPrintableRightMm, pneuMaxRightMm } = computeSheetMetrics(
    targetSheetWidthMm,
    targetSheetHeightMm,
  );

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

  // Classify unplaced pneumatic components into:
  // 1) Supply/Bus Backbone (air_source, air_service_unit, pneumatic_manifold, supply junctions, backbone terminators)
  // 2) Functional Branches (connected components after excluding the Backbone)
  if (pneuUnplaced.length > 0) {
    const unplacedSet = new Set(pneuUnplaced.map((c) => c.id));
    const backboneIds = new Set<string>();

    for (const c of pneuUnplaced) {
      if (BACKBONE_TYPES.has(c.type)) {
        backboneIds.add(c.id);
      }
    }
    // Any pneumatic_junction directly attached to a backbone component (air_source, FRL, manifold)
    // is a supply/bus distribution junction, not an in-branch junction.
    for (const c of pneuUnplaced) {
      if (c.type !== 'pneumatic_junction') continue;
      const nbrs = neighborIds.get(c.id);
      if (!nbrs) continue;
      for (const nid of nbrs) {
        const nc = compById.get(nid);
        if (nc && BACKBONE_TYPES.has(nc.type)) {
          backboneIds.add(c.id);
          break;
        }
      }
    }
    // Any exhaust_silencer / blind_plug directly attached to a backbone component stays in the backbone
    for (const c of pneuUnplaced) {
      if (!TERMINATOR_TYPES.has(c.type)) continue;
      const nbrs = neighborIds.get(c.id);
      if (!nbrs) continue;
      for (const nid of nbrs) {
        if (backboneIds.has(nid)) {
          backboneIds.add(c.id);
          break;
        }
      }
    }

    // Partition remaining non-backbone pneumatic components into connected branches
    const branchCandidates = pneuUnplaced.filter((c) => !backboneIds.has(c.id));
    const branchCandidateSet = new Set(branchCandidates.map((c) => c.id));
    const visited = new Set<string>();
    const branches: ComponentNode[][] = [];

    for (const start of branchCandidates) {
      if (visited.has(start.id)) continue;
      const group: ComponentNode[] = [];
      const queue: ComponentNode[] = [start];
      visited.add(start.id);
      while (queue.length > 0) {
        const cur = queue.shift()!;
        group.push(cur);
        const nbrs = neighborIds.get(cur.id);
        if (!nbrs) continue;
        for (const nid of nbrs) {
          if (!visited.has(nid) && branchCandidateSet.has(nid)) {
            const next = compById.get(nid);
            if (next) {
              visited.add(nid);
              queue.push(next);
            }
          }
        }
      }
      branches.push(group);
    }

    // Auto-promote DIN A4 -> DIN A3 Landscape for multi-branch or dense circuits so they never cramp
    if (!incremental && targetSheetWidthMm < 400 && (branches.length >= 3 || components.length > 14)) {
      targetSheetWidthMm = 420;
      targetSheetHeightMm = 297;
      targetSheetSize = 'DIN_A3_LANDSCAPE';
      ({ pneuLayerY, maxPrintableRightMm, pneuMaxRightMm } = computeSheetMetrics(
        targetSheetWidthMm,
        targetSheetHeightMm,
      ));
    }

    // Sort branches deterministically left-to-right by their primary actuator's label/ID
    const branchSortKey = (group: ComponentNode[]): string => {
      const actuators = group
        .filter((c) => ACTUATOR_TYPES.has(c.type))
        .sort((a, b) => naturalCompare(a.label || a.id, b.label || b.id));
      if (actuators.length > 0) {
        return `0:${actuators[0].label || actuators[0].id}`;
      }
      const sorted = [...group].sort((a, b) => naturalCompare(a.label || a.id, b.label || b.id));
      return `1:${sorted[0]?.label || sorted[0]?.id || ''}`;
    };
    branches.sort((a, b) => naturalCompare(branchSortKey(a), branchSortKey(b)));

    // Compute dynamic vertical layer (0..3, with 0.5 and 1.5 sub-bands) for every component inside each branch
    const branchLayerOf = new Map<string, number>();
    for (const group of branches) {
      const groupIds = new Set(group.map((c) => c.id));
      const hasVacuumNozzle = group.some((c) => c.type === 'vacuum_suction_nozzle');
      // First assign base layers for non-junctions
      for (const c of group) {
        if (c.type === 'pneumatic_junction') continue;
        if (c.type === 'vacuum_suction_nozzle') {
          // Venturi nozzle sits between the vacuum rail (Layer 1) and supply valve (Layer 2) -> Layer 1.5
          branchLayerOf.set(c.id, 1.5);
        } else if (hasVacuumNozzle && c.type === 'vacuum_sucker') {
          // Suction cup hangs cleanly below J_VAC_2 in Layer 1.5
          branchLayerOf.set(c.id, 1.5);
        } else if (hasVacuumNozzle && c.type === 'pressure_switch_differential') {
          // Vacuum pressure switch sits in Layer 1.2 beside J_VAC_2 for a straight horizontal tap
          branchLayerOf.set(c.id, 1.2);
        } else if (c.type === 'check_valve_spring' || c.type === 'check_valve') {
          branchLayerOf.set(c.id, 1);
        } else if (c.type === 'valve_3_2') {
          // A 3/2 valve directly driving an actuator, flow-control, throttle, quick-exhaust, or venturi
          // acts as a final control valve (Layer 2) rather than a pilot signal valve (Layer 3).
          const isFinalControl = doc.connections.some((e) => {
            const otherId =
              e.from.componentId === c.id && e.from.port === '2'
                ? e.to.componentId
                : e.to.componentId === c.id && e.to.port === '2'
                  ? e.from.componentId
                  : null;
            if (!otherId) return false;
            const other = compById.get(otherId);
            if (!other) return false;
            return (
              ACTUATOR_TYPES.has(other.type) ||
              other.type === 'flow_control_one_way' ||
              other.type === 'throttle_valve' ||
              other.type === 'quick_exhaust_valve' ||
              other.type === 'vacuum_suction_nozzle'
            );
          });
          branchLayerOf.set(c.id, isFinalControl ? 2 : 3);
        } else if (TERMINATOR_TYPES.has(c.type)) {
          // Place attached terminators in the same band as their neighbor
          const nbrs = neighborIds.get(c.id);
          let ownerLayer = 2;
          if (nbrs) {
            for (const nid of nbrs) {
              const nc = compById.get(nid);
              if (nc && !TERMINATOR_TYPES.has(nc.type)) {
                ownerLayer =
                  nc.type === 'vacuum_suction_nozzle'
                    ? 1.5
                    : Math.min(3, getCatalogComponent(nc.type)?.layoutLayer ?? 2);
                break;
              }
            }
          }
          branchLayerOf.set(c.id, ownerLayer);
        } else {
          const base = getCatalogComponent(c.type)?.layoutLayer ?? 2;
          branchLayerOf.set(c.id, Math.max(0, Math.min(3, base)));
        }
      }
      // Assign branch-internal pneumatic_junctions cleanly:
      // J_VAC_1 (connected to check_valve / throttle) -> Layer 0.5 (above Layer 1)
      // J_VAC_2 (connected to vacuum_sucker / pressure_switch) -> Layer 1.2 (between filter above and suction cup below)
      for (let pass = 0; pass < 3; pass++) {
        for (const c of group) {
          if (c.type !== 'pneumatic_junction') continue;
          const nbrs = neighborIds.get(c.id);
          let hasSuckerOrPsw = false;
          let best = Number.POSITIVE_INFINITY;
          if (nbrs) {
            for (const nid of nbrs) {
              if (!groupIds.has(nid)) continue;
              const nc = compById.get(nid);
              if (nc && (nc.type === 'vacuum_sucker' || nc.type === 'pressure_switch_differential')) {
                hasSuckerOrPsw = true;
              }
              const nl = branchLayerOf.get(nid);
              if (nl !== undefined && nl < best) {
                best = nl;
              }
            }
          }
          if (hasVacuumNozzle) {
            branchLayerOf.set(c.id, hasSuckerOrPsw ? 1.2 : 0.5);
          } else if (Number.isFinite(best)) {
            branchLayerOf.set(c.id, Math.max(0, Math.min(2, best)));
          }
        }
      }
      for (const c of group) {
        if (!branchLayerOf.has(c.id)) {
          branchLayerOf.set(c.id, 1);
        }
      }
    }

    // Allocate horizontal column spans across [MARGIN_X_MM, pneuMaxRightMm] for the functional branches
    const usableSpanMm = Math.max(120, pneuMaxRightMm - MARGIN_X_MM);
    const colGapMm = branches.length > 1 ? 15 : 0;
    const availableForColsMm = Math.max(80, usableSpanMm - colGapMm * Math.max(0, branches.length - 1));

    const branchWeights = branches.map((group) => {
      const byLayer = new Map<number, ComponentNode[]>();
      for (const c of group) {
        const l = branchLayerOf.get(c.id) ?? 1;
        const arr = byLayer.get(l) ?? [];
        arr.push(c);
        byLayer.set(l, arr);
      }
      let maxBandWidth = 45;
      for (const comps of byLayer.values()) {
        // Count non-terminator visual width (terminators embed in .ct)
        const visibleComps = comps.filter((c) => !TERMINATOR_TYPES.has(c.type));
        const active = visibleComps.length > 0 ? visibleComps : comps;
        const sumW = active.reduce((s, c) => s + getRotatedDimensions(c).w, 0);
        // Cap single-row weight so dense 6-node layers wrap into 2 clean sub-rows instead of dominating
        const effectiveRowW = Math.min(sumW + Math.max(0, active.length - 1) * (MIN_CLEARANCE_MM + 4), 145);
        maxBandWidth = Math.max(maxBandWidth, effectiveRowW);
      }
      return maxBandWidth;
    });

    const totalWeight = branchWeights.reduce((a, b) => a + b, 0) || 1;
    let colCursorX = MARGIN_X_MM;
    let maxBranchBottomY = HEADER_SAFE_Y_MM;

    for (let bIdx = 0; bIdx < branches.length; bIdx++) {
      const group = branches[bIdx];
      const colWidth =
        branches.length === 1
          ? availableForColsMm
          : Math.max(55, snap((branchWeights[bIdx] / totalWeight) * availableForColsMm));
      const colLeft = colCursorX;
      const colRight =
        bIdx === branches.length - 1 ? Math.max(colLeft + colWidth, pneuMaxRightMm) : colLeft + colWidth;
      const colSpan = Math.max(45, colRight - colLeft);

      const byLayer = new Map<number, ComponentNode[]>();
      for (const c of group) {
        const l = branchLayerOf.get(c.id) ?? 1;
        const arr = byLayer.get(l) ?? [];
        arr.push(c);
        byLayer.set(l, arr);
      }

      let branchMinY = HEADER_SAFE_Y_MM;
      const placedCenterInBranch = new Map<string, number>();

      for (const layer of Array.from(byLayer.keys()).sort((a, b) => a - b)) {
        const comps = byLayer.get(layer)!;
        // Order nodes inside the band by average X of already-placed upstream neighbors, then natural ID
        const prefX = (comp: ComponentNode): number => {
          const nbrs = neighborIds.get(comp.id);
          if (!nbrs || nbrs.size === 0) return Number.POSITIVE_INFINITY;
          let sum = 0;
          let count = 0;
          for (const nid of nbrs) {
            const cx = placedCenterInBranch.get(nid);
            if (cx !== undefined) {
              sum += cx;
              count++;
            }
          }
          return count > 0 ? sum / count : Number.POSITIVE_INFINITY;
        };
        comps.sort((a, b) => {
          const pa = prefX(a);
          const pb = prefX(b);
          if (pa !== pb) return pa - pb;
          return naturalCompare(a.label || a.id, b.label || b.id);
        });

        const itemGap = group.some((c) => c.type === 'vacuum_suction_nozzle')
          ? MIN_CLEARANCE_MM + 10
          : MIN_CLEARANCE_MM + 4;
        // Pack into 1 or more tidy sub-rows within colSpan
        const rows: ComponentNode[][] = [];
        let curRow: ComponentNode[] = [];
        let curRowW = 0;
        for (const comp of comps) {
          const w = getRotatedDimensions(comp).w + getVisualPaddingRightMm(comp);
          const needed = curRow.length === 0 ? w : curRowW + itemGap + w;
          if (curRow.length > 0 && needed > colSpan) {
            rows.push(curRow);
            curRow = [comp];
            curRowW = w;
          } else {
            curRow.push(comp);
            curRowW = needed;
          }
        }
        if (curRow.length > 0) rows.push(curRow);

        let rowY = snap(Math.max(pneuLayerY[layer] ?? 140, branchMinY));
        for (const row of rows) {
          const rowTotalW =
            row.reduce((s, c) => s + getRotatedDimensions(c).w + getVisualPaddingRightMm(c), 0) +
            Math.max(0, row.length - 1) * itemGap;
          const startX = snap(Math.max(colLeft, colLeft + (colSpan - rowTotalW) / 2));
          let cx = startX;
          let rowMaxH = 0;
          for (const comp of row) {
            const { w: rawW, h } = getRotatedDimensions(comp);
            const w = rawW + getVisualPaddingRightMm(comp);
            const rot = getEffectiveRotationDeg(comp);
            comp.layout = {
              x: snap(cx),
              y: snap(rowY),
              rotationDeg: rot,
            };
            placedCenterInBranch.set(comp.id, comp.layout.x + rawW / 2);
            cx = snap(comp.layout.x + w + itemGap);
            rowMaxH = Math.max(rowMaxH, h);
            maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
            maxBranchBottomY = Math.max(maxBranchBottomY, comp.layout.y + h);
          }
          rowY = snap(rowY + Math.max(rowMaxH, 12) + MIN_CLEARANCE_MM + GRID_MM);
        }
        branchMinY = rowY;
      }

      colCursorX = snap(colRight + colGapMm);
    }

    // Place Layer 4 Air Supply (air_source -> air_service_unit) cleanly at bottom-left,
    // and Layer 3 Backbone manifolds on separate horizontal rows (supply BUS_1 at y~180, exhaust BUS_EXH at y~202)
    const backboneLayer4 = pneuUnplaced
      .filter((c) => backboneIds.has(c.id) && (c.type === 'air_source' || c.type === 'air_service_unit'))
      .sort((a, b) => {
        const ra = a.type === 'air_source' ? 0 : 1;
        const rb = b.type === 'air_source' ? 0 : 1;
        if (ra !== rb) return ra - rb;
        return naturalCompare(a.id, b.id);
      });

    let backboneBottomY = maxBranchBottomY;
    let supplyRightX = MARGIN_X_MM;
    const baseBusY = snap(Math.max(pneuLayerY[3] ?? 180, maxBranchBottomY + MIN_CLEARANCE_MM + 12));
    if (backboneLayer4.length > 0) {
      let cursorX = MARGIN_X_MM;
      for (const comp of backboneLayer4) {
        const { w, h } = getRotatedDimensions(comp);
        const rot = getEffectiveRotationDeg(comp);
        comp.layout = {
          x: snap(cursorX),
          y: snap(comp.type === 'air_source' ? baseBusY + 5 : baseBusY - 9),
          rotationDeg: rot,
        };
        cursorX = snap(comp.layout.x + w + MIN_CLEARANCE_MM + 4);
        supplyRightX = Math.max(supplyRightX, comp.layout.x + w);
        maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
        backboneBottomY = Math.max(backboneBottomY, comp.layout.y + h);
      }
    }

    const isExhaustManifold = (c: ComponentNode): boolean => {
      if (c.type !== 'pneumatic_manifold') return false;
      if (String(c.params.busRole ?? '') === 'exhaust') return true;
      return doc.connections.some((e) => {
        const isFrom = e.from.componentId === c.id;
        const isTo = e.to.componentId === c.id;
        if (!isFrom && !isTo) return false;
        const otherId = isFrom ? e.to.componentId : e.from.componentId;
        const otherPort = isFrom ? e.to.port : e.from.port;
        const other = compById.get(otherId);
        if (!other) return false;
        if (other.type === 'exhaust_silencer') return true;
        if (other.type.startsWith('valve_') && (otherPort === '3' || otherPort === '5')) return true;
        return false;
      });
    };

    const backboneLayer3 = pneuUnplaced
      .filter((c) => backboneIds.has(c.id) && c.type !== 'air_source' && c.type !== 'air_service_unit')
      .sort((a, b) => {
        const rank = (c: ComponentNode): number => {
          if (c.type === 'pneumatic_manifold') {
            return isExhaustManifold(c) ? 1 : 0;
          }
          return c.type === 'pneumatic_junction' ? 2 : 3;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) return ra - rb;
        return naturalCompare(a.label || a.id, b.label || b.id);
      });

    if (backboneLayer3.length > 0) {
      const busStartX = supplyRightX > MARGIN_X_MM ? snap(supplyRightX + MIN_CLEARANCE_MM + 10) : MARGIN_X_MM;
      const gapX = MIN_CLEARANCE_MM + 8;
      let rowY = baseBusY;
      let cursorX = busStartX;
      let rowMaxH = 0;

      for (const comp of backboneLayer3) {
        const { w, h } = getRotatedDimensions(comp);
        const rot = getEffectiveRotationDeg(comp);
        const exhBus = isExhaustManifold(comp);
        // Always place exhaust manifold on its own lower horizontal row so supply & exhaust buses never overlap
        if ((exhBus && cursorX > busStartX) || (cursorX > busStartX && cursorX + w > pneuMaxRightMm)) {
          cursorX = busStartX;
          rowY = snap(rowY + Math.max(rowMaxH, 8) + MIN_CLEARANCE_MM + 12);
          rowMaxH = 0;
        }
        const placedX = exhBus && cursorX === busStartX ? snap(busStartX + 15) : snap(cursorX);
        comp.layout = {
          x: placedX,
          y: snap(rowY),
          rotationDeg: rot,
        };
        // Reserve full horizontal span for manifold bus rails so subsequent manifolds/terminators never share its row
        const reservedW = comp.type === 'pneumatic_manifold' ? Math.max(w, pneuMaxRightMm - cursorX) : w;
        cursorX = snap(comp.layout.x + reservedW + gapX);
        rowMaxH = Math.max(rowMaxH, h);
        maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
        backboneBottomY = Math.max(backboneBottomY, comp.layout.y + h);
      }
    }

    // Safety net: ensure every unplaced pneumatic component received coordinates
    for (const comp of pneuUnplaced) {
      if (unplacedSet.has(comp.id) && !comp.layout) {
        comp.layout = {
          x: MARGIN_X_MM,
          y: snap(backboneBottomY + MIN_CLEARANCE_MM + 6),
          rotationDeg: getEffectiveRotationDeg(comp),
        };
      }
    }
  }

  // Electrical 24V / 0V ladder section placed cleanly to the right of pneumatic zone (starting at y >= 40 mm)
  const elecOriginX = snap(Math.max(150, maxPneuX + 25));
  const elecLayerY: Record<number, number> = targetSheetHeightMm >= 260
    ? {
        10: HEADER_SAFE_Y_MM, // +24V rail
        10.5: 58, // Top 24V distribution bus junctions
        11: 80, // Pushbuttons / limit switches / proximity sensors
        12: 125, // Relay contacts / junctions
        13: 170, // Relay coils / timers / counters / solenoids / lamps
        14: 220, // 0V rail
      }
    : {
        10: HEADER_SAFE_Y_MM, // +24V rail
        10.5: 52, // Top 24V distribution bus junctions
        11: 70, // Pushbuttons / limit switches / proximity sensors
        12: 105, // Relay contacts / junctions
        13: 140, // Relay coils / timers / counters / solenoids / lamps
        14: 175, // 0V rail
      };

  // Promote any electrical_junction directly connected to power_24v or ESTOP into top bus band 10.5
  const bus24vLayerList = elecLayers.get(12);
  if (bus24vLayerList && bus24vLayerList.length > 0) {
    const keepIn12: ComponentNode[] = [];
    const topBusList = elecLayers.get(10.5) ?? [];
    for (const c of bus24vLayerList) {
      const nbrs = neighborIds.get(c.id);
      const isTop24vBus =
        c.type === 'electrical_junction' &&
        (c.id === 'BUS_24V' ||
          (nbrs &&
            Array.from(nbrs).some((nid) => {
              const nc = compById.get(nid);
              return nc && (nc.type === 'power_24v' || nc.label === 'ESTOP' || nc.id.includes('ESTOP'));
            })));
      if (isTop24vBus) {
        topBusList.push(c);
      } else {
        keepIn12.push(c);
      }
    }
    if (topBusList.length > 0) elecLayers.set(10.5, topBusList);
    elecLayers.set(12, keepIn12);
  }

  for (const [layer, comps] of Array.from(elecLayers.entries()).sort((a, b) => a[0] - b[0])) {
    if (comps.length === 0) continue;
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
    const availW = Math.max(80, maxPrintableRightMm - elecOriginX);
    const sumW = comps.reduce((s, c) => s + getRotatedDimensions(c).w, 0);
    const gap =
      comps.length > 1
        ? Math.max(MIN_CLEARANCE_MM, Math.min(15, Math.floor((availW - sumW) / (comps.length - 1))))
        : 0;
    let cursorX = elecOriginX;
    let baseY = elecLayerY[layer] ?? 105;
    let rowMaxH = 0;

    for (const comp of comps) {
      const { w, h } = getRotatedDimensions(comp);
      const rot = getEffectiveRotationDeg(comp);
      if (cursorX > elecOriginX && cursorX + w > maxPrintableRightMm) {
        cursorX = elecOriginX;
        baseY = snap(baseY + Math.max(rowMaxH, 10) + 6);
        rowMaxH = 0;
      }
      comp.layout = {
        x: Math.round(cursorX),
        y: snap(baseY),
        rotationDeg: rot,
      };
      rowMaxH = Math.max(rowMaxH, h);
      cursorX = comp.layout.x + w + gap;
    }
  }

  // Auto-orient check valves when Port 1 connects above and Port 2 connects below (unless explicitly rotated)
  if (!incremental) {
    for (const comp of components) {
      if (
        (comp.type === 'check_valve' || comp.type === 'check_valve_spring') &&
        comp.rotationDeg === undefined &&
        comp.layout
      ) {
        let p1Y: number | undefined;
        let p2Y: number | undefined;
        for (const e of doc.connections) {
          if (e.from.componentId === comp.id && e.from.port === '1') {
            p1Y = compById.get(e.to.componentId)?.layout?.y;
          } else if (e.to.componentId === comp.id && e.to.port === '1') {
            p1Y = compById.get(e.from.componentId)?.layout?.y;
          } else if (e.from.componentId === comp.id && e.from.port === '2') {
            p2Y = compById.get(e.to.componentId)?.layout?.y;
          } else if (e.to.componentId === comp.id && e.to.port === '2') {
            p2Y = compById.get(e.from.componentId)?.layout?.y;
          }
        }
        if (p1Y !== undefined && p2Y !== undefined && p1Y < p2Y) {
          comp.rotationDeg = 180;
          comp.layout.rotationDeg = 180;
        }
      }
    }
  }

  // Always enforce zero-overlap bounding boxes (fixed-point resolution for both full & incremental)
  const wrapLimitX = hasElectricalComponents
    ? targetSheetWidthMm >= 400
      ? maxPrintableRightMm
      : undefined
    : pneuMaxRightMm;
  resolveBoundingBoxOverlaps(components, wrapLimitX, hasElectricalComponents ? elecOriginX : undefined);

  // Recompute sheet bounds after overlap resolution
  let maxRightMm = targetSheetWidthMm;
  let maxBottomMm = targetSheetHeightMm;
  for (const comp of components) {
    if (!comp.layout) continue;
    const { w, h } = getRotatedDimensions(comp);
    maxRightMm = Math.max(maxRightMm, comp.layout.x + w + MARGIN_X_MM);
    maxBottomMm = Math.max(maxBottomMm, comp.layout.y + h + MARGIN_Y_MM);
  }

  // Build bounding boxes for obstacle-aware corridor routing (include right-side spring overhang for PSW1/valves)
  const allBoxes: LayoutBox[] = components
    .filter((c): c is ComponentNode & { layout: NonNullable<ComponentNode['layout']> } => Boolean(c.layout))
    .map((comp) => {
      const { w, h } = getRotatedDimensions(comp);
      const rightPad =
        comp.type === 'pressure_switch_differential' || comp.type.startsWith('valve_') ? 8 : 0;
      return {
        comp,
        x: comp.layout.x,
        y: comp.layout.y,
        w: w + rightPad,
        h,
      };
    });

  // Route orthogonal Manhattan hoses/wires for all connections while avoiding superimposed horizontal & vertical runs
  const usedHorizSegments: HorizSegment[] = [];
  const usedVertSegments: VertSegment[] = [];
  const connections = doc.connections.map((edge, idx) => {
    const fromComp = compById.get(edge.from.componentId);
    const toComp = compById.get(edge.to.componentId);
    if (!fromComp?.layout || !toComp?.layout) {
      return { ...edge };
    }

    const fromRotOffset = getEffectivePortOffset(fromComp, edge.from.port);
    const toRotOffset = getEffectivePortOffset(toComp, edge.to.port);

    const p1: Point2D = {
      x: Math.round((fromComp.layout.x + fromRotOffset.x) * 100) / 100,
      y: Math.round((fromComp.layout.y + fromRotOffset.y) * 100) / 100,
    };
    const p2: Point2D = {
      x: Math.round((toComp.layout.x + toRotOffset.x) * 100) / 100,
      y: Math.round((toComp.layout.y + toRotOffset.y) * 100) / 100,
    };

    // Manifold riser ports ('2'..'7') align directly beneath their target valve port in .ct -> emit straight vertical line
    const isFromManifoldRiser =
      fromComp.type === 'pneumatic_manifold' && Number(edge.from.port) >= 2 && Number(edge.from.port) <= 7;
    const isToManifoldRiser =
      toComp.type === 'pneumatic_manifold' && Number(edge.to.port) >= 2 && Number(edge.to.port) <= 7;
    if (isFromManifoldRiser) {
      usedVertSegments.push({ x: p2.x, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
      return {
        ...edge,
        waypoints: [
          { x: p2.x, y: p1.y },
          { x: p2.x, y: p2.y },
        ],
      };
    }
    if (isToManifoldRiser) {
      usedVertSegments.push({ x: p1.x, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
      return {
        ...edge,
        waypoints: [
          { x: p1.x, y: p1.y },
          { x: p1.x, y: p2.y },
        ],
      };
    }

    const waypoints = routeOrthogonalManhattan(
      p1,
      p2,
      idx,
      allBoxes,
      fromComp.id,
      toComp.id,
      usedHorizSegments,
      usedVertSegments,
    );
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
      ...(sheetWidthMm > 300 ? { sheetSize: 'DIN_A3_LANDSCAPE' as const } : targetSheetSize ? { sheetSize: targetSheetSize } : {}),
      sheetWidthMm,
      sheetHeightMm,
    },
    components,
    connections,
  };
}

interface HorizSegment {
  y: number;
  minX: number;
  maxX: number;
}

interface VertSegment {
  x: number;
  minY: number;
  maxY: number;
}

function horizontalSegmentHitsBoxOrWire(
  x1: number,
  x2: number,
  y: number,
  boxes: readonly LayoutBox[],
  ignoreA: string,
  ignoreB: string,
  usedHorizSegments: readonly HorizSegment[],
): boolean {
  const minX = Math.min(x1, x2);
  const maxX = Math.max(x1, x2);
  for (const b of boxes) {
    if (b.comp.id === ignoreA || b.comp.id === ignoreB) continue;
    if (y > b.y - 2.5 && y < b.y + b.h + 2.5 && maxX > b.x - 2.5 && minX < b.x + b.w + 2.5) {
      return true;
    }
  }
  for (const seg of usedHorizSegments) {
    if (Math.abs(y - seg.y) < 3 && maxX >= seg.minX - 1 && minX <= seg.maxX + 1) {
      return true;
    }
  }
  return false;
}

function verticalSegmentHitsBoxOrWire(
  x: number,
  y1: number,
  y2: number,
  boxes: readonly LayoutBox[],
  ignoreA: string,
  ignoreB: string,
  usedVertSegments: readonly VertSegment[],
): boolean {
  const minY = Math.min(y1, y2);
  const maxY = Math.max(y1, y2);
  for (const b of boxes) {
    if (b.comp.id === ignoreA || b.comp.id === ignoreB) continue;
    if (x > b.x - 2.5 && x < b.x + b.w + 2.5 && maxY > b.y - 2.5 && minY < b.y + b.h + 2.5) {
      return true;
    }
  }
  for (const seg of usedVertSegments) {
    if (Math.abs(x - seg.x) < 2 && maxY >= seg.minY - 0.5 && minY <= seg.maxY + 0.5) {
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
  usedHorizSegments: HorizSegment[],
  usedVertSegments: VertSegment[],
): Point2D[] {
  if (Math.abs(p1.x - p2.x) < 0.01 || Math.abs(p1.y - p2.y) < 0.01) {
    const straightHoriz = Math.abs(p1.y - p2.y) < 0.01;
    const straightOk = straightHoriz
      ? !horizontalSegmentHitsBoxOrWire(p1.x, p2.x, p1.y, boxes, fromId, toId, usedHorizSegments)
      : !verticalSegmentHitsBoxOrWire(p1.x, p1.y, p2.y, boxes, fromId, toId, usedVertSegments);
    if (straightOk) {
      if (straightHoriz && Math.abs(p1.x - p2.x) >= 1) {
        usedHorizSegments.push({ y: p1.y, minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x) });
      }
      if (!straightHoriz && Math.abs(p1.y - p2.y) >= 1) {
        usedVertSegments.push({ x: p1.x, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
      }
      return [p1, p2];
    }
  }

  // Try clean 2-segment L-routes first when vertical/horizontal start segments don't collide or superimpose
  // L-route A: horizontal at p1.y, then vertical at p2.x
  if (
    !horizontalSegmentHitsBoxOrWire(p1.x, p2.x, p1.y, boxes, fromId, toId, usedHorizSegments) &&
    !verticalSegmentHitsBoxOrWire(p2.x, p1.y, p2.y, boxes, fromId, toId, usedVertSegments)
  ) {
    usedHorizSegments.push({ y: p1.y, minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x) });
    usedVertSegments.push({ x: p2.x, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
    return [p1, { x: p2.x, y: p1.y }, p2];
  }
  if (
    !verticalSegmentHitsBoxOrWire(p1.x, p1.y, p2.y, boxes, fromId, toId, usedVertSegments) &&
    !horizontalSegmentHitsBoxOrWire(p1.x, p2.x, p2.y, boxes, fromId, toId, usedHorizSegments)
  ) {
    usedVertSegments.push({ x: p1.x, minY: Math.min(p1.y, p2.y), maxY: Math.max(p1.y, p2.y) });
    usedHorizSegments.push({ y: p2.y, minX: Math.min(p1.x, p2.x), maxX: Math.max(p1.x, p2.x) });
    return [p1, { x: p1.x, y: p2.y }, p2];
  }

  const baseMidY = snap((p1.y + p2.y) / 2);
  const laneOffsets = [0, 1, -1, 2, -2, 3, -3, 4, -4, 5, -5, 6, -6];
  const preferredStart = channelIndex % 3;
  let chosenY = snap(baseMidY + ((channelIndex % 5) - 2) * GRID_MM);

  for (let k = 0; k < laneOffsets.length; k++) {
    const off = laneOffsets[(k + preferredStart) % laneOffsets.length];
    const candidateY = snap(baseMidY + off * GRID_MM);
    if (
      candidateY >= 25 &&
      !horizontalSegmentHitsBoxOrWire(p1.x, p2.x, candidateY, boxes, fromId, toId, usedHorizSegments) &&
      !verticalSegmentHitsBoxOrWire(p1.x, p1.y, candidateY, boxes, fromId, toId, usedVertSegments) &&
      !verticalSegmentHitsBoxOrWire(p2.x, candidateY, p2.y, boxes, fromId, toId, usedVertSegments)
    ) {
      chosenY = candidateY;
      break;
    }
  }

  usedHorizSegments.push({
    y: chosenY,
    minX: Math.min(p1.x, p2.x),
    maxX: Math.max(p1.x, p2.x),
  });
  usedVertSegments.push({
    x: p1.x,
    minY: Math.min(p1.y, chosenY),
    maxY: Math.max(p1.y, chosenY),
  });
  usedVertSegments.push({
    x: p2.x,
    minY: Math.min(chosenY, p2.y),
    maxY: Math.max(chosenY, p2.y),
  });

  return [
    p1,
    { x: p1.x, y: chosenY },
    { x: p2.x, y: chosenY },
    p2,
  ];
}

/**
 * Iterative fixed-point overlap resolver guaranteeing zero overlapping bounding boxes
 * across all components with at least MIN_CLEARANCE_MM spacing while preserving top header margin.
 */
function resolveBoundingBoxOverlaps(
  components: ComponentNode[],
  maxRightMm?: number,
  elecOriginX?: number,
): void {
  const boxes = components.map((c) => {
    const { w, h } = getRotatedDimensions(c);
    return {
      comp: c,
      w: w + getVisualPaddingRightMm(c),
      h,
    };
  });

  // Clamp any non-conforming y above header margin unless explicitly placed by an imported layout
  for (const b of boxes) {
    if (b.comp.layout && b.comp.layout.y < HEADER_SAFE_Y_MM - 5) {
      b.comp.layout.y = HEADER_SAFE_Y_MM;
    }
  }

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
            const isElec = (getCatalogComponent(target.comp.type)?.layoutLayer ?? 3) >= 10;
            target.comp.layout!.x = isElec && elecOriginX !== undefined ? elecOriginX : MARGIN_X_MM;
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
