import type { McpToolContext } from './context';
import {
  checkCatalogIntegrity,
  PNEUMATICS_45_CATALOG,
  searchCatalog,
  type CatalogSearchFilter,
} from '../../catalog/pneumatics45';
import { paginateWithBudget } from '../../contracts/pagination';
import { getGoldenFixtureStatus } from '../../codec/ctDetector';
import { parseCircuitBuffer } from '../../codec/ctParser';
import { serializeCircuitDocument } from '../../codec/ctSerializer';
import { verifyCodecRoundtrip } from '../../codec/ctRoundtripGuard';
import { validateCircuitStatic } from '../../simulator/validator';
import { generateCircuitFromSpec } from '../../authoring/specGenerator';

export function handleWorkspaceStatus(
  ctx: McpToolContext,
  args: { cursor?: string; limit?: number; maxBytes?: number },
) {
  const files = ctx.guard.listCircuitFiles();
  const entries = files.map((filePath) => {
    try {
      const buf = ctx.guard.readFileBuffer(filePath);
      const { document, format } = parseCircuitBuffer(buf, filePath);
      const val = validateCircuitStatic(document);
      return {
        path: filePath,
        format,
        components: document.components.length,
        connections: document.connections.length,
        health: val.valid ? 'healthy' : 'errors',
        errorCount: val.errorCount,
        warningCount: val.warningCount,
      };
    } catch (err) {
      return {
        path: filePath,
        format: filePath.toLowerCase().endsWith('.ct') ? 'fluidsim-4.5-ct' : 'unknown',
        components: 0,
        connections: 0,
        health: 'unreadable',
        errorCount: 1,
        warningCount: 0,
        note: err instanceof Error ? err.message : String(err),
      };
    }
  });

  const paged = paginateWithBudget(
    entries,
    { cursor: args.cursor, limit: args.limit, maxBytes: args.maxBytes },
    ctx.maxPayloadBytes,
  );

  return {
    workspaceRoot: ctx.guard.root,
    accessMode: ctx.accessMode,
    serverVersion: ctx.serverVersion,
    catalogCount: PNEUMATICS_45_CATALOG.length,
    goldenFixtures: getGoldenFixtureStatus(ctx.repoRoot),
    files: paged.items,
    page: paged.page,
  };
}

export function handleCatalogSearch(
  ctx: McpToolContext,
  args: CatalogSearchFilter & { cursor?: string; limit?: number; maxBytes?: number },
) {
  const matches = searchCatalog({
    query: args.query,
    category: args.category,
    domain: args.domain,
    portCount: args.portCount,
    actuationType: args.actuationType,
  }).map((def) => ({
    componentType: def.type,
    displayName: def.displayName,
    category: def.category,
    domain: def.domain,
    description: def.description,
    ports: def.ports.map((p) => ({ name: p.name, domain: p.domain, role: p.role, required: p.required })),
    parameters: def.parameters.map((p) => ({
      key: p.key,
      type: p.type,
      defaultValue: p.defaultValue,
      ...(p.unit ? { unit: p.unit } : {}),
      ...(p.enumValues ? { enumValues: p.enumValues } : {}),
    })),
    supportsDistanceRule: def.supportsDistanceRule ?? false,
    supportsActuationConfig: def.supportsActuationConfig ?? false,
    fluidsim45IdVerified: def.fluidsim45IdVerified,
  }));

  const paged = paginateWithBudget(
    matches,
    { cursor: args.cursor, limit: args.limit, maxBytes: args.maxBytes },
    ctx.maxPayloadBytes,
  );

  return {
    components: paged.items,
    page: paged.page,
  };
}

export function handleFluidsimDoctor(ctx: McpToolContext) {
  const catalogCheck = checkCatalogIntegrity();
  const verifiedCatalogCount = PNEUMATICS_45_CATALOG.filter((c) => c.fluidsim45IdVerified).length;
  const goldenStatus = getGoldenFixtureStatus(ctx.repoRoot);
  const workspaceWritable = ctx.guard.checkWritable();

  // Headless codec & validator self-test in memory (both .fsim.json and native .ct)
  let irJsonSelfTestPassed = false;
  let nativeCtSelfTestPassed = false;
  let codecError: string | undefined;
  try {
    const sampleDoc = generateCircuitFromSpec({
      title: 'Doctor Self-Test',
      actuators: [{ label: 'A', strokeMm: 100 }],
      sequence: ['A+', 'A-'],
      controlMethod: 'electro-pneumatic-step-chain',
      startMode: 'single-cycle',
      includeEStop: false,
    });
    const val = validateCircuitStatic(sampleDoc);

    const irBytes = serializeCircuitDocument(sampleDoc, { format: 'fsim-ir-json' });
    const irRt = verifyCodecRoundtrip(sampleDoc, irBytes, 'doctor_selftest.fsim.json');
    irJsonSelfTestPassed = irRt.passed && val.valid;

    const ctBytes = serializeCircuitDocument(sampleDoc, { format: 'fluidsim-4.5-ct' });
    const ctRt = verifyCodecRoundtrip(sampleDoc, ctBytes, 'doctor_selftest.ct');
    nativeCtSelfTestPassed = ctRt.passed && val.valid;
  } catch (err) {
    codecError = err instanceof Error ? err.message : String(err);
  }

  return {
    status: catalogCheck.ok && irJsonSelfTestPassed && nativeCtSelfTestPassed ? 'ok' : 'degraded',
    serverVersion: ctx.serverVersion,
    nodeVersion: process.version,
    platform: process.platform,
    accessMode: ctx.accessMode,
    workspace: {
      root: ctx.guard.root,
      writable: workspaceWritable,
    },
    catalog: {
      ...catalogCheck,
      verifiedFluidsim45Count: verifiedCatalogCount,
    },
    codec: {
      irJsonRoundtripOk: irJsonSelfTestPassed,
      nativeCt45RoundtripOk: nativeCtSelfTestPassed,
      nativeCt45Ready: goldenStatus.readyForPhase1 && nativeCtSelfTestPassed,
      goldenFixturesPresent: goldenStatus.present,
      goldenFixturesMissing: goldenStatus.missing,
      ...(codecError ? { error: codecError } : {}),
    },
  };
}
