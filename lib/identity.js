/**
 * Filesystem identity tracking (`dev:ino`) and persistent relocation index.
 * @module dsh-workspace-sync/identity
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Resolve the active DeepSeek Harness home directory (`$DSH_HOME` or `~/.dsh`).
 * @param {string} [configured]
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolveDshHome(configured, env = process.env) {
  const fromEnv = env?.DSH_HOME;
  const raw = configured ?? (fromEnv !== undefined && fromEnv.trim().length > 0 ? fromEnv : path.join(os.homedir(), ".dsh"));
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/") || raw.startsWith("~\\")) {
    return path.resolve(path.join(os.homedir(), raw.slice(2)));
  }
  return path.resolve(raw);
}

/**
 * Compute `@deepseek-ai/dsh-workspace`-compatible default workspace title
 * from a canonical directory path.
 * @param {string} dirPath
 * @param {string} [platform]
 * @returns {string}
 */
export function defaultWorkspaceTitle(dirPath, platform = process.platform) {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  return pathApi.basename(dirPath) || pathApi.parse(dirPath).root;
}

/**
 * Derive a rename-invariant directory identity string from `fs.Stats` / `BigIntStats`.
 * Uses `dev:ino` when `ino` is non-zero; falls back to `dev:0:birthtimeNs` when `ino` is 0.
 * @param {fs.Stats | fs.BigIntStats | undefined} st
 * @returns {string | undefined}
 */
export function directoryIdentityFromStat(st) {
  if (!st || typeof st.isDirectory !== "function" || !st.isDirectory()) return undefined;
  const dev = st.dev !== undefined ? BigInt(st.dev) : 0n;
  const ino = st.ino !== undefined ? BigInt(st.ino) : 0n;
  if (ino !== 0n) {
    return `${dev}:${ino}`;
  }
  const birthNs = st.birthtimeNs !== undefined
    ? BigInt(st.birthtimeNs)
    : (typeof st.birthtimeMs === "number" && Number.isFinite(st.birthtimeMs) && st.birthtimeMs > 0
        ? BigInt(Math.trunc(st.birthtimeMs))
        : 0n);
  if (birthNs !== 0n) {
    return `${dev}:0:${birthNs}`;
  }
  return undefined;
}

/**
 * Inspect an existing directory asynchronously and return its canonical path and identity.
 * @param {string} dirPath
 * @returns {Promise<{ canonicalPath: string, identity: string | undefined } | undefined>}
 */
export async function getDirectoryIdentity(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return undefined;
  try {
    const st = await fs.promises.stat(dirPath, { bigint: true });
    if (!st.isDirectory()) return undefined;
    const canonicalPath = await fs.promises.realpath(dirPath);
    return {
      canonicalPath,
      identity: directoryIdentityFromStat(st),
    };
  } catch {
    return undefined;
  }
}

/**
 * Inspect an existing directory synchronously and return its canonical path and identity.
 * @param {string} dirPath
 * @returns {{ canonicalPath: string, identity: string | undefined } | undefined}
 */
export function getDirectoryIdentitySync(dirPath) {
  if (!dirPath || typeof dirPath !== "string") return undefined;
  try {
    const st = fs.statSync(dirPath, { bigint: true });
    if (!st.isDirectory()) return undefined;
    const canonicalPath = fs.realpathSync(dirPath);
    return {
      canonicalPath,
      identity: directoryIdentityFromStat(st),
    };
  } catch {
    return undefined;
  }
}

function writeFileAtomicSync(filePath, content) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmpPath, content, "utf8");
  try {
    fs.renameSync(tmpPath, filePath);
  } catch {
    try {
      fs.writeFileSync(filePath, content, "utf8");
    } finally {
      try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    }
  }
}

/**
 * Tracks observed directory identities (`dev:ino`) and old->new path relocations,
 * backed by `$DSH_HOME/storages/workspace-sync.json` so offline renames across restarts
 * can still be resolved automatically.
 */
export class RelocationTracker {
  /**
   * @param {object} [options]
   * @param {string} [options.storagePath]
   * @param {{ warn?: (...args: unknown[]) => void, debug?: (...args: unknown[]) => void }} [options.logger]
   */
  constructor(options = {}) {
    this.storagePath = options.storagePath ?? path.join(resolveDshHome(), "storages", "workspace-sync.json");
    this.logger = options.logger;
    /** @type {Map<string, string>} */
    this.identities = new Map();
    /** @type {Map<string, string>} */
    this.relocations = new Map();
    this.loaded = false;
  }

