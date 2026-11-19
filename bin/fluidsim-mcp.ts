#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAccessMode, type AccessMode } from '../src/safety/accessMode';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../src/contracts/pagination';
import { SERVER_NAME, SERVER_VERSION, startStdioServer } from '../src/mcp/server';
import { WorkspaceGuard } from '../src/safety/workspaceGuard';
import { handleFluidsimDoctor } from '../src/mcp/tools/workspaceTools';

export type ClientHost = 'vscode' | 'antigravity' | 'gemini-cli' | 'claude' | 'codex';

export function buildHostConfigSnippet(
  client: ClientHost,
  workspaceDir: string,
  mode: AccessMode = 'authoring',
  repoRoot?: string,
): string {
  const absWorkspace = path.resolve(workspaceDir);
  const binScript = repoRoot
    ? path.resolve(repoRoot, 'bin', 'fluidsim-mcp.ts')
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'fluidsim-mcp.ts');

  const command = 'npx';
  const args = ['tsx', binScript, 'serve', '--workspace', absWorkspace, '--mode', mode];

  if (client === 'codex') {
    const escapedArgs = args.map((a) => JSON.stringify(a)).join(', ');
    return [
      '# Add to ~/.codex/config.toml',
      `[mcp_servers.${SERVER_NAME.replace(/-/g, '_')}]`,
      `command = ${JSON.stringify(command)}`,
      `args = [${escapedArgs}]`,
    ].join('\n');
  }

  if (client === 'vscode') {
    return JSON.stringify(
      {
        servers: {
          [SERVER_NAME]: {
            type: 'stdio',
            command,
            args,
          },
        },
      },
      null,
      2,
    );
  }

  // antigravity, gemini-cli, claude all use mcpServers JSON schema
  return JSON.stringify(
    {
      mcpServers: {
        [SERVER_NAME]: {
          command,
          args,
        },
      },
    },
    null,
    2,
  );
}

function getFlagValue(argv: string[], flag: string): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx >= 0 && idx + 1 < argv.length) {
    return argv[idx + 1];
  }
  return undefined;
}

function hasFlag(argv: string[], flag: string): boolean {
  return argv.includes(flag);
}

function printHelp(): void {
  process.stdout.write(
    [
      `${SERVER_NAME} v${SERVER_VERSION} — Headless Festo FluidSIM Pneumatics 4.5 MCP Server`,
      '',
      'Subcommands:',
      '  serve --workspace <dir> [--mode authoring|read-only] [--max-payload-bytes 32768] [--backup]',
      '  doctor [--workspace <dir>] [--json]',
      '  print-config --client vscode|antigravity|gemini-cli|claude|codex --workspace <dir> [--mode authoring|read-only]',
      '',
    ].join('\n'),
  );
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const sub = argv[0];

  if (!sub || sub === '--help' || sub === '-h') {
    printHelp();
    return;
  }

  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

  if (sub === 'serve') {
    const workspaceArg = getFlagValue(argv, '--workspace') ?? process.cwd();
    const mode = parseAccessMode(getFlagValue(argv, '--mode') ?? 'read-only');
    const maxBytesRaw = getFlagValue(argv, '--max-payload-bytes');
    const maxPayloadBytes = maxBytesRaw ? Number(maxBytesRaw) : DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes < 512) {
      process.stderr.write('Error: --max-payload-bytes must be an integer >= 512.\n');
      process.exitCode = 1;
      return;
    }

    await startStdioServer({
      workspaceRoot: workspaceArg,
      accessMode: mode,
      maxPayloadBytes,
      createBackupOnOverwrite: hasFlag(argv, '--backup'),
      repoRoot,
    });
    return;
  }

  if (sub === 'doctor') {
    const workspaceArg = getFlagValue(argv, '--workspace') ?? process.cwd();
    const guard = new WorkspaceGuard({ workspaceRoot: workspaceArg });
    const report = handleFluidsimDoctor({
      guard,
      accessMode: 'read-only',
      maxPayloadBytes: DEFAULT_MAX_PAYLOAD_BYTES,
      serverVersion: SERVER_VERSION,
      repoRoot,
    });
    if (hasFlag(argv, '--json')) {
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      process.stdout.write(
        [
          `${SERVER_NAME} doctor: ${report.status.toUpperCase()}`,
          `  Node: ${report.nodeVersion} (${report.platform})`,
          `  Workspace: ${report.workspace.root} (writable=${report.workspace.writable})`,
          `  Catalog: ${report.catalog.count} components (ok=${report.catalog.ok})`,
          `  IR Codec Self-Test: ${report.codec.irJsonRoundtripOk ? 'PASS' : 'FAIL'}`,
          `  Native .ct 4.5 Golden Gate: ${
            report.codec.nativeCt45Ready
              ? 'READY'
              : `PENDING (${report.codec.goldenFixturesMissing.length} missing: ${report.codec.goldenFixturesMissing.join(', ')})`
          }`,
        ].join('\n') + '\n',
      );
    }
    return;
  }

  if (sub === 'print-config' || sub === 'install-config') {
    const client = (getFlagValue(argv, '--client') ?? 'vscode') as ClientHost;
    const allowed: ClientHost[] = ['vscode', 'antigravity', 'gemini-cli', 'claude', 'codex'];
    if (!allowed.includes(client)) {
      process.stderr.write(`Error: --client must be one of: ${allowed.join(', ')}\n`);
      process.exitCode = 1;
      return;
    }
    const workspaceArg = getFlagValue(argv, '--workspace') ?? process.cwd();
    const mode = parseAccessMode(getFlagValue(argv, '--mode') ?? 'authoring');
    process.stdout.write(`${buildHostConfigSnippet(client, workspaceArg, mode, repoRoot)}\n`);
    return;
  }

  process.stderr.write(`Unknown subcommand "${sub}". Run with --help for usage.\n`);
  process.exitCode = 1;
}

const isDirectExecution =
  typeof process.argv[1] === 'string' &&
  path.resolve(process.argv[1]).endsWith(path.normalize('bin/fluidsim-mcp.ts'));

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
