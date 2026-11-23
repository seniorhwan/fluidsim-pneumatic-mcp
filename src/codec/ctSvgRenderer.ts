/**
 * Headless ISO 1219 SVG Schematic Renderer & Quantitative Layout Diagnostics (FluidSIM-MCP v2)
 *
 * Pure TypeScript (zero DOM / Canvas / native dependencies). Renders any CircuitDocument
 * using the exact FluidSIM 4.5 prototype geometry (`FLUIDSIM45_PROTOTYPES` + `ctValveCompiler`),
 * unified D4 orientation transforms (`ctTransform`), routed orthogonal waypoints, inline
 * port terminators (`EX3` silencer / `EX4` blind plug), distance rules, and 2D collision-free
 * labels (`ctLabelPlacer`).
 */

import type { CircuitDocument, ComponentNode, ConnectionEdge, FluidSimFlippedCode } from '../contracts/circuit';
import { getFluidSim45Prototype } from './prototypes/fluidsim45Prototypes';
import { buildValveSymPrimitives } from './ctValveCompiler';
import { isDirectionalValveType } from './ctSymbolLibrary';
import {
  mirrorToFlippedCode,
  normalizeRotationDeg,
  transformBox,
  transformPoint,
  transformSymPrimitivesMm,
  type RectMm,
  type RotationDeg,
  type SymPrimitive,
} from './ctTransform';
import {
  evaluateLabelMetrics,
  placeSchematicLabels,
  rectOverlapArea,
  segmentIntersectsRect,
  type LabelableSymbol,
  type PlacedTextLabel,
  type WireSegmentMm,
} from './ctLabelPlacer';
import { routeDocumentConnectionsMm } from './ctWireRouter';
import { normalizeCircuitTopology } from '../authoring/topologyNormalizer';

export interface SvgLayoutDiagnostics {
  componentOverlaps: number;
  wireThroughComponent: number;
  wireCrossings: number;
  labelOverlaps: number;
  labelWireHits: number;
  outOfBoundsCount: number;
  totalWireLengthMm: number;
  bendCount: number;
  qualityScore: number;
  visualLayoutOk: boolean;
  details: string[];
}

