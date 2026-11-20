import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { buildHostConfigSnippet } from '../../bin/fluidsim-mcp';

const REPO_ROOT = process.cwd();
const TSX_BIN = path.resolve(REPO_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const MCP_ENTRY = path.resolve(REPO_ROOT, 'bin', 'fluidsim-mcp.ts');

async function callJsonTool(client: Client, name: string, args: Record<string, unknown> = {}) {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  assert.ok(content.length > 0 && content[0].type === 'text' && typeof content[0].text === 'string');
  return JSON.parse(content[0].text) as { ok: boolean; data?: Record<string, unknown>; error?: Record<string, unknown> };
}

test('end-to-end stdio MCP server exercises full autonomous agent loop without stdout corruption', async () => {
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-mcp-e2e-'));
  const transport = new StdioClientTransport({
    command: TSX_BIN,
    args: [MCP_ENTRY, 'serve', '--workspace', workspace, '--mode', 'authoring'],
    cwd: REPO_ROOT,
    stderr: 'pipe',
  });
  const client = new Client({ name: 'test-agent-host', version: '1.0.0' });

  try {
    await client.connect(transport);

    // 1. Verify all 14 MCP tools are registered
    const listed = await client.listTools();
    const toolNames = new Set(listed.tools.map((t) => t.name));
    assert.equal(toolNames.size, 14);
    for (const expected of [
      'workspace_status',
      'catalog_search',
      'fluidsim_doctor',
      'circuit_inspect',
      'circuit_export_netlist',
      'circuit_get_label_map',
      'circuit_query_components',
      'circuit_create',
      'circuit_apply_patch',
      'circuit_generate_from_spec',
      'circuit_auto_layout',
      'circuit_validate',
      'circuit_simulate',
      'circuit_verify_sequence',
    ]) {
      assert.ok(toolNames.has(expected), `Missing registered MCP tool: ${expected}`);
    }

    // 2. Group A: doctor & catalog_search
    const docRes = await callJsonTool(client, 'fluidsim_doctor');
    assert.equal(docRes.ok, true);
    assert.equal(docRes.data?.status, 'ok');

    const catRes = await callJsonTool(client, 'catalog_search', { query: '5/2' });
    assert.equal(catRes.ok, true);
    const catItems = catRes.data?.components as Array<{ componentType: string }>;
    assert.ok(catItems.some((c) => c.componentType === 'valve_5_2'));

    // 3. Autonomous self-healing loop: create -> patch with bug -> validate catches bug -> patch fix -> simulate
    const createRes = await callJsonTool(client, 'circuit_create', {
      path: 'manual.fsim.json',
      template: 'pneumatic_basic',
      title: 'Self-Heal Demo',
    });
    assert.equal(createRes.ok, true);

    // Intentionally omit exhaust_silencer on V1.3
    const badPatch = await callJsonTool(client, 'circuit_apply_patch', {
      path: 'manual.fsim.json',
      operations: [
        {
          op: 'add_component',
          component: {
            id: 'V1',
            type: 'valve_3_2',
            label: 'S1',
            params: { normalState: 'NC' },
            leftActuation: { type: 'pushbutton', label: 'S1' },
            rightActuation: { type: 'spring' },
          },
        },
        { op: 'add_component', component: { id: 'C1', type: 'cylinder_single_acting', label: 'A', params: { strokeMm: 50 } } },
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
        { op: 'add_component', component: { id: 'EX1', type: 'exhaust_silencer', params: {} } },
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

    // 4. One-shot declarative generator directly to native FluidSIM 4.5 .ct + read tools + auto-layout + verify_sequence
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
    command: TSX_BIN,
    args: [MCP_ENTRY, 'serve', '--workspace', workspace, '--mode', 'read-only'],
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

test('CLI doctor and print-config produce valid configs for all supported MCP hosts', () => {
  const doctorRaw = execFileSync(TSX_BIN, [MCP_ENTRY, 'doctor', '--json'], {
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
  assert.ok(doctor.catalog.count >= 25);
  assert.ok(doctor.catalog.verifiedFluidsim45Count >= 20);
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
  assert.ok(codexToml.includes('command = "npx"'));
});
