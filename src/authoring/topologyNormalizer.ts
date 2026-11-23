/**
 * IR v2 Topology Normalizer.
 *
 * Bridges clean semantic IR v2 features (inline `portTerminators`, named `nets[]`,
 * D4 `mirror`/`rotationDeg`) with legacy explicit-node topology so the Static Validator,
 * Behavioral Simulator, Topological Layout Engine, and Prototype-Driven `.ct` Compiler
 * all operate on a single consistent graph representation:
 *
 *   1. Syncs `rotationDeg` / `mirror` / `flipped` consistently between ComponentNode & ComponentLayout.
 *   2. Lowers named `nets[]` (degree 2 -> direct edge; degree >= 3 -> clean 3-gate T-junction chain
 *      of `pneumatic_junction` / `electrical_junction` nodes using ports 1, 2, 3 — NEVER 4-gate hacks).
 *   3. Expands inline `portTerminators` and net-level `terminators` into synthetic terminator nodes/edges
 *      for validator & simulator evaluation while preserving `_syntheticFromInlineTerminator` metadata so
 *      the `.ct` compiler embeds them directly as `PConnection ex_type EX3 / EX4`.
 */

import type {
  CircuitDocument,
  ComponentNode,
  ConnectionEdge,
  PortRef,
  PortTerminatorType,
} from '../contracts/circuit';
import {
  flippedCodeToMirror,
  mirrorToFlippedCode,
  normalizeRotationDeg,
} from '../codec/ctTransform';

export interface NormalizedCircuitView {
  /** Expanded graph ready for validator, simulator, layout, and `.ct` emission. */
  document: CircuitDocument;
  /** Map of `"componentId:port"` -> inline terminator type (for `.ct` embedding & inspection). */
  inlineTerminators: Map<string, PortTerminatorType>;
  /** Set of synthetic component IDs synthesized from `nets[]` or `portTerminators`. */
  syntheticComponentIds: Set<string>;
}