export interface RenderSvgResult {
  svg: string;
  widthMm: number;
  heightMm: number;
  diagnostics: SvgLayoutDiagnostics;
  placedLabels: PlacedTextLabel[];
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function getOrientation(comp: ComponentNode): { rot: RotationDeg; flipped: FluidSimFlippedCode } {
  return {
    rot: normalizeRotationDeg(comp.rotationDeg ?? comp.layout?.rotationDeg),
    flipped: mirrorToFlippedCode(comp.mirror ?? comp.layout?.mirror, comp.flipped ?? comp.layout?.flipped),
  };
}

function getSymbolGeometryMm(comp: ComponentNode): {
  baseW: number;
  baseH: number;
  primitives: readonly SymPrimitive[];
} {
  const proto = getFluidSim45Prototype(comp.type);
  if (!proto) {
    return { baseW: 20, baseH: 12, primitives: [] };
  }
  if (isDirectionalValveType(comp.type)) {
    return {
      baseW: proto.sizeMm.width,
      baseH: proto.sizeMm.height,
      primitives: buildValveSymPrimitives(comp),
    };
  }
  return {
    baseW: proto.sizeMm.width,
    baseH: proto.sizeMm.height,
    primitives: proto.symPrimitives,
  };
}

function computeComponentPortWorldMm(
  comp: ComponentNode,
  portName: string,
  originX: number,
  originY: number,
): { x: number; y: number } {
  const proto = getFluidSim45Prototype(comp.type);
  const { rot, flipped } = getOrientation(comp);
  const baseW = proto?.sizeMm.width ?? 20;
  const baseH = proto?.sizeMm.height ?? 12;
  const gate = proto?.gates.find((g) => g.portName === portName);
  const localX = gate ? gate.offsetMm.x : baseW / 2;
  const localY = gate ? gate.offsetMm.y : baseH / 2;
  const t = transformPoint(localX, localY, baseW, baseH, rot, flipped);
  return {
    x: Number((originX + t.x).toFixed(2)),
    y: Number((originY + t.y).toFixed(2)),
  };
}

function segmentsProperlyCross(a: WireSegmentMm, b: WireSegmentMm): boolean {
  const aHoriz = Math.abs(a.y1 - a.y2) < 0.05;
  const bHoriz = Math.abs(b.y1 - b.y2) < 0.05;
  const aVert = Math.abs(a.x1 - a.x2) < 0.05;
  const bVert = Math.abs(b.x1 - b.x2) < 0.05;
  if (aHoriz && bVert) {
    const ax1 = Math.min(a.x1, a.x2);
    const ax2 = Math.max(a.x1, a.x2);
    const by1 = Math.min(b.y1, b.y2);
    const by2 = Math.max(b.y1, b.y2);
    return b.x1 > ax1 + 0.5 && b.x1 < ax2 - 0.5 && a.y1 > by1 + 0.5 && a.y1 < by2 - 0.5;
  }
  if (aVert && bHoriz) {
    return segmentsProperlyCross(b, a);
  }
  return false;
}

function renderPrimitiveSvg(prim: SymPrimitive, ox: number, oy: number, stroke: string): string {
  const sw = 0.35;
  if (prim.kind === 'line') {
    const dash = prim.style === 1 ? ' stroke-dasharray="1.4 0.9"' : '';
    return `<line x1="${(ox + prim.x1).toFixed(2)}" y1="${(oy + prim.y1).toFixed(2)}" x2="${(ox + prim.x2).toFixed(2)}" y2="${(oy + prim.y2).toFixed(2)}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"${dash}/>`;
  }
  if (prim.kind === 'rect') {
    const x = Math.min(prim.x1, prim.x2);
    const y = Math.min(prim.y1, prim.y2);
    const w = Math.abs(prim.x2 - prim.x1);
    const h = Math.abs(prim.y2 - prim.y1);
    const fill = prim.fill ? stroke : 'none';
    return `<rect x="${(ox + x).toFixed(2)}" y="${(oy + y).toFixed(2)}" width="${w.toFixed(2)}" height="${h.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  if (prim.kind === 'circle') {
    const fill = prim.fill ? stroke : 'none';
    return `<circle cx="${(ox + prim.cx).toFixed(2)}" cy="${(oy + prim.cy).toFixed(2)}" r="${prim.r.toFixed(2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  if (prim.kind === 'poly' && prim.points.length >= 2) {
    const pts = prim.points.map((p) => `${(ox + p.x).toFixed(2)},${(oy + p.y).toFixed(2)}`).join(' ');
    const fill = prim.fill ? stroke : 'none';
    return `<polygon points="${pts}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" stroke-linejoin="round"/>`;
  }
  if (prim.kind === 'arc') {
    const r = Math.max(0.2, prim.r);
    const startRad = (prim.startDeg * Math.PI) / 180;
    const endRad = (prim.endDeg * Math.PI) / 180;
    const sx = ox + prim.cx + r * Math.cos(startRad);
    const sy = oy + prim.cy - r * Math.sin(startRad);
    const ex = ox + prim.cx + r * Math.cos(endRad);
    const ey = oy + prim.cy - r * Math.sin(endRad);
    const sweepDeg = (((prim.endDeg - prim.startDeg) % 360) + 360) % 360;
    const largeArc = sweepDeg > 180 ? 1 : 0;
    return `<path d="M ${sx.toFixed(2)} ${sy.toFixed(2)} A ${r.toFixed(2)} ${r.toFixed(2)} 0 ${largeArc} 0 ${ex.toFixed(2)} ${ey.toFixed(2)}" fill="none" stroke="${stroke}" stroke-width="${sw}"/>`;
  }
  return '';
}

export function renderCircuitToSvg(
  rawDoc: CircuitDocument,
  options?: { scalePxPerMm?: number; showGrid?: boolean },
): RenderSvgResult {
  const { document: doc } = normalizeCircuitTopology(rawDoc);
  const scale = options?.scalePxPerMm ?? 3.0;
  const sheetW = doc.metadata.sheetWidthMm || 297;
  const sheetH = doc.metadata.sheetHeightMm || 210;
  const safeBounds: RectMm = {
    x: 6,
    y: 6,
    width: Math.max(40, sheetW - 12),
    height: Math.max(40, sheetH - 22),
  };

  const titleBlockBox: RectMm = {
    x: sheetW - 95,
    y: sheetH - 18,
    width: 90,
    height: 14,
  };

  interface ResolvedComp {
    comp: ComponentNode;
    originX: number;
    originY: number;
    boxMm: RectMm;
    pistonRodBoxMm?: RectMm;
    primitives: SymPrimitive[];
    isJunction: boolean;
    isActuator: boolean;
    isValve: boolean;
    domain: 'pneumatic' | 'electrical' | 'hybrid';
  }

  const resolved = new Map<string, ResolvedComp>();
  const reservedBoxes: RectMm[] = [titleBlockBox];

  // Collapse degree-1 exhaust_silencer / blind_plug terminators onto their host component port
  // (matches native FluidSIM 4.5 EX3/EX4 embedded port terminators in ctTextCompiler.ts).
  const edgesByComp = new Map<string, ConnectionEdge[]>();
  for (const e of doc.connections) {
    const a = edgesByComp.get(e.from.componentId) ?? [];
    a.push(e);
    edgesByComp.set(e.from.componentId, a);
    const b = edgesByComp.get(e.to.componentId) ?? [];
    b.push(e);
    edgesByComp.set(e.to.componentId, b);
  }
  const collapsedCompIds = new Set<string>();
  const collapsedEdgeIds = new Set<string>();
  const embeddedTerminators: Array<{ hostId: string; hostPort: string; kind: 'EX3' | 'EX4' }> = [];

  for (const c of doc.components) {
    if (c.type !== 'exhaust_silencer' && c.type !== 'blind_plug') continue;
    const incident = edgesByComp.get(c.id) ?? [];
    if (incident.length !== 1) continue;
    const edge = incident[0];
    const hostId = edge.from.componentId === c.id ? edge.to.componentId : edge.from.componentId;
    const hostPort = edge.from.componentId === c.id ? edge.to.port : edge.from.port;
    collapsedCompIds.add(c.id);
    collapsedEdgeIds.add(edge.id);
    embeddedTerminators.push({
      hostId,
      hostPort,
      kind: c.type === 'blind_plug' ? 'EX4' : 'EX3',
    });
  }

  for (const comp of doc.components) {
    if (collapsedCompIds.has(comp.id)) continue;
    const proto = getFluidSim45Prototype(comp.type);
    const { rot, flipped } = getOrientation(comp);
    const geom = getSymbolGeometryMm(comp);
    const tBox = transformBox(geom.baseW, geom.baseH, rot, flipped);
    const originX = comp.layout?.x ?? 20;
    const originY = comp.layout?.y ?? 20;
    const boxMm: RectMm = {
      x: originX,
      y: originY,
      width: tBox.w,
      height: tBox.h,
    };

    const isActuator =
      comp.type === 'cylinder_double_acting' ||
      comp.type === 'cylinder_single_acting' ||
      comp.type === 'cylinder_rodless' ||
      comp.type === 'swivel_drive' ||
      comp.type === 'air_motor';
    const isValve = isDirectionalValveType(comp.type);
    const isJunction = comp.type === 'pneumatic_junction' || comp.type === 'electrical_junction';

    if (isActuator && comp.distanceRule && comp.distanceRule.length > 0) {
      reservedBoxes.push({
        x: originX,
        y: Math.max(safeBounds.y, originY - 12),
        width: Math.max(tBox.w, 28),
        height: 9,
      });
    }

    const transformedPrims = transformSymPrimitivesMm(geom.primitives, geom.baseW, geom.baseH, rot, flipped);
    const hasElec = proto?.gates.some((g) => g.domain === 'electrical') ?? false;
    const hasPneu = proto?.gates.some((g) => g.domain === 'pneumatic') ?? false;
    const domain: 'pneumatic' | 'electrical' | 'hybrid' =
      hasElec && hasPneu ? 'hybrid' : hasElec ? 'electrical' : 'pneumatic';

    resolved.set(comp.id, {
      comp,
      originX,
      originY,
      boxMm,
      primitives: transformedPrims,
      isJunction,
      isActuator,
      isValve,
      domain,
    });
  }

  // Fallback obstacle-avoiding routing via unified ctWireRouter for any edges without pre-routed waypoints
  const activeEdges = doc.connections.filter((e) => !collapsedEdgeIds.has(e.id));
  const needsFallbackRouting = activeEdges.some((e) => !e.waypoints || e.waypoints.length < 2);
  const fallbackWaypointsByEdgeId = needsFallbackRouting
    ? routeDocumentConnectionsMm({
        ...doc,
        components: doc.components.filter((c) => !collapsedCompIds.has(c.id)),
        connections: activeEdges,
      })
    : new Map<string, Array<{ x: number; y: number }>>();

  const wireSegments: Array<WireSegmentMm & { edge: ConnectionEdge; domain: 'pneumatic' | 'electrical' }> = [];
  let totalWireLengthMm = 0;
  let bendCount = 0;

  for (const edge of activeEdges) {
    const fc = resolved.get(edge.from.componentId);
    const tc = resolved.get(edge.to.componentId);
    if (!fc || !tc) continue;

    let pts =
      edge.waypoints && edge.waypoints.length >= 2
        ? edge.waypoints
        : fallbackWaypointsByEdgeId.get(edge.id) ?? null;
    if (!pts) {
      const p1 = computeComponentPortWorldMm(fc.comp, edge.from.port, fc.originX, fc.originY);
      const p2 = computeComponentPortWorldMm(tc.comp, edge.to.port, tc.originX, tc.originY);
      pts = [p1, p2];
    }

    let prevDir: 'H' | 'V' | null = null;
    for (let i = 0; i < pts.length - 1; i++) {
      const a = pts[i];
      const b = pts[i + 1];
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len < 0.05) continue;
      totalWireLengthMm += len;
      const dir: 'H' | 'V' = Math.abs(b.x - a.x) >= Math.abs(b.y - a.y) ? 'H' : 'V';
      if (prevDir && prevDir !== dir) bendCount += 1;
      prevDir = dir;
      wireSegments.push({
        x1: a.x,
        y1: a.y,
        x2: b.x,
        y2: b.y,
        netId: edge.id,
        edge,
        domain: edge.domain,
      });
    }
  }

