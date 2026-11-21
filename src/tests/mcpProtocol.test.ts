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

    // 1. Verify all 18 MCP tools are registered AND 100% Gemini/OpenAPI 3.0 schema compliant
    const listed = await client.listTools();
    const toolNames = new Set(listed.tools.map((t) => t.name));
    assert.equal(toolNames.size, 18);
    for (const expected of [
      'workspace_status',
      'catalog_search',
      'fluidsim_doctor',
      'circuit_inspect',
      'circuit_export_netlist',
      'circuit_get_label_map',
      'circuit_query_components',
      'project_create',
      'circuit_create',
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

    const wsStatus = await callJsonTool(client, 'workspace_status');
    assert.equal(wsStatus.ok, true);
    assert.equal((wsStatus.data?.files as unknown[]).length, 3);
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
    // 1. Health endpoint
    const healthUrl = srv.url.replace(/\/mcp$/, '/health');
    const healthResp = await fetch(healthUrl);
    assert.equal(healthResp.status, 200);
    const health = (await healthResp.json()) as { status: string; transport: string };
    assert.equal(health.status, 'ok');
    assert.equal(health.transport, 'streamable-http');

    // 2. Full MCP client over StreamableHTTPClientTransport
    const transport = new StreamableHTTPClientTransport(new URL(srv.url));
    await client.connect(transport);

    const listed = await client.listTools();
    assert.equal(listed.tools.length, 18);
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
  } finally {
    await client.close();
    fs.rmSync(workspace, { recursive: true, force: true });
  }
});
