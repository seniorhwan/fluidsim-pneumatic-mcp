import type { McpToolContext } from './context';
import { loadCircuitFromWorkspace } from './context';
import { getCatalogComponent } from '../../catalog/pneumatics45';
import { validateCircuitStatic } from '../../simulator/validator';
import { collectCtVisualFindings } from '../../authoring/postconditionVerifier';
import { renderCircuitToSvg } from '../../codec/ctSvgRenderer';
import { assertPayloadBudget, paginateWithBudget } from '../../contracts/pagination';
import type { ComponentCategory, Domain } from '../../contracts/catalog';

export function handleCircuitInspect(ctx: McpToolContext, args: { path: string }) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const validation = validateCircuitStatic(document);
  const rawBytes = ctx.guard.readFileBuffer(relativePath);
  const visual = collectCtVisualFindings(
    rawBytes,
    document.metadata.sheetWidthMm,
    document.metadata.sheetHeightMm,
  );

  const countsByCategory: Record<string, number> = {};
  const actuators: Array<{
    id: string;
    label?: string;
    type: string;
    strokeMm: number;
    distanceRule: Array<{ label: string; positionMm: number }>;
  }> = [];
  const valves: Array<{
    id: string;
    label?: string;
    type: string;
    rotationDeg?: number;
    mirror?: string;
    sectionLabel?: string;
    group?: string;
    portTerminators?: Record<string, string>;
    leftActuation?: string;
    rightActuation?: string;
  }> = [];
  const detectedInputs: Array<{
    id: string;
    label: string;
    type: string;
    detent: boolean;
  }> = [];
  let electricalLoadCount = 0;

  for (const c of document.components) {
    const def = getCatalogComponent(c.type);
    const cat = def?.category ?? 'unknown';
    countsByCategory[cat] = (countsByCategory[cat] ?? 0) + 1;

    if (cat === 'actuator') {
      actuators.push({
        id: c.id,
        label: c.label,
        type: c.type,
        strokeMm:
          c.type === 'swivel_drive'
            ? typeof c.params.maxAngleDeg === 'number'
              ? c.params.maxAngleDeg
              : 180
            : typeof c.params.strokeMm === 'number'
              ? c.params.strokeMm
              : 100,
        distanceRule: (c.distanceRule ?? []).map((m) => ({ label: m.label, positionMm: m.positionMm })),
      });
    } else if (cat === 'directional_valve') {
      valves.push({
        id: c.id,
        label: c.label,
        type: c.type,
        ...(c.rotationDeg !== undefined ? { rotationDeg: c.rotationDeg } : {}),
        ...(c.mirror && c.mirror !== 'none' ? { mirror: c.mirror } : {}),
        ...(c.sectionLabel ? { sectionLabel: c.sectionLabel } : {}),
        ...(c.group ? { group: c.group } : {}),
        ...(c.portTerminators ? { portTerminators: c.portTerminators } : {}),
        leftActuation: c.leftActuation
          ? `${c.leftActuation.type}${c.leftActuation.label ? `(${c.leftActuation.label})` : ''}`
          : undefined,
        rightActuation: c.rightActuation
          ? `${c.rightActuation.type}${c.rightActuation.label ? `(${c.rightActuation.label})` : ''}`
          : undefined,
      });
      if (
        c.leftActuation?.type === 'pushbutton' ||
        c.leftActuation?.type === 'detent' ||
        c.rightActuation?.type === 'pushbutton' ||
        c.rightActuation?.type === 'detent'
      ) {
        const isDetent = c.leftActuation?.type === 'detent' || c.rightActuation?.type === 'detent';
        detectedInputs.push({
          id: c.id,
          label: c.label ?? c.leftActuation?.label ?? c.rightActuation?.label ?? c.id,
          type: c.type,
          detent: isDetent,
        });
      }
    } else if (c.type === 'pushbutton_no' || c.type === 'pushbutton_nc') {
      detectedInputs.push({
        id: c.id,
        label: c.label ?? c.id,
        type: c.type,
        detent: c.params.detent === true,
      });
    } else if (
      c.type === 'relay_coil' ||
      c.type === 'timer_relay_on_delay' ||
      c.type === 'timer_relay_off_delay' ||
      c.type === 'electrical_counter' ||
      c.type === 'valve_solenoid' ||
      c.type === 'indicator_lamp'
    ) {
      electricalLoadCount++;
    }
  }

  return {
    path: relativePath,
    title: document.metadata.title,
    format: document.metadata.format,
    sheetWidthMm: document.metadata.sheetWidthMm,
    sheetHeightMm: document.metadata.sheetHeightMm,
    componentCount: document.components.length,
    connectionCount: document.connections.length,
    ...(document.nets && document.nets.length > 0 ? { netCount: document.nets.length } : {}),
    countsByCategory,
    actuators,
    valves,
    detectedInputs,
    electricalRungCount: electricalLoadCount,
    validationSummary: {
      valid: validation.valid && visual.f9SolverOk,
      f9SolverOk: visual.f9SolverOk,
      visualLayoutOk: visual.ok,
      errorCount: validation.errorCount + visual.findings.filter((f) => f.severity === 'error').length,
      warningCount: validation.warningCount + visual.findings.filter((f) => f.severity === 'warning').length,
    },
  };
}