function makeUniqueId(base: string, used: Set<string>): string {
  let candidate = base;
  let i = 1;
  while (used.has(candidate)) {
    candidate = `${base}_${i++}`;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Normalizes a single ComponentNode's D4 orientation fields (`rotationDeg`, `mirror`, `flipped`, `layout`).
 */
export function normalizeComponentOrientation(comp: ComponentNode): ComponentNode {
  const rot = normalizeRotationDeg(comp.rotationDeg ?? comp.layout?.rotationDeg ?? 0);
  const flipCode = mirrorToFlippedCode(
    comp.mirror ?? comp.layout?.mirror,
    comp.flipped ?? comp.layout?.flipped,
  );
  const mirror = flippedCodeToMirror(flipCode);

  return {
    ...comp,
    rotationDeg: rot !== 0 ? rot : comp.rotationDeg,
    mirror: flipCode !== 0 ? mirror : comp.mirror,
    flipped: flipCode !== 0 ? flipCode : comp.flipped,
    layout: comp.layout
      ? {
          ...comp.layout,
          rotationDeg: rot,
          mirror: flipCode !== 0 ? mirror : undefined,
          flipped: flipCode !== 0 ? flipCode : undefined,
        }
      : undefined,
  };
}

/**
 * Lowers an IR v2 or legacy CircuitDocument into an expanded normalized topology where:
 * - Every `CircuitNet` is lowered into direct edges (deg 2) or 3-gate T-junction trees (deg >= 3)
 * - Every inline `portTerminators` entry is expanded into a virtual terminator node/edge so
 *   static validation and simulation work identically with zero special cases
 * - Original `nets` and `portTerminators` remain intact on the canonical document
 */
export function normalizeCircuitTopology(
  doc: CircuitDocument,
  options?: { expandTerminators?: boolean; expandNets?: boolean },
): NormalizedCircuitView {
  const expandTerminators = options?.expandTerminators ?? true;
  const expandNets = options?.expandNets ?? true;

  const components: ComponentNode[] = doc.components.map(normalizeComponentOrientation);
  const connections: ConnectionEdge[] = doc.connections.map((e) => ({ ...e }));
  const usedCompIds = new Set<string>(components.map((c) => c.id));
  const usedEdgeIds = new Set<string>(connections.map((e) => e.id));
  const syntheticComponentIds = new Set<string>();
  const inlineTerminators = new Map<string, PortTerminatorType>();

  const existingEdgeKeySet = new Set<string>();
  const edgeKey = (a: PortRef, b: PortRef): string => {
    const ka = `${a.componentId}:${a.port}`;
    const kb = `${b.componentId}:${b.port}`;
    return ka < kb ? `${ka}<->${kb}` : `${kb}<->${ka}`;
  };
  for (const e of connections) {
    existingEdgeKeySet.add(edgeKey(e.from, e.to));
  }

  // 1. Expand inline portTerminators
  for (const comp of doc.components) {
    if (!comp.portTerminators) continue;
    for (const [portName, termType] of Object.entries(comp.portTerminators)) {
      if (termType !== 'exhaust_silencer' && termType !== 'blind_plug') continue;
      inlineTerminators.set(`${comp.id}:${portName}`, termType);

      if (!expandTerminators) continue;
      // Skip if an explicit edge already connects this port to a terminator
      const alreadyConnected = connections.some(
        (e) =>
          (e.from.componentId === comp.id && e.from.port === portName) ||
          (e.to.componentId === comp.id && e.to.port === portName),
      );
      if (alreadyConnected) continue;

      const synId = makeUniqueId(
        `__TERM_${comp.id}_${portName}_${termType === 'blind_plug' ? 'PLUG' : 'EXH'}`,
        usedCompIds,
      );
      syntheticComponentIds.add(synId);
      components.push({
        id: synId,
        type: termType,
        params: {},
        group: comp.group,
        rawMetadata: { _syntheticInlineTerminator: true, _parentCompId: comp.id, _parentPort: portName },
      });
      const eid = makeUniqueId(`__E_TERM_${comp.id}_${portName}`, usedEdgeIds);
      const edge: ConnectionEdge = {
        id: eid,
        from: { componentId: comp.id, port: portName },
        to: { componentId: synId, port: '1' },
        domain: 'pneumatic',
      };
      connections.push(edge);
      existingEdgeKeySet.add(edgeKey(edge.from, edge.to));
    }
  }

  // 2. Expand named shared nets[] into clean 3-gate binary T-junction trees
  if (expandNets && doc.nets && doc.nets.length > 0) {
    for (const net of doc.nets) {
      const allEndpoints: PortRef[] = [...net.endpoints];

      // Synthesize any net-level terminators (e.g. shared exhaust silencer or blind plug on a bus)
      if (net.domain === 'pneumatic' && net.terminators && net.terminators.length > 0) {
        for (let tIdx = 0; tIdx < net.terminators.length; tIdx++) {
          const termType = net.terminators[tIdx];
          const synId = makeUniqueId(`__NETTERM_${net.id}_${tIdx + 1}`, usedCompIds);
          syntheticComponentIds.add(synId);
          components.push({
            id: synId,
            type: termType,
            params: {},
            rawMetadata: { _syntheticNetTerminator: true, _netId: net.id },
          });
          allEndpoints.push({ componentId: synId, port: '1' });
        }
      }

      if (allEndpoints.length < 2) continue;

      if (allEndpoints.length === 2) {
        const [a, b] = allEndpoints;
        const k = edgeKey(a, b);
        if (!existingEdgeKeySet.has(k)) {
          const eid = makeUniqueId(`__E_NET_${net.id}_1`, usedEdgeIds);
          connections.push({
            id: eid,
            from: a,
            to: b,
            domain: net.domain,
            netId: net.id,
          });
          existingEdgeKeySet.add(k);
        }
        continue;
      }

      // For N >= 3 endpoints, build a daisy-chain of (N - 2) 3-gate T-junctions:
      // J_0: port 1 = ep[0], port 3 = ep[1], port 2 -> J_1.1
      // J_k: port 1 = J_{k-1}.2, port 3 = ep[k+1], port 2 -> J_{k+1}.1 (or ep[N-1] for last)
      const junctionType = net.domain === 'pneumatic' ? 'pneumatic_junction' : 'electrical_junction';
      const numJ = allEndpoints.length - 2;
      const jIds: string[] = [];
      for (let i = 0; i < numJ; i++) {
        const jId = makeUniqueId(`__NETJ_${net.id}_${i + 1}`, usedCompIds);
        syntheticComponentIds.add(jId);
        jIds.push(jId);
        components.push({
          id: jId,
          type: junctionType,
          params: {},
          rawMetadata: { _syntheticNetJunction: true, _netId: net.id, _netName: net.name ?? net.id, _netTapIndex: i },
        });
      }

      const addNetEdge = (from: PortRef, to: PortRef, idx: number): void => {
        const k = edgeKey(from, to);
        if (existingEdgeKeySet.has(k)) return;
        const eid = makeUniqueId(`__E_NET_${net.id}_${idx}`, usedEdgeIds);
        connections.push({
          id: eid,
          from,
          to,
          domain: net.domain,
          netId: net.id,
        });
        existingEdgeKeySet.add(k);
      };

      let eCounter = 1;
      // First endpoint into J_0:1
      addNetEdge(allEndpoints[0], { componentId: jIds[0], port: '1' }, eCounter++);
      // Middle endpoints into J_i:3
      for (let i = 0; i < numJ; i++) {
        addNetEdge(allEndpoints[i + 1], { componentId: jIds[i], port: '3' }, eCounter++);
        if (i < numJ - 1) {
          addNetEdge(
            { componentId: jIds[i], port: '2' },
            { componentId: jIds[i + 1], port: '1' },
            eCounter++,
          );
        }
      }
      // Final endpoint into J_{last}:2
      addNetEdge({ componentId: jIds[numJ - 1], port: '2' }, allEndpoints[allEndpoints.length - 1], eCounter++);
    }
  }

  const { nets: _materializedNets, ...docWithoutNets } = doc;
  const outDoc: CircuitDocument = {
    ...docWithoutNets,
    ...(!expandNets && _materializedNets ? { nets: _materializedNets } : {}),
    components,
    connections,
  };

  return {
    document: outDoc,
    inlineTerminators,
    syntheticComponentIds,
  };
}
