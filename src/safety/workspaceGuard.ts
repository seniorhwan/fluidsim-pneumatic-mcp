import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EngineeringError } from '../contracts/errors';

export interface WorkspaceGuardOptions {
  workspaceRoot: string;
  createBackupOnOverwrite?: boolean;
  allowedExtensions?: readonly string[];
}

export const DEFAULT_ALLOWED_EXTENSIONS = ['.ct', '.fsim.json'] as const;

export class WorkspaceGuard {
  public readonly root: string;
  public readonly createBackupOnOverwrite: boolean;
  public readonly allowedExtensions: readonly string[];

  constructor(options: WorkspaceGuardOptions) {
    this.root = path.resolve(options.workspaceRoot);
    this.createBackupOnOverwrite = options.createBackupOnOverwrite ?? false;
    this.allowedExtensions = options.allowedExtensions ?? DEFAULT_ALLOWED_EXTENSIONS;
  }

  public ensureRootExists(options?: { createIfMissing?: boolean }): void {
    if (!fs.existsSync(this.root)) {
      if (options?.createIfMissing) {
        fs.mkdirSync(this.root, { recursive: true });
      } else {
        throw new EngineeringError({
          category: 'AccessDenied',
          code: 'WORKSPACE_NOT_FOUND',
          message: `Workspace directory "${this.root}" does not exist.`,
          offendingIds: [],
          suggestedFix: 'Create the workspace directory, pass --init-workspace, or pass an existing directory via --workspace.',
        });
      }
    }
    const stat = fs.statSync(this.root);
    if (!stat.isDirectory()) {
      throw new EngineeringError({
        category: 'AccessDenied',
        code: 'WORKSPACE_NOT_DIRECTORY',
        message: `Workspace path "${this.root}" is not a directory.`,
        offendingIds: [],
        suggestedFix: 'Pass a valid directory path to --workspace.',
      });
    }
  }

  public resolveProjectDir(relativeDir: string): string {
    return this.resolveCircuitPath(relativeDir, false);
  }

