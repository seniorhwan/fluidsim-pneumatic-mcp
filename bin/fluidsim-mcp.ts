#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseAccessMode, type AccessMode } from '../src/safety/accessMode';
import { DEFAULT_MAX_PAYLOAD_BYTES } from '../src/contracts/pagination';
import {
  SERVER_NAME,
  SERVER_VERSION,
  startHttpServer,
  startStdioServer,
} from '../src/mcp/server';
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
  const resolvedRepoRoot = repoRoot
    ? path.resolve(repoRoot)
    : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const builtEntry = path.resolve(resolvedRepoRoot, 'dist', 'bin', 'fluidsim-mcp.js');
  const tsxCli = path.resolve(resolvedRepoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  const tsEntry = path.resolve(resolvedRepoRoot, 'bin', 'fluidsim-mcp.ts');

  // Prefer compiled node entrypoint (cross-platform, zero npx/Windows .cmd issues); fall back to node + tsx cli.mjs
  const command = 'node';
  const entryArgs = fs.existsSync(builtEntry)
    ? [builtEntry]
    : [tsxCli, tsEntry];
  const args = [...entryArgs, 'serve', '--workspace', absWorkspace, '--mode', mode];

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
      '  serve --workspace <dir> [--mode authoring|read-only] [--transport stdio|http] [--port 3000] [--host 127.0.0.1] [--init-workspace] [--max-payload-bytes 32768] [--backup]',
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

  const currentFile = fileURLToPath(import.meta.url);
  const repoRoot = currentFile.includes(`${path.sep}dist${path.sep}`)
    ? path.resolve(path.dirname(currentFile), '..', '..')
    : path.resolve(path.dirname(currentFile), '..');

  if (sub === 'serve') {
    const workspaceArg = getFlagValue(argv, '--workspace') ?? process.cwd();
    const mode = parseAccessMode(getFlagValue(argv, '--mode') ?? 'read-only');
    const transport = getFlagValue(argv, '--transport') ?? 'stdio';
    const maxBytesRaw = getFlagValue(argv, '--max-payload-bytes');
    const maxPayloadBytes = maxBytesRaw ? Number(maxBytesRaw) : DEFAULT_MAX_PAYLOAD_BYTES;
    if (!Number.isFinite(maxPayloadBytes) || maxPayloadBytes < 512) {
      process.stderr.write('Error: --max-payload-bytes must be an integer >= 512.\n');
      process.exitCode = 1;
      return;
    }

    const commonOpts = {
      workspaceRoot: workspaceArg,
      accessMode: mode,
      maxPayloadBytes,
      createBackupOnOverwrite: hasFlag(argv, '--backup'),
      initWorkspace: hasFlag(argv, '--init-workspace'),
      repoRoot,
    };

    if (transport === 'http') {
      const portRaw = getFlagValue(argv, '--port');
      const port = portRaw ? Number(portRaw) : 3000;
      if (!Number.isInteger(port) || port < 0 || port > 65535) {
        process.stderr.write('Error: --port must be an integer in [0, 65535].\n');
        process.exitCode = 1;
        return;
      }
      const host = getFlagValue(argv, '--host') ?? '127.0.0.1';
      await startHttpServer({
        ...commonOpts,
        host,
        port,
      });
      return;
    }

    if (transport !== 'stdio') {
      process.stderr.write(`Error: --transport must be "stdio" or "http" (got "${transport}").\n`);
      process.exitCode = 1;
      return;
    }

    await startStdioServer(commonOpts);
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
          `  Catalog: ${report.catalog.count} components (${report.catalog.verifiedFluidsim45Count} verified FluidSIM 4.5 IDs, ok=${report.catalog.ok})`,
          `  IR Codec Self-Test: ${report.codec.irJsonRoundtripOk ? 'PASS' : 'FAIL'}`,
          `  Native .ct 4.5 Codec Self-Test: ${report.codec.nativeCt45RoundtripOk ? 'PASS' : 'FAIL'}`,
          `  Native .ct 4.5 Golden Fixtures: ${
            report.codec.nativeCt45Ready
              ? `READY (${report.codec.goldenFixturesPresent.length}/6 verified)`
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

const resolvedEntry = typeof process.argv[1] === 'string' ? path.resolve(process.argv[1]) : '';
const isDirectExecution =
  resolvedEntry.endsWith(path.normalize('bin/fluidsim-mcp.ts')) ||
  resolvedEntry.endsWith(path.normalize('dist/bin/fluidsim-mcp.js'));

if (isDirectExecution) {
  main().catch((err) => {
    process.stderr.write(`Fatal: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
}