  const labelables: LabelableSymbol[] = [...resolved.values()].map((r) => ({
    id: r.comp.id,
    type: r.comp.type,
    label: r.comp.label,
    sectionLabel: r.comp.sectionLabel,
    boxMm: r.boxMm,
    pistonRodBoxMm: r.pistonRodBoxMm,
    isActuator: r.isActuator,
    isValve: r.isValve,
    isJunction: r.isJunction,
  }));

  const placedLabels = placeSchematicLabels({
    symbols: labelables,
    wireSegmentsMm: wireSegments,
    sheetBoundsMm: safeBounds,
    reservedBoxesMm: reservedBoxes,
  });

  const details: string[] = [];
  const compList = [...resolved.values()].filter((r) => !r.isJunction);

  let componentOverlaps = 0;
  for (let i = 0; i < compList.length; i++) {
    for (let j = i + 1; j < compList.length; j++) {
      const area = rectOverlapArea(compList[i].boxMm, compList[j].boxMm, 0);
      if (area > 0.5) {
        componentOverlaps += 1;
        details.push(
          `Component overlap between "${compList[i].comp.id}" and "${compList[j].comp.id}" (${area.toFixed(1)} mm^2).`,
        );
      }
    }
  }

  let outOfBoundsCount = 0;
  for (const r of compList) {
    if (
      r.boxMm.x < 1 ||
      r.boxMm.y < 1 ||
      r.boxMm.x + r.boxMm.width > sheetW - 1 ||
      r.boxMm.y + r.boxMm.height > sheetH - 1
    ) {
      outOfBoundsCount += 1;
      details.push(`Component "${r.comp.id}" extends outside sheet (${sheetW}x${sheetH} mm).`);
    }
  }