export function handleCircuitExportNetlist(
  ctx: McpToolContext,
  args: { path: string; format?: 'json' | 'compact-text'; maxBytes?: number },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const format = args.format ?? 'compact-text';
  const budget = Math.min(ctx.maxPayloadBytes, args.maxBytes ?? ctx.maxPayloadBytes);

  if (format === 'compact-text') {
    const lines: string[] = [];
    lines.push(`# CIRCUIT ${document.metadata.title} (${relativePath})`);
    lines.push('COMPONENTS:');
    for (const c of document.components) {
      const bits: string[] = [`${c.id}:${c.type}`];
      if (c.label) bits.push(`label=${c.label}`);
      if (c.rotationDeg) bits.push(`rot=${c.rotationDeg}`);
      if (c.mirror && c.mirror !== 'none') bits.push(`mirror=${c.mirror}`);
      if (c.sectionLabel) bits.push(`section="${c.sectionLabel}"`);
      if (c.group) bits.push(`group=${c.group}`);
      if (c.portTerminators && Object.keys(c.portTerminators).length > 0) {
        const terms = Object.entries(c.portTerminators)
          .map(([p, t]) => `${p}:${t}`)
          .join(',');
        bits.push(`terms=[${terms}]`);
      }
      if (c.leftActuation) {
        bits.push(`L=${c.leftActuation.type}${c.leftActuation.label ? `(${c.leftActuation.label})` : ''}`);
      }
      if (c.rightActuation) {
        bits.push(`R=${c.rightActuation.type}${c.rightActuation.label ? `(${c.rightActuation.label})` : ''}`);
      }
      if (c.distanceRule && c.distanceRule.length > 0) {
        bits.push(`markers=[${c.distanceRule.map((m) => `${m.label}@${m.positionMm}`).join(',')}]`);
      }
      lines.push(`  ${bits.join(' ')}`);
    }
    lines.push('CONNECTIONS:');
    for (const e of document.connections) {
      lines.push(`  ${e.id}[${e.domain[0].toUpperCase()}]: ${e.from.componentId}.${e.from.port} -- ${e.to.componentId}.${e.to.port}`);
    }
    if (document.nets && document.nets.length > 0) {
      lines.push('NETS:');
      for (const n of document.nets) {
        lines.push(`  ${n.id}${n.name ? `(${n.name})` : ''}: ${n.endpoints.map((p) => `${p.componentId}.${p.port}`).join(' -- ')}`);
      }
    }
    const payload = {
      path: relativePath,
      format: 'compact-text' as const,
      netlist: lines.join('\n'),
    };
    assertPayloadBudget(payload, budget, 'circuit_export_netlist');
    return payload;
  }

  const payload = {
    path: relativePath,
    format: 'json' as const,
    components: document.components.map((c) => ({
      id: c.id,
      type: c.type,
      ...(c.label ? { label: c.label } : {}),
      ...(c.rotationDeg !== undefined ? { rotationDeg: c.rotationDeg } : {}),
      ...(c.mirror && c.mirror !== 'none' ? { mirror: c.mirror } : {}),
      ...(c.flipped !== undefined ? { flipped: c.flipped } : {}),
      ...(c.sectionLabel ? { sectionLabel: c.sectionLabel } : {}),
      ...(c.group ? { group: c.group } : {}),
      ...(c.portTerminators ? { portTerminators: c.portTerminators } : {}),
      ...(c.layout ? { layout: c.layout } : {}),
      params: c.params,
      ...(c.leftActuation ? { leftActuation: c.leftActuation } : {}),
      ...(c.rightActuation ? { rightActuation: c.rightActuation } : {}),
      ...(c.distanceRule ? { distanceRule: c.distanceRule } : {}),
    })),
    connections: document.connections.map((e) => ({
      id: e.id,
      domain: e.domain,
      from: `${e.from.componentId}.${e.from.port}`,
      to: `${e.to.componentId}.${e.to.port}`,
    })),
    ...(document.nets && document.nets.length > 0 ? { nets: document.nets } : {}),
  };
  assertPayloadBudget(payload, budget, 'circuit_export_netlist');
  return payload;
}

