import type { CircuitDocument } from '../contracts/circuit';
import { buildPhase0CtGateError } from './ctParser';

export interface SerializeOptions {
  targetPath?: string;
  format?: 'fsim-ir-json' | 'fluidsim-4.5-ct';
}

/**
 * Serializes a CircuitDocument deterministically while preserving rawAst & rawMetadata.
 * Native FluidSIM 4.5 .ct emission is strictly gated until Phase 0 golden fixtures are verified.
 */
export function serializeCircuitDocument(
  document: CircuitDocument,
  options: SerializeOptions = {},
): Buffer {
  const targetPath = options.targetPath ?? '';
  const targetFormat =
    options.format ??
    (targetPath.toLowerCase().endsWith('.ct') ? 'fluidsim-4.5-ct' : 'fsim-ir-json');

  if (targetFormat === 'fluidsim-4.5-ct') {
    throw buildPhase0CtGateError(targetPath, 'serialize');
  }

  const canonical: CircuitDocument = {
    schemaVersion: '1.0',
    metadata: {
      ...document.metadata,
      fluidsimVersion: '4.5',
      format: 'fsim-ir-json',
    },
    components: document.components.map((c) => ({
      ...c,
      params: { ...c.params },
      ...(c.leftActuation ? { leftActuation: { ...c.leftActuation } } : {}),
      ...(c.rightActuation ? { rightActuation: { ...c.rightActuation } } : {}),
      ...(c.distanceRule ? { distanceRule: c.distanceRule.map((m) => ({ ...m })) } : {}),
      ...(c.layout ? { layout: { ...c.layout } } : {}),
      ...(c.rawMetadata ? { rawMetadata: c.rawMetadata } : {}),
    })),
    connections: document.connections.map((e) => ({
      ...e,
      from: { ...e.from },
      to: { ...e.to },
      ...(e.waypoints ? { waypoints: e.waypoints.map((pt) => ({ ...pt })) } : {}),
      ...(e.rawMetadata ? { rawMetadata: e.rawMetadata } : {}),
    })),
    ...(document.rawAst ? { rawAst: document.rawAst } : {}),
  };

  return Buffer.from(`${JSON.stringify(canonical, null, 2)}\n`, 'utf8');
}
