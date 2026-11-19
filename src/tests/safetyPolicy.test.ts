import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorkspaceGuard } from '../safety/workspaceGuard';
import { enforceToolPolicy } from '../safety/policyCatalog';
import { parseAccessMode } from '../safety/accessMode';
import { EngineeringError } from '../contracts/errors';
import { assertPayloadBudget, paginateWithBudget } from '../contracts/pagination';

test('WorkspaceGuard blocks path traversal, absolute escapes, and disallowed extensions', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-guard-'));
  try {
    const guard = new WorkspaceGuard({ workspaceRoot: tmpDir });

    assert.throws(
      () => guard.resolveCircuitPath('../escape.fsim.json'),
      (err: unknown) =>
        err instanceof EngineeringError &&
        err.category === 'AccessDenied' &&
        err.code === 'PATH_TRAVERSAL_BLOCKED',
    );

    assert.throws(
      () => guard.resolveCircuitPath('/etc/passwd'),
      (err: unknown) =>
        err instanceof EngineeringError &&
        err.category === 'AccessDenied' &&
        err.code === 'PATH_TRAVERSAL_BLOCKED',
    );

    assert.throws(
      () => guard.resolveCircuitPath('script.sh'),
      (err: unknown) =>
        err instanceof EngineeringError &&
        err.category === 'AccessDenied' &&
        err.code === 'DISALLOWED_EXTENSION',
    );

    const resolved = guard.resolveCircuitPath('sub/circuit.fsim.json');
    assert.ok(resolved.startsWith(tmpDir));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('WorkspaceGuard atomic write creates parent dirs, optional .bak backup, and leaves no temp files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fsim-atomic-'));
  try {
    const guard = new WorkspaceGuard({ workspaceRoot: tmpDir, createBackupOnOverwrite: true });
    guard.writeFileAtomic('dir/test.fsim.json', '{"v":1}');
    const second = guard.writeFileAtomic('dir/test.fsim.json', '{"v":2}');

    assert.ok(second.backupPath && fs.existsSync(second.backupPath));
    assert.equal(fs.readFileSync(second.backupPath, 'utf8'), '{"v":1}');
    assert.equal(fs.readFileSync(second.absolutePath, 'utf8'), '{"v":2}');

    const dirEntries = fs.readdirSync(path.join(tmpDir, 'dir'));
    assert.equal(dirEntries.filter((f) => f.endsWith('.tmp')).length, 0);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Access mode policy blocks mutating tools in read-only mode and allows them in authoring mode', () => {
  assert.equal(parseAccessMode(undefined), 'read-only');
  assert.equal(parseAccessMode('authoring'), 'authoring');

  // Read-only permits inspection/validation
  assert.equal(enforceToolPolicy('circuit_inspect', 'read-only').mutatesDisk, false);
  assert.equal(enforceToolPolicy('circuit_simulate', 'read-only').mutatesDisk, false);

  // Read-only denies all Group C authoring tools
  for (const tool of ['circuit_create', 'circuit_apply_patch', 'circuit_generate_from_spec', 'circuit_auto_layout']) {
    assert.throws(
      () => enforceToolPolicy(tool, 'read-only'),
      (err: unknown) =>
        err instanceof EngineeringError &&
        err.category === 'AccessDenied' &&
        err.code === 'READ_ONLY_MODE',
    );
    assert.equal(enforceToolPolicy(tool, 'authoring').mutatesDisk, true);
  }
});

test('Cursor pagination respects limit and byte budget and raises PayloadBudgetExceeded when exceeded', () => {
  const items = Array.from({ length: 20 }, (_, i) => ({
    id: `COMP_${i}`,
    payload: 'x'.repeat(80),
  }));

  const page1 = paginateWithBudget(items, { limit: 15, maxBytes: 700 });
  assert.equal(page1.page.truncatedByBudget, true);
  assert.ok(page1.items.length > 0 && page1.items.length < 15);
  assert.ok(page1.page.nextCursor !== null);

  const page2 = paginateWithBudget(items, { cursor: page1.page.nextCursor!, limit: 15, maxBytes: 700 });
  assert.notEqual(page2.items[0].id, page1.items[0].id);

  assert.throws(
    () => assertPayloadBudget({ big: 'a'.repeat(1000) }, 512, 'test_tool'),
    (err: unknown) =>
      err instanceof EngineeringError &&
      err.category === 'PayloadBudgetExceeded' &&
      err.code === 'PAYLOAD_BUDGET_EXCEEDED',
  );
});