export function handleCircuitGetLabelMap(ctx: McpToolContext, args: { path: string }) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);

  const distanceRules: Record<string, { cylinderId: string; positionMm: number; boundSwitches: string[] }> = {};
  const coils: Record<string, { coilIds: string[]; boundContacts: string[] }> = {};
  const solenoids: Record<string, { solenoidIds: string[]; boundValves: string[] }> = {};
  const brokenBindings: Array<{ kind: string; componentId: string; label: string; reason: string }> = [];

  for (const c of document.components) {
    if (c.distanceRule) {
      for (const m of c.distanceRule) {
        if (distanceRules[m.label]) {
          brokenBindings.push({
            kind: 'duplicate_distance_rule',
            componentId: c.id,
            label: m.label,
            reason: `Marker "${m.label}" already defined on ${distanceRules[m.label].cylinderId}`,
          });
        } else {
          distanceRules[m.label] = {
            cylinderId: c.id,
            positionMm: m.positionMm,
            boundSwitches: [],
          };
        }
      }
    }

    if (
      c.type === 'relay_coil' ||
      c.type === 'timer_relay_on_delay' ||
      c.type === 'timer_relay_off_delay' ||
      c.type === 'electrical_counter'
    ) {
      if (c.label) {
        if (!coils[c.label]) coils[c.label] = { coilIds: [], boundContacts: [] };
        coils[c.label].coilIds.push(c.id);
        if (coils[c.label].coilIds.length > 1) {
          brokenBindings.push({
            kind: 'duplicate_coil',
            componentId: c.id,
            label: c.label,
            reason: `Coil label "${c.label}" duplicated on ${coils[c.label].coilIds.join(', ')}`,
          });
        }
      }
    }

    if (c.type === 'valve_solenoid' && c.label) {
      if (!solenoids[c.label]) solenoids[c.label] = { solenoidIds: [], boundValves: [] };
      solenoids[c.label].solenoidIds.push(c.id);
    }
  }

  for (const c of document.components) {
    if (
      c.type === 'limit_switch_no' ||
      c.type === 'limit_switch_nc' ||
      c.type === 'proximity_switch_magnetic'
    ) {
      if (c.label && distanceRules[c.label]) {
        distanceRules[c.label].boundSwitches.push(c.id);
      } else {
        brokenBindings.push({
          kind: 'orphaned_sensor',
          componentId: c.id,
          label: c.label ?? '<none>',
          reason: `No cylinder distanceRule defines "${c.label ?? '<none>'}"`,
        });
      }
    }

    for (const side of [c.leftActuation, c.rightActuation]) {
      if (!side) continue;
      if (side.type === 'roller' || side.type === 'idle_return_roller') {
        if (side.label && distanceRules[side.label]) {
          distanceRules[side.label].boundSwitches.push(c.id);
        } else {
          brokenBindings.push({
            kind: 'orphaned_roller',
            componentId: c.id,
            label: side.label ?? '<none>',
            reason: `Roller on ${c.id} references missing distanceRule "${side.label ?? '<none>'}"`,
          });
        }
      } else if (side.type === 'solenoid') {
        if (side.label) {
          if (!solenoids[side.label]) {
            solenoids[side.label] = { solenoidIds: [], boundValves: [] };
          }
          solenoids[side.label].boundValves.push(c.id);
        }
      }
    }

    if (
      c.type === 'relay_contact_no' ||
      c.type === 'relay_contact_nc' ||
      c.type === 'relay_contact_changeover'
    ) {
      if (c.label && coils[c.label]) {
        coils[c.label].boundContacts.push(c.id);
      } else {
        brokenBindings.push({
          kind: 'orphaned_contact',
          componentId: c.id,
          label: c.label ?? '<none>',
          reason: `No relay/timer/counter coil defines "${c.label ?? '<none>'}"`,
        });
      }
    }
  }

  const allowExternalElec =
    document.metadata.allowExternalElectricalSheet === true ||
    document.metadata.sheetDomain === 'pneumatic-only';

  for (const [label, entry] of Object.entries(solenoids)) {
    if (entry.solenoidIds.length === 0 && !allowExternalElec) {
      brokenBindings.push({
        kind: 'unbound_valve_solenoid',
        componentId: entry.boundValves[0] ?? label,
        label,
        reason: `Valve pilot references solenoid "${label}" without a matching electrical valve_solenoid.`,
      });
    } else if (entry.boundValves.length === 0) {
      brokenBindings.push({
        kind: 'orphaned_solenoid',
        componentId: entry.solenoidIds[0],
        label,
        reason: `Electrical solenoid "${label}" has no matching valve pilot.`,
      });
    }
  }

  return {
    path: relativePath,
    distanceRules,
    coils,
    solenoids,
    brokenBindings,
  };
}

