import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { buildHostConfigSnippet } from '../../bin/fluidsim-mcp';
import { startHttpServer } from '../mcp/server';

const REPO_ROOT = process.cwd();
const NODE_BIN = process.execPath;
const TSX_CLI = path.resolve(REPO_ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');
const MCP_ENTRY = path.resolve(REPO_ROOT, 'bin', 'fluidsim-mcp.ts');

async function callJsonTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  assert.ok(content.length > 0 && content[0].type === 'text' && typeof content[0].text === 'string');
  return JSON.parse(content[0].text) as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
}

function assertGeminiCompliantSchema(toolName: string, schema: unknown, pointer = '$'): void {
  if (!schema || typeof schema !== 'object') return;
  if (Array.isArray(schema)) {
    schema.forEach((item, i) => assertGeminiCompliantSchema(toolName, item, `${pointer}[${i}]`));
    return;
  }
  const obj = schema as Record<string, unknown>;
  const forbidden = ['$schema', 'oneOf', 'anyOf', 'allOf', 'const', 'propertyNames', 'additionalProperties'];
  for (const kw of forbidden) {
    assert.equal(
      kw in obj,
      false,
      `Tool "${toolName}" contains Gemini-incompatible keyword "${kw}" at ${pointer}`,
    );
  }
  if ('type' in obj) {
    assert.equal(
      Array.isArray(obj.type),
      false,
      `Tool "${toolName}" has array "type" (${JSON.stringify(obj.type)}) at ${pointer}`,
    );
  }
  for (const [k, v] of Object.entries(obj)) {
    assertGeminiCompliantSchema(toolName, v, `${pointer}.${k}`);
  }
}

