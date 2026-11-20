import type { CircuitDocument, ComponentNode, ConnectionEdge } from '../contracts/circuit';
import { EngineeringError } from '../contracts/errors';
import { detectCircuitFormat } from './ctDetector';
import { decodeCtContainer } from './ctBinaryCodec';
import { parseCtContainerToDocument } from './ctTextCodec';

export interface ParseCircuitResult {
  document: CircuitDocument;
  format: 'fsim-ir-json' | 'fluidsim-4.5-ct';
}

function validateParsedDocument(raw: unknown, filePath: string): CircuitDocument {
  if (!raw || typeof raw !== 'object') {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'INVALID_CIRCUIT_DOCUMENT',
      message: `Circuit file "${filePath}" does not contain a JSON object.`,
      offendingIds: [filePath],
      suggestedFix: 'Ensure the file is a valid CircuitDocument object.',
    });
  }

  const doc = raw as Partial<CircuitDocument>;
  if (doc.schemaVersion !== '1.0') {
    throw new EngineeringError({
      category: 'UnsupportedFormatVersion',
      code: 'UNSUPPORTED_IR_SCHEMA',
      message: `Unsupported circuit IR schemaVersion "${String(doc.schemaVersion)}". Expected "1.0".`,
      offendingIds: [filePath],
      suggestedFix: 'Migrate the circuit file to schemaVersion "1.0".',
    });
  }

  if (!doc.metadata || !Array.isArray(doc.components) || !Array.isArray(doc.connections)) {
    throw new EngineeringError({
      category: 'ParseError',
      code: 'MISSING_DOCUMENT_SECTIONS',
      message: `Circuit file "${filePath}" is missing required fields (metadata, components, connections).`,
      offendingIds: [filePath],
      suggestedFix: 'Recreate the file via circuit_create or restore required top-level arrays.',
    });
  }

  const components: ComponentNode[] = doc.components.map((c, idx) => {
    if (!c || typeof c.id !== 'string' || typeof c.type !== 'string') {
      throw new EngineeringError({
        category: 'ParseError',
        code: 'INVALID_COMPONENT_ENTRY',
        message: `Component at index ${idx} in "${filePath}" is missing string id or type.`,
        offendingIds: [filePath],
        suggestedFix: 'Ensure every component has string "id" and valid catalog "type".',
      });
    }
    return {
      ...c,
      params: c.params && typeof c.params === 'object' ? { ...c.params } : {},
    };
  });

  const connections: ConnectionEdge[] = doc.connections.map((e, idx) => {
    if (!e || typeof e.id !== 'string' || !e.from || !e.to) {
      throw new EngineeringError({
        category: 'ParseError',
        code: 'INVALID_CONNECTION_ENTRY',
        message: `Connection at index ${idx} in "${filePath}" is missing id, from, or to.`,
        offendingIds: [filePath],
        suggestedFix: 'Ensure every connection has string id, from {componentId, port}, and to {componentId, port}.',
      });
    }
    return {
      ...e,
      from: { componentId: String(e.from.componentId), port: String(e.from.port) },
      to: { componentId: String(e.to.componentId), port: String(e.to.port) },
    };
  });

  return {
    schemaVersion: '1.0',
    metadata: {
      title: String(doc.metadata.title ?? 'Untitled Circuit'),
      fluidsimVersion: '4.5',
      format: doc.metadata.format === 'fluidsim-4.5-ct' ? 'fluidsim-4.5-ct' : 'fsim-ir-json',
      sheetWidthMm: typeof doc.metadata.sheetWidthMm === 'number' ? doc.metadata.sheetWidthMm : 297,
      sheetHeightMm: typeof doc.metadata.sheetHeightMm === 'number' ? doc.metadata.sheetHeightMm : 210,
      ...(doc.metadata.createdAt ? { createdAt: doc.metadata.createdAt } : {}),
      ...(doc.metadata.updatedAt ? { updatedAt: doc.metadata.updatedAt } : {}),
      ...(doc.metadata.notes ? { notes: doc.metadata.notes } : {}),
    },
    components,
    connections,
    ...(doc.rawAst ? { rawAst: doc.rawAst } : {}),
  };
}

export function parseCircuitBuffer(buffer: Buffer, filePath = ''): ParseCircuitResult {
  const detection = detectCircuitFormat(buffer, filePath);

  if (detection.format === 'fluidsim-4.5-ct') {
    const container = decodeCtContainer(buffer, filePath);
    const document = parseCtContainerToDocument(container, filePath);
    return { document, format: 'fluidsim-4.5-ct' };
  }

  if (detection.format === 'fsim-ir-json') {
    const raw = JSON.parse(buffer.toString('utf8')) as unknown;
    const document = validateParsedDocument(raw, filePath);
    return { document, format: 'fsim-ir-json' };
  }

  throw new EngineeringError({
    category: 'UnsupportedFormatVersion',
    code: 'UNSUPPORTED_FORMAT',
    message: `Unsupported format "${detection.format}" for "${filePath}".`,
    offendingIds: filePath ? [filePath] : [],
    suggestedFix: 'Use a Festo FluidSIM Pneumatics 4.5 .ct file or a .fsim.json IR file.',
  });
}