  let wireThroughComponent = 0;
  for (const seg of wireSegments) {
    for (const r of compList) {
      if (r.comp.id === seg.edge.from.componentId || r.comp.id === seg.edge.to.componentId) {
        continue;
      }
      const shrunk: RectMm = {
        x: r.boxMm.x + 1.0,
        y: r.boxMm.y + 1.0,
        width: Math.max(0.5, r.boxMm.width - 2.0),
        height: Math.max(0.5, r.boxMm.height - 2.0),
      };
      if (segmentIntersectsRect(seg, shrunk, 0)) {
        wireThroughComponent += 1;
        details.push(
          `Wire "${seg.edge.id}" (${seg.edge.from.componentId}.${seg.edge.from.port} -> ${seg.edge.to.componentId}.${seg.edge.to.port}) passes through component "${r.comp.id}".`,
        );
        break;
      }
    }
  }

  let wireCrossings = 0;
  for (let i = 0; i < wireSegments.length; i++) {
    for (let j = i + 1; j < wireSegments.length; j++) {
      const a = wireSegments[i];
      const b = wireSegments[j];
      if (a.edge.id === b.edge.id) continue;
      if (segmentsProperlyCross(a, b)) {
        wireCrossings += 1;
      }
    }
  }

  const obstacles: RectMm[] = [...reservedBoxes, ...compList.map((r) => r.boxMm)];
  const lblMetrics = evaluateLabelMetrics(placedLabels, obstacles, wireSegments, safeBounds);
  const labelOverlaps = lblMetrics.labelObstacleOverlaps + lblMetrics.labelLabelOverlaps;
  outOfBoundsCount += lblMetrics.labelOutOfBounds;
  details.push(...lblMetrics.details);