test('end-to-end stdio MCP server exercises full autonomous agent loop, lifecycle tools, and Gemini schema compliance', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-e2e-'));
  const transport = new StdioClientTransport({
    command: NODE_BIN,
    args: [TSX_CLI, MCP_ENTRY, 'serve', '--workspace', workspace, '--mode', 'authoring'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-agent-host', version: '1.0.0' });

  try {
    await client.connect(transport);

    // 1. Verify all 20 MCP tools are registered AND 100% Gemini/OpenAPI 3.0 schema compliant
    const listed = await client.listTools();
    const toolNames = new Set(listed.tools.map((t) => t.name));
    assert.equal(toolNames.size, 20);
    for (const expected of [
      'workspace_status',
      'catalog_search',
      'fluidsim_doctor',
      'circuit_inspect',
      'circuit_export_netlist',
      'circuit_get_label_map',
      'circuit_query_components',
      'circuit_render_svg',
      'project_create',
      'circuit_create',
      'circuit_build',
      'circuit_clone',
      'circuit_rename',
      'circuit_delete',
      'circuit_apply_patch',
      'circuit_generate_from_spec',
      'circuit_auto_layout',
      'circuit_validate',
      'circuit_simulate',
      'circuit_verify_sequence',
    ]) {
      assert.ok(toolNames.has(expected), `Missing registered MCP tool: ${expected}`);
    }
    for (const tool of listed.tools) {
      assertGeminiCompliantSchema(tool.name, tool.inputSchema);
    }

    // 2. Group A: doctor & catalog_search (including newly added components)
    const docRes = await callJsonTool(client, 'fluidsim_doctor');
    assert.equal(docRes.ok, true);
    assert.equal(docRes.data?.status, 'ok');

    const catRes = await callJsonTool(client, 'catalog_search', { query: 'vacuum' });
    assert.equal(catRes.ok, true);
    const catItems = catRes.data?.components as Array<{ componentType: string }>;
    assert.ok(catItems.some((c) => c.componentType === 'vacuum_suction_nozzle'));
    assert.ok(catItems.some((c) => c.componentType === 'vacuum_sucker'));

    // 3. Starter templates validate with 0 errors and 0 warnings out of the box
    const createRes = await callJsonTool(client, 'circuit_create', {
      path: 'manual.fsim.json',
      template: 'pneumatic_basic',
      title: 'Self-Heal Demo',
    });
    assert.equal(createRes.ok, true);
    const createVal = createRes.data?.validation as { valid: boolean; errorCount: number; warningCount: number };
    assert.equal(createVal.valid, true);
    assert.equal(createVal.errorCount, 0);
    assert.equal(createVal.warningCount, 0);

    const createElecRes = await callJsonTool(client, 'circuit_create', {
      path: 'elec_tpl.fsim.json',
      template: 'electro_pneumatic_24v',
      title: 'Clean Electro Template',
    });
    assert.equal(createElecRes.ok, true);
    const elecVal = createElecRes.data?.validation as { valid: boolean; errorCount: number; warningCount: number };
    assert.equal(elecVal.valid, true);
    assert.equal(elecVal.errorCount, 0);
    assert.equal(elecVal.warningCount, 0);

    // Project lifecycle tools: project_create (Part 2.2), circuit_clone (Part 2.4), circuit_rename, circuit_delete (confirm guard)
    const projRes = await callJsonTool(client, 'project_create', {
      projectDir: 'mps-station',
      name: 'MPS Distributing Station',
      description: 'Headless pneumatic station project',
      author: 'Automation Team',
      starterCircuit: 'pneumatic_basic',
      starterFileName: 'starter.ct',
      sheetSize: 'DIN_A3_LANDSCAPE',
    });
    assert.equal(projRes.ok, true, JSON.stringify(projRes));
    assert.equal(projRes.data?.projectDir, 'mps-station');
    assert.equal(projRes.data?.manifestPath, 'mps-station/fluidsim-project.json');
    assert.equal(projRes.data?.readmePath, 'mps-station/README.md');
    assert.equal(projRes.data?.starterCircuitPath, 'mps-station/circuits/starter.ct');
    assert.equal((projRes.data?.validation as { valid: boolean }).valid, true);
    assert.equal(fs.existsSync(path.join(workspace, 'mps-station', 'fluidsim-project.json')), true);
    assert.equal(fs.existsSync(path.join(workspace, 'mps-station', 'README.md')), true);
    assert.equal(fs.existsSync(path.join(workspace, 'mps-station', 'circuits', 'starter.ct')), true);

    const cloneRes = await callJsonTool(client, 'circuit_clone', {
      sourcePath: 'elec_tpl.fsim.json',
      targetPath: 'mps-station/circuits/cloned.ct',
      newTitle: 'Cloned Electro Template',
    });
    assert.equal(cloneRes.ok, true, JSON.stringify(cloneRes));
    assert.equal(cloneRes.data?.title, 'Cloned Electro Template');

    const renameRes = await callJsonTool(client, 'circuit_rename', {
      fromPath: 'mps-station/circuits/cloned.ct',
      toPath: 'mps-station/circuits/renamed.ct',
    });
    assert.equal(renameRes.ok, true);

    // circuit_delete requires confirm: true
    const delBlocked = await callJsonTool(client, 'circuit_delete', {
      path: 'mps-station/circuits/renamed.ct',
      confirm: false,
    });
    assert.equal(delBlocked.ok, false);
    assert.equal(delBlocked.error?.code, 'DELETE_CONFIRMATION_REQUIRED');

    const delRes = await callJsonTool(client, 'circuit_delete', {
      path: 'mps-station/circuits/renamed.ct',
      confirm: true,
    });
    assert.equal(delRes.ok, true);
    const delElecRes = await callJsonTool(client, 'circuit_delete', {
      path: 'elec_tpl.fsim.json',
      confirm: true,
    });
    assert.equal(delElecRes.ok, true);
    const delStarterRes = await callJsonTool(client, 'circuit_delete', {
      path: 'mps-station/circuits/starter.ct',
      confirm: true,
    });
    assert.equal(delStarterRes.ok, true);

    // 4. Autonomous self-healing loop using Gemini-safe paramsJson & paramsList
    const badPatch = await callJsonTool(client, 'circuit_apply_patch', {
      path: 'manual.fsim.json',
      operations: [
        {
          op: 'add_component',
          component: {
            id: 'V1',
            type: 'valve_3_2',
            label: 'S1',
            paramsJson: '{"normalState":"NC"}',
            leftActuation: { type: 'pushbutton', label: 'S1' },
            rightActuation: { type: 'spring' },
          },
        },
        {
          op: 'add_component',
          component: {
            id: 'C1',
            type: 'cylinder_single_acting',
            label: 'A',
            paramsList: [{ key: 'strokeMm', valueNumber: 50 }],
          },
        },
        { op: 'connect', from: { componentId: 'MANIFOLD_1', port: '2' }, to: { componentId: 'V1', port: '1' } },
        { op: 'connect', from: { componentId: 'V1', port: '2' }, to: { componentId: 'C1', port: 'A' } },
      ],
    });
    assert.equal(badPatch.ok, true);
    const val1 = await callJsonTool(client, 'circuit_validate', { path: 'manual.fsim.json' });
    assert.equal(val1.ok, true);
    assert.equal(val1.data?.valid, false);
    const findings1 = val1.data?.findings as Array<{ code: string; suggestedFix: string }>;
    assert.ok(findings1.some((f) => f.code === 'MISSING_EXHAUST_TERMINATOR'));

    // Apply corrective fix guided by diagnostic
    const fixPatch = await callJsonTool(client, 'circuit_apply_patch', {
      path: 'manual.fsim.json',
      operations: [
        { op: 'add_component', component: { id: 'EX1', type: 'exhaust_silencer' } },
        { op: 'connect', from: { componentId: 'V1', port: '3' }, to: { componentId: 'EX1', port: '1' } },
      ],
    });
    assert.equal(fixPatch.ok, true);
    const val2 = await callJsonTool(client, 'circuit_validate', { path: 'manual.fsim.json' });
    assert.equal(val2.data?.valid, true);

    const simManual = await callJsonTool(client, 'circuit_simulate', {
      path: 'manual.fsim.json',
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 600 }],
      durationMs: 1800,
    });
    assert.equal(simManual.ok, true);
    assert.deepEqual(simManual.data?.observedSequence, ['A+', 'A-']);

    // 5. One-shot declarative generator directly to native FluidSIM 4.5 .ct + read tools + auto-layout + verify_sequence
    const genRes = await callJsonTool(client, 'circuit_generate_from_spec', {
      path: 'seq_abba.ct',
      actuators: [{ label: 'A', strokeMm: 100 }, { label: 'B', strokeMm: 100 }],
      sequence: ['A+', 'B+', 'B-', 'A-'],
      controlMethod: 'electro-pneumatic-step-chain',
      startMode: 'single-cycle',
      includeEStop: true,
    });
    assert.equal(genRes.ok, true);
    assert.equal((genRes.data?.validation as { valid: boolean }).valid, true);
    assert.equal((genRes.data?.sequenceVerification as { passed: boolean }).passed, true);

    // Copy a real golden FluidSIM .ct fixture into the workspace and inspect it via MCP
    fs.copyFileSync(
      path.resolve(REPO_ROOT, 'fixtures', 'golden', '04_electro_pneumatic_abba.ct'),
      path.join(workspace, 'golden_electro.ct'),
    );
    const goldenInspect = await callJsonTool(client, 'circuit_inspect', { path: 'golden_electro.ct' });
    assert.equal(goldenInspect.ok, true);
    assert.equal((goldenInspect.data?.actuators as unknown[]).length, 2);

    const inspectRes = await callJsonTool(client, 'circuit_inspect', { path: 'seq_abba.ct' });
    assert.equal(inspectRes.ok, true);
    assert.equal((inspectRes.data?.actuators as unknown[]).length, 2);

    const netRes = await callJsonTool(client, 'circuit_export_netlist', {
      path: 'seq_abba.ct',
      format: 'compact-text',
    });
    assert.equal(netRes.ok, true);
    assert.ok(String(netRes.data?.netlist).includes('COMPONENTS:'));

    const mapRes = await callJsonTool(client, 'circuit_get_label_map', { path: 'seq_abba.ct' });
    assert.equal(mapRes.ok, true);
    assert.equal((mapRes.data?.brokenBindings as unknown[]).length, 0);

    const queryRes = await callJsonTool(client, 'circuit_query_components', {
      path: 'seq_abba.ct',
      category: 'directional_valve',
    });
    assert.equal(queryRes.ok, true);
    assert.ok((queryRes.data?.components as unknown[]).length >= 2);

    const layoutRes = await callJsonTool(client, 'circuit_auto_layout', { path: 'seq_abba.ct' });
    assert.equal(layoutRes.ok, true);
    assert.equal(layoutRes.data?.postconditionPassed, true);

    const verifyRes = await callJsonTool(client, 'circuit_verify_sequence', {
      path: 'seq_abba.ct',
      expectedSequence: ['A+', 'B+', 'B-', 'A-'],
      inputs: [{ label: 'S1', action: 'press', atMs: 100, durationMs: 150 }],
      durationMs: 6000,
    });
    assert.equal(verifyRes.ok, true);
    assert.equal(verifyRes.data?.passed, true);

    // 6. Create blank native .ct and patch from scratch (verifies ROUNDTRIP_RAW_AST_LOST regression is fixed)
    const blankCtRes = await callJsonTool(client, 'circuit_create', {
      path: 'fresh_patch.ct',
      template: 'blank',
      title: 'Blank CT Patch E2E',
      sheetSize: 'DIN_A3_LANDSCAPE',
      sheetDomain: 'pneumatic-only',
      allowExternalElectricalSheet: true,
    });
    assert.equal(blankCtRes.ok, true);

    const patchCtRes = await callJsonTool(client, 'circuit_apply_patch', {
      path: 'fresh_patch.ct',
      operations: [
        { op: 'add_component', component: { id: 'S', type: 'air_source', params: { pressureBar: 6 } } },
        { op: 'add_component', component: { id: 'F', type: 'air_service_unit', label: '-0Z1', params: { nominalPressureBar: 6 } } },
        {
          op: 'add_component',
          component: {
            id: 'V',
            type: 'valve_5_2',
            label: '-1V1',
            leftActuation: { type: 'solenoid', label: '-1M1', manualOverride: true, internalPilot: true },
            rightActuation: { type: 'pneumatic_spring', springReturn: true },
          },
        },
        { op: 'add_component', component: { id: 'EX3', type: 'exhaust_silencer' } },
        { op: 'add_component', component: { id: 'EX5', type: 'exhaust_silencer' } },
        { op: 'add_component', component: { id: 'TH', type: 'flow_control_one_way', label: '-1V2', rotationDeg: 180, params: { openingPct: 50 } } },
        { op: 'add_component', component: { id: 'C', type: 'cylinder_double_acting', label: '-1A1', params: { strokeMm: 100 } } },
        { op: 'connect', from: { componentId: 'S', port: '1' }, to: { componentId: 'F', port: '1' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'F', port: '2' }, to: { componentId: 'V', port: '1' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'V', port: '3' }, to: { componentId: 'EX3', port: '1' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'V', port: '5' }, to: { componentId: 'EX5', port: '1' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'V', port: '4' }, to: { componentId: 'TH', port: '1' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'TH', port: '2' }, to: { componentId: 'C', port: 'A' }, domain: 'pneumatic' },
        { op: 'connect', from: { componentId: 'V', port: '2' }, to: { componentId: 'C', port: 'B' }, domain: 'pneumatic' },
      ],
    });
    assert.equal(patchCtRes.ok, true);

    const layoutCtRes = await callJsonTool(client, 'circuit_auto_layout', { path: 'fresh_patch.ct' });
    assert.equal(layoutCtRes.ok, true);

    const valCtRes = await callJsonTool(client, 'circuit_validate', { path: 'fresh_patch.ct' });
    assert.equal(valCtRes.ok, true);
    assert.equal(valCtRes.data?.valid, true);
    assert.equal(valCtRes.data?.errorCount, 0);
    assert.equal(valCtRes.data?.warningCount, 0);

    const wsStatus = await callJsonTool(client, 'workspace_status');
    assert.equal(wsStatus.ok, true);
    assert.equal((wsStatus.data?.files as unknown[]).length, 4);
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('read-only stdio server rejects authoring mutations with structured AccessDenied error', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-ro-'));
  const transport = new StdioClientTransport({
    command: NODE_BIN,
    args: [TSX_CLI, MCP_ENTRY, 'serve', '--workspace', workspace, '--mode', 'read-only'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-ro-host', version: '1.0.0' });

  try {
    await client.connect(transport);
    const res = await callJsonTool(client, 'circuit_create', {
      path: 'blocked.ct',
      template: 'blank',
    });
    assert.equal(res.ok, false);
    assert.equal(res.error?.category, 'AccessDenied');
    assert.equal(res.error?.code, 'READ_ONLY_MODE');
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('authoring stdio server auto-initializes nonexistent --workspace directory cleanly', async () => {
  const parentTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-init-'));
  const nonexistentWs = path.join(parentTmp, 'nested', 'new-workspace');
  assert.equal(fs.existsSync(nonexistentWs), false);

  const transport = new StdioClientTransport({
    command: NODE_BIN,
    args: [TSX_CLI, MCP_ENTRY, 'serve', '--workspace', nonexistentWs, '--mode', 'authoring'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-init-host', version: '1.0.0' });

  try {
    await client.connect(transport);
    assert.equal(fs.existsSync(nonexistentWs), true);
    const ws = await callJsonTool(client, 'workspace_status');
    assert.equal(ws.ok, true);
  } finally {
    await client.close();
    fs.rmSync(parentTmp, { recursive: true, force: true });
  }
});

test('Streamable HTTP transport serves /health and full MCP sessions on /mcp', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-http-'));
  const srv = await startHttpServer({
    workspaceRoot: workspace,
    accessMode: 'authoring',
    host: '127.0.0.1',
    port: 0,
    repoRoot: REPO_ROOT,
  });

  const client = new Client({ name: 'test-http-host', version: '1.0.0' });
  try {
    // 1. Health endpoint & security headers
    const healthUrl = srv.url.replace(/\/mcp$/, '/health');
    const healthResp = await fetch(healthUrl);
    assert.equal(healthResp.status, 200);
    assert.equal(healthResp.headers.get('x-content-type-options'), 'nosniff');
    const health = (await healthResp.json()) as { status: string; transport: string; version: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.transport, 'streamable-http');
    assert.equal(health.version, '2.0.0');

    // 1b. Malformed JSON returns 400 with JSON-RPC -32700 parse error
    const badJsonResp = await fetch(srv.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"jsonrpc": "2.0", "id": 1, broken',
    });
    assert.equal(badJsonResp.status, 400);
    const badJsonBody = (await badJsonResp.json()) as { error?: { code?: number } };
    assert.equal(badJsonBody.error?.code, -32700);

    // 2. Full MCP client over StreamableHTTPClientTransport
    const transport = new StreamableHTTPClientTransport(new URL(srv.url));
    await client.connect(transport);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 20);
    for (const tool of listed.tools) {
      assertGeminiCompliantSchema(tool.name, tool.inputSchema);
    }

    const docRes = await callJsonTool(client, 'fluidsim_doctor');
    assert.equal(docRes.ok, true);
    assert.equal(docRes.data?.status, 'ok');
  } finally {
    await client.close();
    await srv.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('Streamable HTTP transport enforces maxSessions cap with HTTP 503', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-http-cap-'));
  const srv = await startHttpServer({
    workspaceRoot: workspace,
    accessMode: 'read-only',
    host: '127.0.0.1',
    port: 0,
    repoRoot: REPO_ROOT,
    maxSessions: 1,
  });

  const client1 = new Client({ name: 'test-http-cap-1', version: '1.0.0' });
  try {
    await client1.connect(new StreamableHTTPClientTransport(new URL(srv.url)));

    const secondInitResp = await fetch(srv.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-03-26',
          capabilities: {},
          clientInfo: { name: 'test-http-cap-2', version: '1.0.0' },
        },
      }),
    });
    assert.equal(secondInitResp.status, 503);
  } finally {
    await client1.close();
    await srv.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});

test('CLI doctor and print-config produce valid cross-platform node configs for all supported MCP hosts', () => {
  const doctorRaw = execFileSync(NODE_BIN, [TSX_CLI, MCP_ENTRY, 'doctor', '--json'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  const doctor = JSON.parse(doctorRaw) as {
    status: string;
    catalog: { ok: boolean; count: number; verifiedFluidsim45Count: number };
    codec: { irJsonRoundtripOk: boolean; nativeCt45RoundtripOk: boolean; nativeCt45Ready: boolean };
  };
  assert.equal(doctor.status, 'ok');
  assert.equal(doctor.catalog.ok, true);
  assert.ok(doctor.catalog.count >= 50, `Expected >=50 catalog components, got ${doctor.catalog.count}`);
  assert.ok(
    doctor.catalog.verifiedFluidsim45Count >= 35,
    `Expected >=35 verified FluidSIM 4.5 IDs, got ${doctor.catalog.verifiedFluidsim45Count}`,
  );
  assert.equal(doctor.codec.irJsonRoundtripOk, true);
  assert.equal(doctor.codec.nativeCt45RoundtripOk, true);
  assert.equal(doctor.codec.nativeCt45Ready, true);

  for (const host of ['vscode', 'antigravity', 'gemini-cli', 'claude'] as const) {
    const snippet = buildHostConfigSnippet(host, '/tmp/ws', 'authoring', REPO_ROOT);
    const parsed = JSON.parse(snippet) as Record<string, unknown>;
    assert.ok(parsed.servers || parsed.mcpServers);
  }

  const codexToml = buildHostConfigSnippet('codex', '/tmp/ws', 'authoring', REPO_ROOT);
  assert.ok(codexToml.includes('[mcp_servers.fluidsim_pneumatics_mcp]'));
  assert.ok(codexToml.includes('command = "node"'));
});

test('Phase 4 & H3 hardening: single-acting K_HOLD latch across dwell, dryRun preview, continuous simultaneous/dwell .ct, detectedInputs, sampleLimit, and max-payload-bytes ceiling', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-p4-'));
  const transport = new StdioClientTransport({
    command: NODE_BIN,
    args: [TSX_CLI, MCP_ENTRY, 'serve', '--workspace', workspace, '--mode', 'authoring', '--max-payload-bytes', '24000'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-p4-host', version: '1.0.0' });

  try {
    await client.connect(transport);

    // 0. H3 regression test: single-acting cylinder A (throttles: true) + dwell WAIT:500ms + B+ + A-B- uses K_HOLD_A memory latch
    const genH3 = await callJsonTool(client, 'circuit_generate_from_spec', {
      path: 'h3_single_acting_dwell.ct',
      actuators: [
        { label: 'A', type: 'single-acting', strokeMm: 50, throttles: true },
        { label: 'B', type: 'double-acting', strokeMm: 100, throttles: true },
      ],
      sequence: ['A+', 'WAIT:500ms', 'B+', 'A-B-'],
      controlMethod: 'electro-pneumatic-step-chain',
      startMode: 'continuous',
      includeEStop: true,
    });
    assert.equal(genH3.ok, true, JSON.stringify(genH3));
    assert.equal((genH3.data?.validation as { valid: boolean }).valid, true);
    assert.equal((genH3.data?.sequenceVerification as { passed: boolean }).passed, true);
    const h3Relays = await callJsonTool(client, 'circuit_query_components', {
      path: 'h3_single_acting_dwell.ct',
      type: 'relay_coil',
    });
    const h3RelayLabels = (h3Relays.data?.components as Array<{ label?: string }>).map((c) => c.label);
    assert.ok(h3RelayLabels.includes('K_HOLD_A'), `Expected dedicated K_HOLD_A latch relay, got ${JSON.stringify(h3RelayLabels)}`);

    // 1. Continuous simultaneous + dwell generation directly to native .ct
    const genCont = await callJsonTool(client, 'circuit_generate_from_spec', {
      path: 'cont_sim_dwell.ct',
      actuators: [
        { label: 'A', type: 'single-acting', strokeMm: 50, throttles: false },
        { label: 'B', type: 'double-acting', strokeMm: 100, throttles: false },
      ],
      sequence: ['A+B+', 'WAIT:250ms', 'A-B-'],
      controlMethod: 'electro-pneumatic-step-chain',
      startMode: 'continuous',
      includeEStop: true,
    });
    assert.equal(genCont.ok, true, JSON.stringify(genCont));
    assert.equal((genCont.data?.validation as { valid: boolean }).valid, true);
    const seqVer = genCont.data?.sequenceVerification as { passed: boolean; cyclesObserved?: number };
    assert.equal(seqVer.passed, true, JSON.stringify(seqVer));
    assert.ok((seqVer.cyclesObserved ?? 0) >= 2, `Expected >=2 continuous cycles, got ${seqVer.cyclesObserved}`);

    // 2. circuit_inspect detectedInputs on generated .ct AND real golden 04_electro_pneumatic_abba.ct
    const genInspect = await callJsonTool(client, 'circuit_inspect', { path: 'cont_sim_dwell.ct' });
    assert.equal(genInspect.ok, true);
    const genInputs = genInspect.data?.detectedInputs as Array<{ label: string; detent: boolean }>;
    assert.ok(genInputs.some((i) => i.label === 'S1' && i.detent === true));
    assert.ok(genInputs.some((i) => i.label === 'ESTOP'));

    fs.copyFileSync(
      path.resolve(REPO_ROOT, 'fixtures', 'golden', '04_electro_pneumatic_abba.ct'),
      path.join(workspace, 'golden04.ct'),
    );
    const g04Inspect = await callJsonTool(client, 'circuit_inspect', { path: 'golden04.ct' });
    assert.equal(g04Inspect.ok, true);
    const g04Inputs = g04Inspect.data?.detectedInputs as Array<{ label: string }>;
    assert.ok(g04Inputs.some((i) => i.label === 'START'));
    assert.ok(g04Inputs.some((i) => i.label === 'STOP'));

    // 3. circuit_apply_patch dryRun: true returns diff & validation WITHOUT modifying disk
    const beforeBytes = fs.readFileSync(path.join(workspace, 'cont_sim_dwell.ct'));
    const dryRes = await callJsonTool(client, 'circuit_apply_patch', {
      path: 'cont_sim_dwell.ct',
      dryRun: true,
      operations: [
        {
          op: 'add_component',
          component: { id: 'DRY_LAMP', type: 'indicator_lamp', label: 'H9', paramsJson: '{"color":"green"}' },
        },
      ],
    });
    assert.equal(dryRes.ok, true);
    assert.equal(dryRes.data?.dryRun, true);
    assert.deepEqual(dryRes.data?.addedComponents, ['DRY_LAMP']);
    const afterBytes = fs.readFileSync(path.join(workspace, 'cont_sim_dwell.ct'));
    assert.ok(beforeBytes.equals(afterBytes), 'dryRun: true must not modify file on disk');

    // 4. circuit_simulate includeSamples + sampleLimit caps returned trace samples safely
    const simRes = await callJsonTool(client, 'circuit_simulate', {
      path: 'cont_sim_dwell.ct',
      inputs: [{ label: 'S1', action: 'toggle', atMs: 100 }],
      durationMs: 2000,
      stepMs: 20,
      includeSamples: true,
      sampleLimit: 5,
    });
    assert.equal(simRes.ok, true);
    const samples = simRes.data?.samples as unknown[];
    assert.equal(samples.length, 5);
    assert.equal(simRes.data?.samplesTruncated, true);
    assert.ok(Number(simRes.data?.samplesTotal) > 5);

    // 5. Operator --max-payload-bytes ceiling (24000) cannot be bypassed by caller passing maxBytes: 262144
    const ceilingRes = await callJsonTool(client, 'circuit_query_components', {
      path: 'golden04.ct',
      limit: 200,
      maxBytes: 262144,
    });
    assert.equal(ceilingRes.ok, true);
    const pageMeta = ceilingRes.data?.page as { payloadBytes: number };
    assert.ok(pageMeta.payloadBytes <= 24000, `Payload exceeded server ceiling: ${pageMeta.payloadBytes}`);
    // 6. v2 ergonomic 1-call circuit_build + circuit_render_svg over stdio
    const builtRes = await callJsonTool(client, 'circuit_build', {
      path: 'v2_build_demo.ct',
      title: 'v2 One-Call Demo',
      sheetSize: 'DIN_A4_LANDSCAPE',
      sheetDomain: 'pneumatic-only',
      allowExternalElectricalSheet: true,
      components: [
        { id: 'SRC', type: 'air_source', label: '0Z1', paramsJson: '{"pressureBar":6}' },
        {
          id: 'V1',
          type: 'valve_5_2',
          label: '1V1',
          leftActuation: { type: 'solenoid', label: 'Y1', manualOverride: true, internalPilot: true },
          rightActuation: { type: 'spring' },
          portTerminators: [
            { port: '3', terminator: 'exhaust_silencer' },
            { port: '5', terminator: 'exhaust_silencer' },
          ],
          sectionLabel: 'Actuator 1A',
        },
        {
          id: 'C1',
          type: 'cylinder_double_acting',
          label: '1A1',
          paramsJson: '{"strokeMm":100}',
          distanceRule: [
            { label: '1B1', positionMm: 0 },
            { label: '1B2', positionMm: 100 },
          ],
        },
      ],
      nets: [
        { id: 'NET_SUP', domain: 'pneumatic', endpoints: [{ componentId: 'SRC', port: '1' }, { componentId: 'V1', port: '1' }] },
        { id: 'NET_EXT', domain: 'pneumatic', endpoints: [{ componentId: 'V1', port: '4' }, { componentId: 'C1', port: 'A' }] },
        { id: 'NET_RET', domain: 'pneumatic', endpoints: [{ componentId: 'V1', port: '2' }, { componentId: 'C1', port: 'B' }] },
      ],
    });
    assert.equal(builtRes.ok, true, JSON.stringify(builtRes));
    assert.equal(builtRes.data?.postconditionPassed, true, JSON.stringify(builtRes));

    const svgRes = await callJsonTool(client, 'circuit_render_svg', {
      path: 'v2_build_demo.ct',
      includeSvg: true,
    });
    assert.equal(svgRes.ok, true, JSON.stringify(svgRes));
    assert.equal(typeof svgRes.data?.svg, 'string');
    assert.ok((svgRes.data?.svg as string).includes('<svg'));
    const svgDiag = svgRes.data?.diagnostics as { componentOverlaps: number; outOfBoundsCount: number; f9SolverOk: boolean };
    assert.equal(svgDiag.componentOverlaps, 0);
    assert.equal(svgDiag.outOfBoundsCount, 0);
    assert.equal(svgDiag.f9SolverOk, true);
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