export function handleCircuitQueryComponents(
  ctx: McpToolContext,
  args: {
    path: string;
    domain?: Domain;
    category?: ComponentCategory;
    label?: string;
    type?: string;
    cursor?: string;
    limit?: number;
    maxBytes?: number;
  },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);

  const filtered = document.components
    .filter((c) => {
      const def = getCatalogComponent(c.type);
      if (args.domain && def?.domain !== args.domain) return false;
      if (args.category && def?.category !== args.category) return false;
      if (args.label && c.label !== args.label) return false;
      if (args.type && c.type !== args.type) return false;
      return true;
    })
    .map((c) => {
      const neighbors = document.connections
        .filter((e) => e.from.componentId === c.id || e.to.componentId === c.id)
        .map((e) => {
          const isFrom = e.from.componentId === c.id;
          return {
            edgeId: e.id,
            localPort: isFrom ? e.from.port : e.to.port,
            remoteComponentId: isFrom ? e.to.componentId : e.from.componentId,
            remotePort: isFrom ? e.to.port : e.from.port,
          };
        });
      return {
        id: c.id,
        type: c.type,
        ...(c.label ? { label: c.label } : {}),
        ...(c.rotationDeg !== undefined ? { rotationDeg: c.rotationDeg } : {}),
        ...(c.mirror && c.mirror !== 'none' ? { mirror: c.mirror } : {}),
        ...(c.flipped !== undefined ? { flipped: c.flipped } : {}),
        ...(c.sectionLabel ? { sectionLabel: c.sectionLabel } : {}),
        ...(c.group ? { group: c.group } : {}),
        ...(c.portTerminators ? { portTerminators: c.portTerminators } : {}),
        ...(c.layout ? { layout: c.layout } : {}),
        params: c.params,
        ...(c.leftActuation ? { leftActuation: c.leftActuation } : {}),
        ...(c.rightActuation ? { rightActuation: c.rightActuation } : {}),
        ...(c.distanceRule ? { distanceRule: c.distanceRule } : {}),
        neighbors,
      };
    });

  const paged = paginateWithBudget(
    filtered,
    { cursor: args.cursor, limit: args.limit, maxBytes: args.maxBytes },
    ctx.maxPayloadBytes,
  );

  return {
    path: relativePath,
    components: paged.items,
    page: paged.page,
  };
}

export function handleCircuitRenderSvg(
  ctx: McpToolContext,
  args: {
    path: string;
    includeSvg?: boolean;
    showGrid?: boolean;
    scalePxPerMm?: number;
    maxBytes?: number;
  },
) {
  const { document, relativePath } = loadCircuitFromWorkspace(ctx, args.path);
  const rawBytes = ctx.guard.readFileBuffer(relativePath);
  const ctVisual = collectCtVisualFindings(
    rawBytes,
    document.metadata.sheetWidthMm,
    document.metadata.sheetHeightMm,
  );
  const rendered = renderCircuitToSvg(document, {
    scalePxPerMm: args.scalePxPerMm ?? 3,
    showGrid: args.showGrid ?? false,
  });

  const includeSvg = args.includeSvg !== false;
  const payload = {
    path: relativePath,
    widthMm: rendered.widthMm,
    heightMm: rendered.heightMm,
    diagnostics: {
      ...rendered.diagnostics,
      f9SolverOk: ctVisual.f9SolverOk,
      ctVisualOk: ctVisual.ok,
    },
    ...(includeSvg ? { svg: rendered.svg } : {}),
  };

  const budget = Math.min(Math.max(ctx.maxPayloadBytes, 131_072), args.maxBytes ?? 131_072);
  assertPayloadBudget(payload, budget, 'circuit_render_svg');
  return payload;
}