  public deleteCircuitFile(filePath: string): { absolutePath: string; relativePath: string } {
    const resolved = this.resolveCircuitPath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'FILE_NOT_FOUND',
        message: `Circuit file "${filePath}" was not found in workspace.`,
        offendingIds: [filePath],
        suggestedFix: 'Check available files with workspace_status before deleting.',
      });
    }
    fs.unlinkSync(resolved);
    return {
      absolutePath: resolved,
      relativePath: this.toRelativePath(resolved),
    };
  }

  public renameCircuitFile(
    fromPath: string,
    toPath: string,
    options?: { overwrite?: boolean },
  ): { fromRelativePath: string; toRelativePath: string; toAbsolutePath: string } {
    const src = this.resolveCircuitPath(fromPath);
    const dst = this.resolveCircuitPath(toPath);
    if (!fs.existsSync(src)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'FILE_NOT_FOUND',
        message: `Source circuit file "${fromPath}" was not found in workspace.`,
        offendingIds: [fromPath],
        suggestedFix: 'Check available files with workspace_status.',
      });
    }
    if (fs.existsSync(dst) && !options?.overwrite && src !== dst) {
      throw new EngineeringError({
        category: 'AccessDenied',
        code: 'FILE_ALREADY_EXISTS',
        message: `Destination circuit file "${toPath}" already exists and overwrite=false.`,
        offendingIds: [toPath],
        suggestedFix: 'Pass overwrite=true or choose a new destination filename.',
      });
    }
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.renameSync(src, dst);
    return {
      fromRelativePath: this.toRelativePath(src),
      toRelativePath: this.toRelativePath(dst),
      toAbsolutePath: dst,
    };
  }

  public resolveCircuitPath(relativeOrAbsPath: string, requireAllowedExtension = true): string {
    if (!relativeOrAbsPath || relativeOrAbsPath.includes('\0')) {
      throw new EngineeringError({
        category: 'AccessDenied',
        code: 'INVALID_PATH',
        message: 'Circuit file path is empty or contains illegal characters.',
        offendingIds: [],
        suggestedFix: 'Provide a clean relative path inside the workspace, e.g. "circuits/clamp.fsim.json" or "clamp.ct".',
      });
    }

    const candidate = path.isAbsolute(relativeOrAbsPath)
      ? path.resolve(relativeOrAbsPath)
      : path.resolve(this.root, relativeOrAbsPath);

    const normalizedRoot = this.root.endsWith(path.sep) ? this.root : `${this.root}${path.sep}`;
    const isInside = candidate === this.root || candidate.startsWith(normalizedRoot);

    if (!isInside) {
      throw new EngineeringError({
        category: 'AccessDenied',
        code: 'PATH_TRAVERSAL_BLOCKED',
        message: `Path "${relativeOrAbsPath}" resolves outside the workspace jail ("${this.root}").`,
        offendingIds: [relativeOrAbsPath],
        suggestedFix: 'Use a relative path contained within the configured workspace root.',
      });
    }

    // Check symlink escape on parent directory AND on the target file itself (if it exists)
    const parentDir = path.dirname(candidate);
    if (fs.existsSync(this.root)) {
      const realRoot = fs.realpathSync(this.root);
      const realRootPrefix = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
      if (fs.existsSync(parentDir)) {
        const realParent = fs.realpathSync(parentDir);
        if (realParent !== realRoot && !realParent.startsWith(realRootPrefix)) {
          throw new EngineeringError({
            category: 'AccessDenied',
            code: 'SYMLINK_ESCAPE_BLOCKED',
            message: `Path "${relativeOrAbsPath}" traverses a symlink outside the workspace jail.`,
            offendingIds: [relativeOrAbsPath],
            suggestedFix: 'Place circuit files directly inside the workspace without external symlinks.',
          });
        }
      }
      if (fs.existsSync(candidate)) {
        const realCandidate = fs.realpathSync(candidate);
        if (realCandidate !== realRoot && !realCandidate.startsWith(realRootPrefix)) {
          throw new EngineeringError({
            category: 'AccessDenied',
            code: 'SYMLINK_ESCAPE_BLOCKED',
            message: `Target "${relativeOrAbsPath}" is a symlink pointing outside the workspace jail.`,
            offendingIds: [relativeOrAbsPath],
            suggestedFix: 'Use regular files inside the workspace rather than symlinks pointing outside.',
          });
        }
      }
    }

    if (requireAllowedExtension) {
      const lower = candidate.toLowerCase();
      const matched = this.allowedExtensions.some((ext) => lower.endsWith(ext));
      if (!matched) {
        throw new EngineeringError({
          category: 'AccessDenied',
          code: 'DISALLOWED_EXTENSION',
          message: `File "${relativeOrAbsPath}" does not use an allowed extension (${this.allowedExtensions.join(', ')}).`,
          offendingIds: [relativeOrAbsPath],
          suggestedFix: `Use a filename ending in ${this.allowedExtensions.join(' or ')}.`,
        });
      }
    }

    return candidate;
  }

  public toRelativePath(absPath: string): string {
    return path.relative(this.root, absPath).split(path.sep).join('/');
  }

  public readFileBuffer(filePath: string): Buffer {
    const resolved = this.resolveCircuitPath(filePath);
    if (!fs.existsSync(resolved)) {
      throw new EngineeringError({
        category: 'InvalidTopology',
        code: 'FILE_NOT_FOUND',
        message: `Circuit file "${filePath}" was not found in workspace.`,
        offendingIds: [filePath],
        suggestedFix: 'Check available files with workspace_status or create one with circuit_create.',
      });
    }
    return fs.readFileSync(resolved);
  }

  /**
   * Atomically writes data using a sibling temp file + rename, optionally creating a .bak backup.
   */
  public writeFileAtomic(
    filePath: string,
    content: Buffer | string,
    options?: { backup?: boolean },
  ): { absolutePath: string; relativePath: string; backupPath?: string } {
    const resolved = this.resolveCircuitPath(filePath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });

    let backupPath: string | undefined;
    const shouldBackup = options?.backup ?? this.createBackupOnOverwrite;
    if (shouldBackup && fs.existsSync(resolved)) {
      backupPath = `${resolved}.bak`;
      fs.copyFileSync(resolved, backupPath);
    }

    const tmpName = `.${path.basename(resolved)}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const tmpPath = path.join(dir, tmpName);
    try {
      fs.writeFileSync(tmpPath, content);
      fs.renameSync(tmpPath, resolved);
    } catch (err) {
      if (fs.existsSync(tmpPath)) {
        try {
          fs.unlinkSync(tmpPath);
        } catch {
          // ignore cleanup failure
        }
      }
      throw err;
    }

    return {
      absolutePath: resolved,
      relativePath: this.toRelativePath(resolved),
      backupPath,
    };
  }

  /**
   * Recursively lists circuit files (.ct and .fsim.json) inside the workspace jail.
   */
  public listCircuitFiles(): string[] {
    if (!fs.existsSync(this.root)) return [];
    const results: string[] = [];

    const walk = (dir: string): void => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.isFile()) {
          const lower = entry.name.toLowerCase();
          if (this.allowedExtensions.some((ext) => lower.endsWith(ext))) {
            results.push(this.toRelativePath(full));
          }
        }
      }
    };

    walk(this.root);
    results.sort();
    return results;
  }

  public checkWritable(): boolean {
    try {
      this.ensureRootExists();
      fs.accessSync(this.root, fs.constants.R_OK | fs.constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }
}
