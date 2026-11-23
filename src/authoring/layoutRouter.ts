/**
 * General Topological Schematic Layout Engine (FluidSIM-MCP v2)
 *
 * Replaces all v1 hardcoded distributing-station coordinates with a general
 * Sugiyama-inspired topological layout pipeline:
 *  1. Supply backbone extraction (air_source, FRL, manifolds, backbone junctions)
 *  2. Functional branch partitioning (respecting explicit `group`/`sectionLabel`, else connected components)
 *  3. Role-seeded + DAG topological ranking inside each branch (top actuators -> conditioning -> valves -> pilot/supply)
 *  4. Two-pass barycenter crossing reduction per rank
 *  5. Port-axis X-alignment (aligning connected ports by exact D4-transformed port X!)
 *  6. Electrical 24V / 0V ladder organizer to the right of the pneumatic zone
 *  7. Fixed-point zero-overlap bounding-box resolver (accounting for D4 rotation/mirroring + visual padding)
 *  8. Single unified call to `routeDocumentConnectionsMm` (`ctWireRouter.ts`) to populate `edge.waypoints`
 */

import type { CircuitDocument, ComponentNode, FluidSimFlippedCode } from '../contracts/circuit';
import { getCatalogComponent } from '../catalog/pneumatics45';
import { getFluidSim45Prototype } from '../codec/prototypes/fluidsim45Prototypes';
import {
  mirrorToFlippedCode,
  normalizeRotationDeg,
  transformBox,
  transformPoint,
  type RotationDeg,
} from '../codec/ctTransform';
import { routeDocumentConnectionsMm } from '../codec/ctWireRouter';
import { normalizeCircuitTopology } from './topologyNormalizer';

const GRID_MM = 5;
const MIN_CLEARANCE_MM = 9;
const MARGIN_X_MM = 16;
const MARGIN_Y_MM = 16;
const HEADER_SAFE_Y_MM = 36;

function snap(v: number): number {
  return Math.round(v / GRID_MM) * GRID_MM;
}

function naturalCompare(a: string, b: string): number {
  return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
}

export function getEffectiveRotationDeg(comp: ComponentNode): RotationDeg {
  return normalizeRotationDeg(comp.rotationDeg ?? comp.layout?.rotationDeg);
}

export function getEffectiveOrientation(comp: ComponentNode): {
  rotationDeg: RotationDeg;
  flipped: FluidSimFlippedCode;
} {
  return {
    rotationDeg: getEffectiveRotationDeg(comp),
    flipped: mirrorToFlippedCode(comp.mirror ?? comp.layout?.mirror, comp.flipped ?? comp.layout?.flipped),
  };
}

export function getBaseDimensionsMm(comp: ComponentNode): { w: number; h: number } {
  const proto = getFluidSim45Prototype(comp.type);
  return {
    w: proto?.sizeMm.width ?? 20,
    h: proto?.sizeMm.height ?? 12,
  };
}

export function getRotatedDimensions(comp: ComponentNode): { w: number; h: number } {
  const base = getBaseDimensionsMm(comp);
  const { rotationDeg, flipped } = getEffectiveOrientation(comp);
  return transformBox(base.w, base.h, rotationDeg, flipped);
}

export function getVisualPaddingRightMm(comp: ComponentNode): number {
  if (comp.type === 'pressure_switch_differential') return 8;
  if (comp.type === 'cylinder_double_acting' || comp.type === 'cylinder_single_acting') return 14;
  return 0;
}

export function rotatePortOffset(
  offset: { x: number; y: number },
  baseW: number,
  baseH: number,
  rot: RotationDeg,
): { x: number; y: number } {
  return transformPoint(offset.x, offset.y, baseW, baseH, rot, 0);
}

/**
 * Exact D4-transformed port offset in mm (consistent across layoutRouter, ctWireRouter, ctTextCodec, ctSvgRenderer).
 */