  const rawScore =
    100 -
    componentOverlaps * 25 -
    wireThroughComponent * 15 -
    outOfBoundsCount * 20 -
    labelOverlaps * 10 -
    lblMetrics.labelWireHits * 2 -
    Math.min(20, wireCrossings * 1.5);
  const qualityScore = Math.max(0, Math.min(100, Math.round(rawScore)));
  const visualLayoutOk =
    componentOverlaps === 0 &&
    wireThroughComponent === 0 &&
    outOfBoundsCount === 0 &&
    labelOverlaps === 0;

  const parts: string[] = [];
  const pxW = Math.round(sheetW * scale);
  const pxH = Math.round(sheetH * scale);
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${pxW}" height="${pxH}" viewBox="0 0 ${sheetW} ${sheetH}" style="background:#ffffff">`,
  );
  parts.push(
    `<rect x="3" y="3" width="${sheetW - 6}" height="${sheetH - 6}" fill="#ffffff" stroke="#1e293b" stroke-width="0.45"/>`,
  );
  parts.push(
    `<rect x="${titleBlockBox.x}" y="${titleBlockBox.y}" width="${titleBlockBox.width}" height="${titleBlockBox.height}" fill="#f8fafc" stroke="#1e293b" stroke-width="0.35"/>`,
  );
  parts.push(
    `<text x="${titleBlockBox.x + 3}" y="${titleBlockBox.y + 6}" font-family="sans-serif" font-size="3.2" font-weight="bold" fill="#0f172a">${escapeXml(doc.metadata.title || 'Pneumatic Schematic')}</text>`,
  );
  parts.push(
    `<text x="${titleBlockBox.x + 3}" y="${titleBlockBox.y + 11}" font-family="monospace, sans-serif" font-size="2.3" fill="#475569">${escapeXml(`${doc.components.length} comps | ${doc.connections.length} wires | score ${qualityScore}/100`)}</text>`,
  );

  if (options?.showGrid) {
    parts.push('<g stroke="#e2e8f0" stroke-width="0.12">');
    for (let gx = 10; gx < sheetW - 5; gx += 10) {
      parts.push(`<line x1="${gx}" y1="5" x2="${gx}" y2="${sheetH - 5}"/>`);
    }
    for (let gy = 10; gy < sheetH - 5; gy += 10) {
      parts.push(`<line x1="5" y1="${gy}" x2="${sheetW - 5}" y2="${gy}"/>`);
    }
    parts.push('</g>');
  }

  parts.push('<g id="wires">');
  for (const seg of wireSegments) {
    const color = seg.domain === 'electrical' ? '#b91c1c' : '#0f4c81';
    parts.push(
      `<line x1="${seg.x1.toFixed(2)}" y1="${seg.y1.toFixed(2)}" x2="${seg.x2.toFixed(2)}" y2="${seg.y2.toFixed(2)}" stroke="${color}" stroke-width="0.42" stroke-linecap="round"/>`,
    );
  }
  parts.push('</g>');

  parts.push('<g id="components">');
  for (const r of resolved.values()) {
    const stroke = r.domain === 'electrical' ? '#7f1d1d' : '#0f172a';
    parts.push(`<g data-id="${escapeXml(r.comp.id)}" data-type="${escapeXml(r.comp.type)}">`);
    if (r.isJunction) {
      const cx = r.boxMm.x + r.boxMm.width / 2;
      const cy = r.boxMm.y + r.boxMm.height / 2;
      parts.push(`<circle cx="${cx.toFixed(2)}" cy="${cy.toFixed(2)}" r="0.9" fill="${stroke}"/>`);
    } else {
      for (const prim of r.primitives) {
        const el = renderPrimitiveSvg(prim, r.originX, r.originY, stroke);
        if (el) parts.push(el);
      }
    }

    if (r.isActuator && r.comp.distanceRule && r.comp.distanceRule.length > 0) {
      const barY = r.originY - 5.5;
      const barW = Math.max(r.boxMm.width, 28);
      parts.push(
        `<line x1="${r.originX.toFixed(2)}" y1="${barY.toFixed(2)}" x2="${(r.originX + barW).toFixed(2)}" y2="${barY.toFixed(2)}" stroke="#334155" stroke-width="0.3"/>`,
      );
      const strokeSpan =
        typeof r.comp.params.strokeMm === 'number'
          ? r.comp.params.strokeMm
          : typeof r.comp.params.maxAngleDeg === 'number'
            ? r.comp.params.maxAngleDeg
            : 100;
      for (const m of r.comp.distanceRule) {
        const frac = strokeSpan > 0 ? Math.max(0, Math.min(1, m.positionMm / strokeSpan)) : 0;
        const mx = r.originX + frac * barW;
        parts.push(
          `<line x1="${mx.toFixed(2)}" y1="${(barY - 1.4).toFixed(2)}" x2="${mx.toFixed(2)}" y2="${(barY + 1.4).toFixed(2)}" stroke="#334155" stroke-width="0.3"/>`,
        );
        parts.push(
          `<text x="${mx.toFixed(2)}" y="${(barY - 2.2).toFixed(2)}" font-family="monospace, sans-serif" font-size="2.3" fill="#0f172a" text-anchor="middle">${escapeXml(m.label)}</text>`,
        );
      }
    }
    parts.push('</g>');
  }
  // Render embedded ISO 1219 exhaust silencer triangles (EX3) & blind plugs (EX4) directly on host ports
  for (const term of embeddedTerminators) {
    const host = resolved.get(term.hostId);
    if (!host) continue;
    const pt = computeComponentPortWorldMm(host.comp, term.hostPort, host.originX, host.originY);
    if (term.kind === 'EX3') {
      const tx = pt.x;
      const ty = pt.y;
      parts.push(
        `<polygon points="${(tx - 1.3).toFixed(2)},${(ty + 0.4).toFixed(2)} ${(tx + 1.3).toFixed(2)},${(ty + 0.4).toFixed(2)} ${tx.toFixed(2)},${(ty + 2.6).toFixed(2)}" fill="none" stroke="#0f172a" stroke-width="0.32"/>`,
      );
    } else {
      parts.push(
        `<line x1="${(pt.x - 1.2).toFixed(2)}" y1="${(pt.y + 1.2).toFixed(2)}" x2="${(pt.x + 1.2).toFixed(2)}" y2="${(pt.y + 1.2).toFixed(2)}" stroke="#0f172a" stroke-width="0.45"/>`,
      );
    }
  }
  parts.push('</g>');

  parts.push('<g id="labels">');
  for (const lbl of placedLabels) {
    if (lbl.kind === 'section') {
      parts.push(
        `<text x="${(lbl.xMm + lbl.widthMm / 2).toFixed(2)}" y="${(lbl.yMm + lbl.fontSizeMm).toFixed(2)}" font-family="sans-serif" font-size="${lbl.fontSizeMm.toFixed(2)}" font-weight="bold" fill="#1e3a8a" text-anchor="middle">${escapeXml(lbl.text)}</text>`,
      );
    } else {
      parts.push(
        `<text x="${lbl.xMm.toFixed(2)}" y="${(lbl.yMm + lbl.fontSizeMm).toFixed(2)}" font-family="monospace, sans-serif" font-size="${lbl.fontSizeMm.toFixed(2)}" fill="#0f172a">${escapeXml(lbl.text)}</text>`,
      );
    }
  }
  parts.push('</g>');

  parts.push('</svg>');

  return {
    svg: parts.join('\n'),
    widthMm: sheetW,
    heightMm: sheetH,
    diagnostics: {
      componentOverlaps,
      wireThroughComponent,
      wireCrossings,
      labelOverlaps,
      labelWireHits: lblMetrics.labelWireHits,
      outOfBoundsCount,
      totalWireLengthMm: Number(totalWireLengthMm.toFixed(1)),
      bendCount,
      qualityScore,
      visualLayoutOk,
      details,
    },
    placedLabels,
  };
}