  /** Load persisted identity and relocation maps synchronously (idempotent). */
  loadSync() {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = fs.readFileSync(this.storagePath, "utf8");
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object") {
        if (parsed.identities && typeof parsed.identities === "object") {
          for (const [k, v] of Object.entries(parsed.identities)) {
            if (typeof k === "string" && typeof v === "string" && k.length > 0 && v.length > 0) {
              this.identities.set(k, v);
            }
          }
        }
        if (parsed.relocations && typeof parsed.relocations === "object") {
          for (const [k, v] of Object.entries(parsed.relocations)) {
            if (typeof k === "string" && typeof v === "string" && k.length > 0 && v.length > 0 && k !== v) {
              this.relocations.set(k, v);
            }
          }
        }
      }
    } catch (error) {
      if (error?.code !== "ENOENT") {
        this.logger?.warn?.(`[dsh-workspace-sync] failed to load ${this.storagePath}: ${String(error)}`);
      }
    }
  }

  /** Persist current identity and relocation maps atomically. */
  saveSync() {
    this.loaded = true;
    try {
      const payload = {
        version: 1,
        identities: Object.fromEntries(this.identities),
        relocations: Object.fromEntries(this.relocations),
      };
      writeFileAtomicSync(this.storagePath, JSON.stringify(payload, null, 2) + "\n");
    } catch (error) {
      this.logger?.warn?.(`[dsh-workspace-sync] failed to persist ${this.storagePath}: ${String(error)}`);
    }
  }

  /** @private */
  _lookupIdentity(dirPath) {
    this.loadSync();
    const direct = this.identities.get(dirPath);
    if (direct !== undefined) return direct;
    const resolved = path.resolve(dirPath);
    if (resolved !== dirPath) {
      const fromResolved = this.identities.get(resolved);
      if (fromResolved !== undefined) return fromResolved;
    }
    if (process.platform === "win32") {
      const lower = resolved.toLowerCase();
      for (const [k, v] of this.identities) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return undefined;
  }

  /** @private */
  _lookupRelocation(dirPath) {
    this.loadSync();
    const direct = this.relocations.get(dirPath);
    if (direct !== undefined) return direct;
    const resolved = path.resolve(dirPath);
    if (resolved !== dirPath) {
      const fromResolved = this.relocations.get(resolved);
      if (fromResolved !== undefined) return fromResolved;
    }
    if (process.platform === "win32") {
      const lower = resolved.toLowerCase();
      for (const [k, v] of this.relocations) {
        if (k.toLowerCase() === lower) return v;
      }
    }
    return undefined;
  }

  /**
   * Observe an existing directory asynchronously and record its filesystem identity.
   * @param {string} dirPath
   * @returns {Promise<{ canonicalPath: string, identity: string | undefined } | undefined>}
   */
  async observe(dirPath) {
    this.loadSync();
    const info = await getDirectoryIdentity(dirPath);
    if (!info) return undefined;
    let changed = false;
    if (info.identity !== undefined && this.identities.get(info.canonicalPath) !== info.identity) {
      this.identities.set(info.canonicalPath, info.identity);
      changed = true;
    }
    if (this.relocations.delete(info.canonicalPath)) {
      changed = true;
    }
    if (changed) this.saveSync();
    return info;
  }

  /**
   * Observe an existing directory synchronously and record its filesystem identity.
   * @param {string} dirPath
   * @returns {{ canonicalPath: string, identity: string | undefined } | undefined}
   */
  observeSync(dirPath) {
    this.loadSync();
    const info = getDirectoryIdentitySync(dirPath);
    if (!info) return undefined;
    let changed = false;
    if (info.identity !== undefined && this.identities.get(info.canonicalPath) !== info.identity) {
      this.identities.set(info.canonicalPath, info.identity);
      changed = true;
    }
    if (this.relocations.delete(info.canonicalPath)) {
      changed = true;
    }
    if (changed) this.saveSync();
    return info;
  }

  /**
   * Record that `oldPath` has moved/renamed to `newPath`, updating any transitive chain.
   * @param {string} oldPath
   * @param {string} newPath
   * @param {string} [identity]
   */
  recordRelocation(oldPath, newPath, identity) {
    this.loadSync();
    if (!oldPath || !newPath || oldPath === newPath) return;
    let changed = false;
    if (this.relocations.get(oldPath) !== newPath) {
      this.relocations.set(oldPath, newPath);
      changed = true;
    }
    // Collapse transitive mappings (A -> B when B -> C becomes A -> C) and prevent cycles.
    for (const [k, v] of [...this.relocations.entries()]) {
      if (k === newPath) {
        this.relocations.delete(k);
        changed = true;
      } else if (v === oldPath && k !== newPath) {
        this.relocations.set(k, newPath);
        changed = true;
      }
    }
    if (identity !== undefined) {
      if (this.identities.get(newPath) !== identity) {
        this.identities.set(newPath, identity);
        changed = true;
      }
      if (this.identities.get(oldPath) !== identity) {
        this.identities.set(oldPath, identity);
        changed = true;
      }
    }
    if (changed) this.saveSync();
  }

  /**
   * Synchronously resolve a directory path (for `sandboxPolicy.resolve`),
   * returning the relocated path if the original path disappeared and moved.
   * @param {string} targetPath
   * @returns {string}
   */
  resolveKnownSync(targetPath) {
    if (!targetPath || typeof targetPath !== "string") return targetPath;
    if (getDirectoryIdentitySync(targetPath)) return targetPath;
    const known = this._lookupRelocation(targetPath);
    if (known && getDirectoryIdentitySync(known)) return known;
    return this.findRelocatedSync(targetPath) ?? targetPath;
  }

  /**
   * Attempt to locate the renamed/relocated directory for a missing path asynchronously.
   * Scans the parent directory for a child directory sharing the observed `dev:ino` identity,
   * and recurses through renamed ancestors if the parent itself was renamed.
   * @param {string} missingPath
   * @param {Set<string>} [visited]
   * @returns {Promise<string | undefined>}
   */
  async findRelocated(missingPath, visited = new Set()) {
    if (!missingPath || typeof missingPath !== "string") return undefined;
    this.loadSync();

    const normalized = path.resolve(missingPath);
    if (visited.has(normalized)) return undefined;
    visited.add(normalized);

    const existing = await this.observe(missingPath);
    if (existing) return existing.canonicalPath;

    const knownTarget = this._lookupRelocation(missingPath);
    if (knownTarget) {
      const targetInfo = await this.observe(knownTarget);
      if (targetInfo) return targetInfo.canonicalPath;
    }

    const expectedIdentity = this._lookupIdentity(missingPath);
    const parentDir = path.dirname(normalized);
    if (parentDir === normalized) return undefined;

    let searchParent = parentDir;
    const parentInfo = await getDirectoryIdentity(parentDir);
    if (!parentInfo) {
      const relocatedParent = await this.findRelocated(parentDir, visited);
      if (!relocatedParent) return undefined;
      searchParent = relocatedParent;

      const sameBasenameCandidate = path.join(searchParent, path.basename(normalized));
      const candidateInfo = await getDirectoryIdentity(sameBasenameCandidate);
      if (candidateInfo && (expectedIdentity === undefined || candidateInfo.identity === expectedIdentity)) {
        this.recordRelocation(missingPath, candidateInfo.canonicalPath, candidateInfo.identity ?? expectedIdentity);
        return candidateInfo.canonicalPath;
      }
    }

    if (expectedIdentity === undefined) return undefined;

    let entries;
    try {
      entries = await fs.promises.readdir(searchParent, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(searchParent, entry.name);
      const info = await getDirectoryIdentity(candidate);
      if (!info || info.identity !== expectedIdentity) continue;
      this.recordRelocation(missingPath, info.canonicalPath, info.identity);
      return info.canonicalPath;
    }

    return undefined;
  }

  /**
   * Synchronous counterpart to {@link findRelocated}.
   * @param {string} missingPath
   * @param {Set<string>} [visited]
   * @returns {string | undefined}
   */
  findRelocatedSync(missingPath, visited = new Set()) {
    if (!missingPath || typeof missingPath !== "string") return undefined;
    this.loadSync();

    const normalized = path.resolve(missingPath);
    if (visited.has(normalized)) return undefined;
    visited.add(normalized);

    const existing = this.observeSync(missingPath);
    if (existing) return existing.canonicalPath;

    const knownTarget = this._lookupRelocation(missingPath);
    if (knownTarget) {
      const targetInfo = this.observeSync(knownTarget);
      if (targetInfo) return targetInfo.canonicalPath;
    }

    const expectedIdentity = this._lookupIdentity(missingPath);
    const parentDir = path.dirname(normalized);
    if (parentDir === normalized) return undefined;

    let searchParent = parentDir;
    const parentInfo = getDirectoryIdentitySync(parentDir);
    if (!parentInfo) {
      const relocatedParent = this.findRelocatedSync(parentDir, visited);
      if (!relocatedParent) return undefined;
      searchParent = relocatedParent;

      const sameBasenameCandidate = path.join(searchParent, path.basename(normalized));
      const candidateInfo = getDirectoryIdentitySync(sameBasenameCandidate);
      if (candidateInfo && (expectedIdentity === undefined || candidateInfo.identity === expectedIdentity)) {
        this.recordRelocation(missingPath, candidateInfo.canonicalPath, candidateInfo.identity ?? expectedIdentity);
        return candidateInfo.canonicalPath;
      }
    }

    if (expectedIdentity === undefined) return undefined;

    let entries;
    try {
      entries = fs.readdirSync(searchParent, { withFileTypes: true });
    } catch {
      return undefined;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(searchParent, entry.name);
      const info = getDirectoryIdentitySync(candidate);
      if (!info || info.identity !== expectedIdentity) continue;
      this.recordRelocation(missingPath, info.canonicalPath, info.identity);
      return info.canonicalPath;
    }

    return undefined;
  }
}