export function getEffectivePortOffset(comp: ComponentNode, portName: string): { x: number; y: number } {
  const proto = getFluidSim45Prototype(comp.type);
  const base = getBaseDimensionsMm(comp);
  const gate = proto?.gates.find((g) => g.portName === portName);
  const local = gate?.offsetMm ?? { x: base.w / 2, y: base.h / 2 };
  const { rotationDeg, flipped } = getEffectiveOrientation(comp);
  return transformPoint(local.x, local.y, base.w, base.h, rotationDeg, flipped);
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

function semanticBaseRank(
  comp: ComponentNode,
  doc: CircuitDocument,
  compById: Map<string, ComponentNode>,
): number {
  if (ACTUATOR_TYPES.has(comp.type)) return 0;
  if (
    comp.type === 'flow_control_one_way' ||
    comp.type === 'throttle_valve' ||
    comp.type === 'check_valve' ||
    comp.type === 'check_valve_spring' ||
    comp.type === 'check_valve_pilot_open' ||
    comp.type === 'quick_exhaust_valve' ||
    comp.type === 'air_filter' ||
    comp.type === 'nozzle' ||
    comp.type === 'orifice' ||
    comp.type === 'pressure_gauge' ||
    comp.type === 'pressure_switch_differential' ||
    comp.type === 'pressure_switch_pew'
  ) {
    return 1;
  }
  if (
    comp.type === 'vacuum_suction_nozzle' ||
    comp.type === 'shuttle_valve_or' ||
    comp.type === 'dual_pressure_valve_and' ||
    comp.type === 'air_reservoir' ||
    comp.type === 'pressure_regulator' ||
    comp.type === 'pressure_relief_valve'
  ) {
    return 2;
  }
  if (
    comp.type === 'valve_5_2' ||
    comp.type === 'valve_4_2' ||
    comp.type === 'valve_5_3' ||
    comp.type === 'valve_2_2'
  ) {
    return 3;
  }
  if (comp.type === 'valve_3_2') {
    // If port 2 drives an actuator / conditioning / venturi directly, it's a final control valve (rank 3);
    // otherwise it's a pilot signal / start valve (rank 4).
    const drivesWorkElement = doc.connections.some((e) => {
      const otherId =
        e.from.componentId === comp.id && e.from.port === '2'
          ? e.to.componentId
          : e.to.componentId === comp.id && e.to.port === '2'
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
        other.type === 'vacuum_suction_nozzle' ||
        other.type === 'nozzle' ||
        other.type === 'orifice'
      );
    });
    return drivesWorkElement ? 3 : 4;
  }
  if (comp.type === 'time_delay_valve' || comp.type === 'pressure_sequence_valve') {
    return 4;
  }
  return 2;
}

export function autoLayoutCircuit(
  rawDoc: CircuitDocument,
  options?: { incremental?: boolean },
): CircuitDocument {
  const incremental = options?.incremental ?? false;
  // Normalize nets & orientation metadata first (keeps explicit components & connections intact)
  const { document: normalizedDoc } = normalizeCircuitTopology(rawDoc);

  let targetSheetWidthMm = Math.max(normalizedDoc.metadata.sheetWidthMm || 297, 210);
  let targetSheetHeightMm = Math.max(normalizedDoc.metadata.sheetHeightMm || 210, 148);
  let targetSheetSize = normalizedDoc.metadata.sheetSize;

  const components: ComponentNode[] = normalizedDoc.components.map((c) => {
    const orient = getEffectiveOrientation(c);
    return {
      ...c,
      rotationDeg: orient.rotationDeg !== 0 ? orient.rotationDeg : c.rotationDeg,
      flipped: orient.flipped !== 0 ? orient.flipped : c.flipped,
      layout: c.layout ? { ...c.layout, rotationDeg: orient.rotationDeg } : undefined,
    };
  });

  const compById = new Map<string, ComponentNode>(components.map((c) => [c.id, c]));

  // Build undirected adjacency map
  const neighborIds = new Map<string, Set<string>>();
  for (const e of normalizedDoc.connections) {
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

  // Promote sheet A4 -> A3 Landscape automatically for multi-branch or dense schematics
  if (!incremental && targetSheetWidthMm < 400 && components.length > 14) {
    targetSheetWidthMm = 420;
    targetSheetHeightMm = 297;
    targetSheetSize = 'DIN_A3_LANDSCAPE';
  }

  const computePrintableRight = (wMm: number): { printableRight: number; pneuRight: number } => {
    const printableRight = wMm >= 400 ? Math.min(wMm - MARGIN_X_MM, 390) : Math.min(wMm - MARGIN_X_MM, 272);
    const pneuRight = hasElectricalComponents ? Math.max(wMm * 0.56, 210) : printableRight;
    return { printableRight, pneuRight };
  };

  let { printableRight: maxPrintableRightMm, pneuRight: pneuMaxRightMm } =
    computePrintableRight(targetSheetWidthMm);

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

  // 1. Pneumatic Topological Branch & Backbone Layout
  if (pneuUnplaced.length > 0) {
    const backboneIds = new Set<string>();
    for (const c of pneuUnplaced) {
      if (BACKBONE_TYPES.has(c.type)) backboneIds.add(c.id);
    }
    const SUPPLY_ACCESSORY_TYPES = new Set([
      'pressure_gauge',
      'pressure_switch_differential',
      'pressure_switch_pew',
      'accumulator',
      'air_filter',
      'pressure_regulator',
      'shutoff_valve',
    ]);
    const backboneGroups = new Set<string>();
    for (const c of pneuUnplaced) {
      if (backboneIds.has(c.id) && c.group) backboneGroups.add(c.group);
    }
    // Transitive fixpoint: supply T-junction chains, terminators, and supply-bus accessories stay in backbone
    let addedBackbone = true;
    while (addedBackbone) {
      addedBackbone = false;
      for (const c of pneuUnplaced) {
        if (backboneIds.has(c.id)) continue;
        const isJunction = c.type === 'pneumatic_junction';
        const isTerm = TERMINATOR_TYPES.has(c.type);
        const isAccessory = SUPPLY_ACCESSORY_TYPES.has(c.type);
        if (!isJunction && !isTerm && !isAccessory) continue;
        const nbrs = neighborIds.get(c.id);
        const touchesBackbone = nbrs ? [...nbrs].some((nid) => backboneIds.has(nid)) : false;
        const inBackboneGroup = isAccessory && c.group !== undefined && backboneGroups.has(c.group);
        if (touchesBackbone || inBackboneGroup) {
          backboneIds.add(c.id);
          addedBackbone = true;
        }
      }
    }

    // Partition non-backbone components into functional branches
    const branchCandidates = pneuUnplaced.filter((c) => !backboneIds.has(c.id));
    const branchCandidateSet = new Set(branchCandidates.map((c) => c.id));
    const branches: ComponentNode[][] = [];

    const hasExplicitGroups = branchCandidates.some((c) => Boolean(c.group || c.sectionLabel));
    if (hasExplicitGroups) {
      const grouped = new Map<string, ComponentNode[]>();
      const assignedGroup = new Map<string, string>();
      const ungrouped: ComponentNode[] = [];
      for (const c of branchCandidates) {
        const gKey = c.group || c.sectionLabel;
        if (gKey) {
          const arr = grouped.get(gKey) ?? [];
          arr.push(c);
          grouped.set(gKey, arr);
          assignedGroup.set(c.id, gKey);
        } else {
          ungrouped.push(c);
        }
      }
      // Propagate explicit branch groups to ungrouped synthetic net junctions & terminators
      let propagated = true;
      while (propagated) {
        propagated = false;
        for (let i = ungrouped.length - 1; i >= 0; i--) {
          const c = ungrouped[i];
          if (c.type !== 'pneumatic_junction' && !TERMINATOR_TYPES.has(c.type)) continue;
          const counts = new Map<string, number>();
          for (const nid of neighborIds.get(c.id) ?? []) {
            const ng = assignedGroup.get(nid);
            if (ng) counts.set(ng, (counts.get(ng) ?? 0) + 1);
          }
          if (counts.size > 0) {
            const bestGroup = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0][0];
            const arr = grouped.get(bestGroup) ?? [];
            arr.push(c);
            grouped.set(bestGroup, arr);
            assignedGroup.set(c.id, bestGroup);
            ungrouped.splice(i, 1);
            propagated = true;
          }
        }
      }
      for (const g of grouped.values()) branches.push(g);
      if (ungrouped.length > 0) {
        // Connected components for remaining ungrouped nodes
        const seen = new Set<string>();
        const unSet = new Set(ungrouped.map((c) => c.id));
        for (const start of ungrouped) {
          if (seen.has(start.id)) continue;
          const compGroup: ComponentNode[] = [];
          const q = [start];
          seen.add(start.id);
          while (q.length > 0) {
            const cur = q.shift()!;
            compGroup.push(cur);
            for (const nid of neighborIds.get(cur.id) ?? []) {
              if (!seen.has(nid) && unSet.has(nid)) {
                const nc = compById.get(nid);
                if (nc) {
                  seen.add(nid);
                  q.push(nc);
                }
              }
            }
          }
          branches.push(compGroup);
        }
      }
    } else {
      const visited = new Set<string>();
      for (const start of branchCandidates) {
        if (visited.has(start.id)) continue;
        const group: ComponentNode[] = [];
        const queue: ComponentNode[] = [start];
        visited.add(start.id);
        while (queue.length > 0) {
          const cur = queue.shift()!;
          group.push(cur);
          for (const nid of neighborIds.get(cur.id) ?? []) {
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
    }

    // Auto-promote to A3 if >= 3 branches
    if (!incremental && targetSheetWidthMm < 400 && branches.length >= 3) {
      targetSheetWidthMm = 420;
      targetSheetHeightMm = 297;
      targetSheetSize = 'DIN_A3_LANDSCAPE';
      ({ printableRight: maxPrintableRightMm, pneuRight: pneuMaxRightMm } =
        computePrintableRight(targetSheetWidthMm));
    }

    // Sort branches left-to-right deterministically
    const branchSortKey = (group: ComponentNode[]): string => {
      const sec = group.find((c) => c.group || c.sectionLabel);
      if (sec) return `0:${sec.group || sec.sectionLabel}`;
      const actuators = group
        .filter((c) => ACTUATOR_TYPES.has(c.type))
        .sort((a, b) => naturalCompare(a.label || a.id, b.label || b.id));
      if (actuators.length > 0) return `1:${actuators[0].label || actuators[0].id}`;
      const sorted = [...group].sort((a, b) => naturalCompare(a.label || a.id, b.label || b.id));
      return `2:${sorted[0]?.label || sorted[0]?.id || ''}`;
    };
    branches.sort((a, b) => naturalCompare(branchSortKey(a), branchSortKey(b)));

    // Compute dynamic topological rank inside each branch (general DAG longest-path + semantic anchors)
    const rankOf = new Map<string, number>();
    for (const group of branches) {
      const groupSet = new Set(group.map((c) => c.id));
      // Seed non-junction, non-terminator components by semantic role
      for (const c of group) {
        if (c.type === 'pneumatic_junction' || TERMINATOR_TYPES.has(c.type)) continue;
        rankOf.set(c.id, semanticBaseRank(c, normalizedDoc, compById));
      }
      // Refine inline conditioning chains (e.g., cylinder -> flow_control -> check_valve_pilot_open -> valve)
      // using BFS depth from actuators so cascaded in-line elements get distinct stacked sub-ranks
      const actuators = group.filter((c) => ACTUATOR_TYPES.has(c.type));
      if (actuators.length > 0) {
        const distFromAct = new Map<string, number>();
        const q: string[] = [];
        for (const a of actuators) {
          distFromAct.set(a.id, 0);
          q.push(a.id);
        }
        while (q.length > 0) {
          const curId = q.shift()!;
          const curDist = distFromAct.get(curId)!;
          for (const nid of neighborIds.get(curId) ?? []) {
            if (!groupSet.has(nid) || distFromAct.has(nid)) continue;
            const nc = compById.get(nid);
            if (!nc || TERMINATOR_TYPES.has(nc.type)) continue;
            // Don't cross through junctions as a full rank increment (half-step)
            const inc = nc.type === 'pneumatic_junction' ? 0.5 : 1;
            distFromAct.set(nid, curDist + inc);
            q.push(nid);
          }
        }
        for (const c of group) {
          if (c.type === 'pneumatic_junction' || TERMINATOR_TYPES.has(c.type)) continue;
          const base = rankOf.get(c.id) ?? 2;
          const d = distFromAct.get(c.id);
          // Separate stacked conditioning elements (e.g. flow control at d=1 and pilot check at d=2)
          if (base === 1 && d !== undefined && d >= 1.8) {
            rankOf.set(c.id, 1.5);
          }
        }
      }

      // Place branch-internal pneumatic_junctions at midpoint of their connected neighbors' ranks
      for (let pass = 0; pass < 3; pass++) {
        for (const c of group) {
          if (c.type !== 'pneumatic_junction') continue;
          const nbrRanks: number[] = [];
          for (const nid of neighborIds.get(c.id) ?? []) {
            if (!groupSet.has(nid)) continue;
            const nr = rankOf.get(nid);
            if (nr !== undefined) nbrRanks.push(nr);
          }
          if (nbrRanks.length > 0) {
            const avg = nbrRanks.reduce((s, v) => s + v, 0) / nbrRanks.length;
            // Quantize to 0.5-rank bands so junctions sit cleanly between connected tiers
            rankOf.set(c.id, Math.round(avg * 2) / 2);
          } else {
            rankOf.set(c.id, 1.5);
          }
        }
      }

      // Place attached terminators next to their host component's rank
      for (const c of group) {
        if (!TERMINATOR_TYPES.has(c.type)) continue;
        let hostRank = 3;
        for (const nid of neighborIds.get(c.id) ?? []) {
          const nr = rankOf.get(nid);
          if (nr !== undefined) {
            hostRank = nr;
            break;
          }
        }
        rankOf.set(c.id, hostRank);
      }
    }

    // Allocate column widths proportionally to widest rank per branch
    const usableSpanMm = Math.max(120, pneuMaxRightMm - MARGIN_X_MM);
    const colGapMm = branches.length > 1 ? 16 : 0;
    const availableForColsMm = Math.max(80, usableSpanMm - colGapMm * Math.max(0, branches.length - 1));

    const branchWeights = branches.map((group) => {
      const byRank = new Map<number, ComponentNode[]>();
      for (const c of group) {
        const r = rankOf.get(c.id) ?? 2;
        const arr = byRank.get(r) ?? [];
        arr.push(c);
        byRank.set(r, arr);
      }
      let maxRowW = 50;
      for (const comps of byRank.values()) {
        const visible = comps.filter((c) => !TERMINATOR_TYPES.has(c.type));
        const active = visible.length > 0 ? visible : comps;
        const sumW = active.reduce((s, c) => s + getRotatedDimensions(c).w + getVisualPaddingRightMm(c), 0);
        const effW = Math.min(sumW + Math.max(0, active.length - 1) * (MIN_CLEARANCE_MM + 4), 170);
        maxRowW = Math.max(maxRowW, effW);
      }
      return maxRowW;
    });

    const totalWeight = branchWeights.reduce((a, b) => a + b, 0) || 1;
    let colCursorX = MARGIN_X_MM;
    let maxBranchBottomY = HEADER_SAFE_Y_MM;

    for (let bIdx = 0; bIdx < branches.length; bIdx++) {
      const group = branches[bIdx];
      const colWidth =
        branches.length === 1
          ? availableForColsMm
          : Math.max(60, snap((branchWeights[bIdx] / totalWeight) * availableForColsMm));
      const colLeft = colCursorX;
      const colRight =
        bIdx === branches.length - 1 ? Math.max(colLeft + colWidth, pneuMaxRightMm) : colLeft + colWidth;
      const colSpan = Math.max(55, colRight - colLeft);

      const byRank = new Map<number, ComponentNode[]>();
      for (const c of group) {
        const r = rankOf.get(c.id) ?? 2;
        const arr = byRank.get(r) ?? [];
        arr.push(c);
        byRank.set(r, arr);
      }
      const sortedRanks = Array.from(byRank.keys()).sort((a, b) => a - b);

      // Initial deterministic order inside each rank + 2 barycenter sweeps
      const rankOrder = new Map<number, ComponentNode[]>();
      for (const r of sortedRanks) {
        const list = [...byRank.get(r)!].sort((a, b) => naturalCompare(a.label || a.id, b.label || b.id));
        rankOrder.set(r, list);
      }

      const posIndex = new Map<string, number>();
      const refreshIndices = (): void => {
        for (const list of rankOrder.values()) {
          list.forEach((c, i) => posIndex.set(c.id, i));
        }
      };
      refreshIndices();

      for (let sweep = 0; sweep < 2; sweep++) {
        // Top-down sweep
        for (let ri = 1; ri < sortedRanks.length; ri++) {
          const r = sortedRanks[ri];
          const prevRankSet = new Set(rankOrder.get(sortedRanks[ri - 1])!.map((c) => c.id));
          const list = rankOrder.get(r)!;
          list.sort((a, b) => {
            const bary = (node: ComponentNode): number => {
              let sum = 0;
              let cnt = 0;
              for (const nid of neighborIds.get(node.id) ?? []) {
                if (prevRankSet.has(nid)) {
                  sum += posIndex.get(nid) ?? 0;
                  cnt++;
                }
              }
              return cnt > 0 ? sum / cnt : posIndex.get(node.id) ?? 0;
            };
            const diff = bary(a) - bary(b);
            if (Math.abs(diff) > 0.01) return diff;
            return naturalCompare(a.label || a.id, b.label || b.id);
          });
          refreshIndices();
        }
        // Bottom-up sweep
        for (let ri = sortedRanks.length - 2; ri >= 0; ri--) {
          const r = sortedRanks[ri];
          const nextRankSet = new Set(rankOrder.get(sortedRanks[ri + 1])!.map((c) => c.id));
          const list = rankOrder.get(r)!;
          list.sort((a, b) => {
            const bary = (node: ComponentNode): number => {
              let sum = 0;
              let cnt = 0;
              for (const nid of neighborIds.get(node.id) ?? []) {
                if (nextRankSet.has(nid)) {
                  sum += posIndex.get(nid) ?? 0;
                  cnt++;
                }
              }
              return cnt > 0 ? sum / cnt : posIndex.get(node.id) ?? 0;
            };
            const diff = bary(a) - bary(b);
            if (Math.abs(diff) > 0.01) return diff;
            return naturalCompare(a.label || a.id, b.label || b.id);
          });
          refreshIndices();
        }
      }

      // Vertical placement rank by rank, with adaptive rowGap so deep branches fit cleanly within target sheet height
      const itemGap = MIN_CLEARANCE_MM + 4;
      const branchBudgetH = Math.max(85, targetSheetHeightMm - (backboneIds.size > 0 ? 86 : 42) - HEADER_SAFE_Y_MM);
      const estRowCount = Math.max(1, sortedRanks.length);
      const estRowsH = sortedRanks.reduce((sum, r) => {
        const comps = rankOrder.get(r)!;
        return sum + Math.max(10, ...comps.map((c) => getRotatedDimensions(c).h));
      }, 0);
      const rowGap = Math.max(
        MIN_CLEARANCE_MM + 1,
        Math.min(MIN_CLEARANCE_MM + 10, Math.floor((branchBudgetH - estRowsH) / Math.max(1, estRowCount - 1))),
      );
      let cursorY = HEADER_SAFE_Y_MM;

      for (const r of sortedRanks) {
        const comps = rankOrder.get(r)!;
        // Wrap into sub-rows if wider than colSpan
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

        for (const row of rows) {
          const rowTotalW =
            row.reduce((s, c) => s + getRotatedDimensions(c).w + getVisualPaddingRightMm(c), 0) +
            Math.max(0, row.length - 1) * itemGap;
          const defaultStartX = snap(Math.max(colLeft, colLeft + (colSpan - rowTotalW) / 2));

          // Compute port-axis ideal X for each node in the row based on already-placed upstream connections
          const idealXByComp = new Map<string, number>();
          for (const comp of row) {
            const deltas: number[] = [];
            for (const e of normalizedDoc.connections) {
              let myPort: string | null = null;
              let otherComp: ComponentNode | undefined;
              let otherPort: string | null = null;
              if (e.from.componentId === comp.id) {
                myPort = e.from.port;
                otherComp = compById.get(e.to.componentId);
                otherPort = e.to.port;
              } else if (e.to.componentId === comp.id) {
                myPort = e.to.port;
                otherComp = compById.get(e.from.componentId);
                otherPort = e.from.port;
              }
              if (!myPort || !otherComp?.layout || !otherPort) continue;
              const otherPortWorldX = otherComp.layout.x + getEffectivePortOffset(otherComp, otherPort).x;
              const myPortLocalX = getEffectivePortOffset(comp, myPort).x;
              deltas.push(otherPortWorldX - myPortLocalX);
            }
            if (deltas.length > 0) {
              const avgOriginX = deltas.reduce((s, v) => s + v, 0) / deltas.length;
              idealXByComp.set(comp.id, avgOriginX);
            }
          }

          // Place left-to-right honoring ideal port-axis X whenever it preserves order & clearance
          let minAllowedX = colLeft;
          let fallbackCursorX = defaultStartX;
          let rowMaxH = 0;

          for (const comp of row) {
            const { w: rawW, h } = getRotatedDimensions(comp);
            const fullW = rawW + getVisualPaddingRightMm(comp);
            const rot = getEffectiveRotationDeg(comp);
            const ideal = idealXByComp.get(comp.id);
            const desiredX = ideal !== undefined ? Math.max(minAllowedX, Math.min(colRight - fullW, ideal)) : Math.max(minAllowedX, fallbackCursorX);
            const placedX = Math.max(MARGIN_X_MM, Math.round(desiredX));

            comp.layout = {
              x: placedX,
              y: snap(cursorY),
              rotationDeg: rot,
            };
            minAllowedX = placedX + fullW + itemGap;
            fallbackCursorX = minAllowedX;
            rowMaxH = Math.max(rowMaxH, h);
            maxPneuX = Math.max(maxPneuX, placedX + fullW);
            maxBranchBottomY = Math.max(maxBranchBottomY, comp.layout.y + h);
          }

          cursorY = snap(cursorY + Math.max(rowMaxH, 10) + rowGap);
        }
      }

      colCursorX = snap(colRight + colGapMm);
    }

    // Place Supply Backbone (air_source -> air_service_unit -> manifolds & supply junctions) cleanly at bottom
    const backboneSources = pneuUnplaced
      .filter((c) => backboneIds.has(c.id) && (c.type === 'air_source' || c.type === 'air_service_unit'))
      .sort((a, b) => (a.type === 'air_source' ? 0 : 1) - (b.type === 'air_source' ? 0 : 1) || naturalCompare(a.id, b.id));

    const baseBusY = snap(Math.max(targetSheetHeightMm >= 260 ? 150 : 120, maxBranchBottomY + MIN_CLEARANCE_MM + 6));
    let supplyRightX = MARGIN_X_MM;
    let backboneBottomY = baseBusY;

    if (backboneSources.length > 0) {
      let cx = MARGIN_X_MM;
      for (const comp of backboneSources) {
        const { w, h } = getRotatedDimensions(comp);
        comp.layout = {
          x: snap(cx),
          y: snap(comp.type === 'air_source' ? baseBusY + 4 : baseBusY - 4),
          rotationDeg: getEffectiveRotationDeg(comp),
        };
        cx = snap(comp.layout.x + w + MIN_CLEARANCE_MM + 5);
        supplyRightX = Math.max(supplyRightX, comp.layout.x + w);
        maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
        backboneBottomY = Math.max(backboneBottomY, comp.layout.y + h);
      }
    }

    const isExhaustManifold = (c: ComponentNode): boolean => {
      if (c.type !== 'pneumatic_manifold') return false;
      if (String(c.params.busRole ?? '') === 'exhaust') return true;
      return normalizedDoc.connections.some((e) => {
        const isFrom = e.from.componentId === c.id;
        const isTo = e.to.componentId === c.id;
        if (!isFrom && !isTo) return false;
        const other = compById.get(isFrom ? e.to.componentId : e.from.componentId);
        const otherPort = isFrom ? e.to.port : e.from.port;
        if (!other) return false;
        return other.type === 'exhaust_silencer' || (other.type.startsWith('valve_') && (otherPort === '3' || otherPort === '5'));
      });
    };

    const getBackboneTargetX = (c: ComponentNode): number | undefined => {
      const xs: number[] = [];
      for (const e of normalizedDoc.connections) {
        let other: ComponentNode | undefined;
        let otherPort = '';
        if (e.from.componentId === c.id) {
          other = compById.get(e.to.componentId);
          otherPort = e.to.port;
        } else if (e.to.componentId === c.id) {
          other = compById.get(e.from.componentId);
          otherPort = e.from.port;
        }
        if (other?.layout && !backboneIds.has(other.id)) {
          xs.push(other.layout.x + getEffectivePortOffset(other, otherPort).x);
        }
      }
      if (xs.length === 0) return undefined;
      return xs.reduce((s, v) => s + v, 0) / xs.length;
    };

    const backboneDist = pneuUnplaced
      .filter((c) => backboneIds.has(c.id) && c.type !== 'air_source' && c.type !== 'air_service_unit')
      .sort((a, b) => {
        const rank = (c: ComponentNode): number =>
          c.type === 'pneumatic_manifold'
            ? isExhaustManifold(c)
              ? 1
              : 0
            : c.type === 'pneumatic_junction'
              ? 2
              : 3;
        const rDiff = rank(a) - rank(b);
        if (rDiff !== 0) return rDiff;
        const txA = getBackboneTargetX(a);
        const txB = getBackboneTargetX(b);
        if (txA !== undefined && txB !== undefined && Math.abs(txA - txB) > 1) return txA - txB;
        if (txA !== undefined && txB === undefined) return 1;
        if (txA === undefined && txB !== undefined) return -1;
        return naturalCompare(a.label || a.id, b.label || b.id);
      });

    if (backboneDist.length > 0) {
      const busStartX = supplyRightX > MARGIN_X_MM ? snap(supplyRightX + MIN_CLEARANCE_MM + 8) : MARGIN_X_MM;
      let rowY = baseBusY;
      let cursorX = busStartX;
      let rowMaxH = 0;

      for (const comp of backboneDist) {
        const { w, h } = getRotatedDimensions(comp);
        const exhBus = isExhaustManifold(comp);
        const isSupplyAccessory = SUPPLY_ACCESSORY_TYPES.has(comp.type);

        if (isSupplyAccessory) {
          // Place supply-bus pressure switch / gauge neatly above its tap junction on the supply rail
          let tapX = cursorX;
          for (const nid of neighborIds.get(comp.id) ?? []) {
            const nc = compById.get(nid);
            if (nc?.layout) {
              tapX = nc.layout.x;
              break;
            }
          }
          const placeX = snap(Math.max(MARGIN_X_MM, Math.min(pneuMaxRightMm - w, tapX - w / 2)));
          const placeY = snap(Math.max(HEADER_SAFE_Y_MM, baseBusY + 14));
          comp.layout = {
            x: placeX,
            y: placeY,
            rotationDeg: getEffectiveRotationDeg(comp),
          };
          maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
          backboneBottomY = Math.max(backboneBottomY, comp.layout.y + h);
          continue;
        }

        if ((exhBus && cursorX > busStartX) || (cursorX > busStartX && cursorX + w > pneuMaxRightMm)) {
          cursorX = busStartX;
          rowY = snap(rowY + Math.max(rowMaxH, 8) + MIN_CLEARANCE_MM + 6);
          rowMaxH = 0;
        }

        let desiredX = cursorX;
        if (comp.type === 'pneumatic_junction') {
          const tx = getBackboneTargetX(comp);
          if (tx !== undefined) {
            desiredX = Math.max(cursorX, Math.min(pneuMaxRightMm - w, tx - w / 2));
          }
        }

        comp.layout = {
          x: snap(desiredX),
          y: snap(rowY),
          rotationDeg: getEffectiveRotationDeg(comp),
        };
        const reservedW = comp.type === 'pneumatic_manifold' ? Math.max(w, pneuMaxRightMm - comp.layout.x) : w;
        cursorX = snap(comp.layout.x + reservedW + MIN_CLEARANCE_MM + 8);
        rowMaxH = Math.max(rowMaxH, h);
        maxPneuX = Math.max(maxPneuX, comp.layout.x + w);
        backboneBottomY = Math.max(backboneBottomY, comp.layout.y + h);
      }
    }

    for (const comp of pneuUnplaced) {
      if (!comp.layout) {
        comp.layout = {
          x: MARGIN_X_MM,
          y: snap(backboneBottomY + MIN_CLEARANCE_MM + 6),
          rotationDeg: getEffectiveRotationDeg(comp),
        };
      }
    }
  }

  // 2. Electrical 24V / 0V Ladder Organizer
  const elecOriginX = snap(Math.max(150, maxPneuX + 24));
  const elecLayerY: Record<number, number> =
    targetSheetHeightMm >= 260
      ? { 10: HEADER_SAFE_Y_MM, 10.5: 56, 11: 80, 12: 124, 13: 170, 14: 220 }
      : { 10: HEADER_SAFE_Y_MM, 10.5: 50, 11: 70, 12: 104, 13: 138, 14: 174 };

  const layer12 = elecLayers.get(12);
  if (layer12 && layer12.length > 0) {
    const keep12: ComponentNode[] = [];
    const bus24List = elecLayers.get(10.5) ?? [];
    for (const c of layer12) {
      const nbrs = neighborIds.get(c.id);
      const isTop24vBus =
        c.type === 'electrical_junction' &&
        (c.id === 'BUS_24V' ||
          (nbrs &&
            Array.from(nbrs).some((nid) => {
              const nc = compById.get(nid);
              return nc && (nc.type === 'power_24v' || nc.label === 'ESTOP' || nc.id.includes('ESTOP'));
            })));
      if (isTop24vBus) bus24List.push(c);
      else keep12.push(c);
    }
    if (bus24List.length > 0) elecLayers.set(10.5, bus24List);
    elecLayers.set(12, keep12);
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
      return rank(a) - rank(b) || naturalCompare(a.id, b.id);
    });
    const availW = Math.max(80, maxPrintableRightMm - elecOriginX);
    const sumW = comps.reduce((s, c) => s + getRotatedDimensions(c).w, 0);
    const gap =
      comps.length > 1
        ? Math.max(MIN_CLEARANCE_MM, Math.min(16, Math.floor((availW - sumW) / (comps.length - 1))))
        : 0;
    let cursorX = elecOriginX;
    let baseY = elecLayerY[layer] ?? 105;
    let rowMaxH = 0;

    for (const comp of comps) {
      const { w, h } = getRotatedDimensions(comp);
      if (cursorX > elecOriginX && cursorX + w > maxPrintableRightMm) {
        cursorX = elecOriginX;
        baseY = snap(baseY + Math.max(rowMaxH, 10) + 8);
        rowMaxH = 0;
      }
      comp.layout = {
        x: Math.round(cursorX),
        y: snap(baseY),
        rotationDeg: getEffectiveRotationDeg(comp),
      };
      rowMaxH = Math.max(rowMaxH, h);
      cursorX = comp.layout.x + w + gap;
    }
  }

  // 3. Snap all coordinates to 5mm grid and run fixed-point zero-overlap resolution
  for (const comp of components) {
    if (!comp.layout) continue;
    comp.layout.x = snap(comp.layout.x);
    comp.layout.y = snap(comp.layout.y);
  }
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
    maxBottomMm = Math.max(maxBottomMm, comp.layout.y + h + MARGIN_Y_MM + 4);
  }

  const sheetWidthMm = Math.max(targetSheetWidthMm, snap(maxRightMm));
  const sheetHeightMm = Math.max(targetSheetHeightMm, snap(maxBottomMm));

  // 4. Unified channel-allocated orthogonal routing via ctWireRouter.ts
  const draftDoc: CircuitDocument = {
    ...normalizedDoc,
    metadata: {
      ...normalizedDoc.metadata,
      ...(sheetWidthMm > 300
        ? { sheetSize: 'DIN_A3_LANDSCAPE' as const }
        : targetSheetSize
          ? { sheetSize: targetSheetSize }
          : {}),
      sheetWidthMm,
      sheetHeightMm,
    },
    components,
    connections: normalizedDoc.connections,
  };

  const routedWaypoints = routeDocumentConnectionsMm(draftDoc);
  const connections = normalizedDoc.connections.map((edge) => {
    const wp = routedWaypoints.get(edge.id);
    if (wp && wp.length >= 2) {
      return { ...edge, waypoints: wp };
    }
    const fromComp = compById.get(edge.from.componentId);
    const toComp = compById.get(edge.to.componentId);
    if (!fromComp?.layout || !toComp?.layout) return { ...edge };
    const o1 = getEffectivePortOffset(fromComp, edge.from.port);
    const o2 = getEffectivePortOffset(toComp, edge.to.port);
    const p1 = { x: Number((fromComp.layout.x + o1.x).toFixed(2)), y: Number((fromComp.layout.y + o1.y).toFixed(2)) };
    const p2 = { x: Number((toComp.layout.x + o2.x).toFixed(2)), y: Number((toComp.layout.y + o2.y).toFixed(2)) };
    if (Math.abs(p1.x - p2.x) < 0.05 || Math.abs(p1.y - p2.y) < 0.05) {
      return { ...edge, waypoints: [p1, p2] };
    }
    const midY = Number(((p1.y + p2.y) / 2).toFixed(2));
    return { ...edge, waypoints: [p1, { x: p1.x, y: midY }, { x: p2.x, y: midY }, p2] };
  });

  return {
    ...draftDoc,
    connections,
  };
}

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
