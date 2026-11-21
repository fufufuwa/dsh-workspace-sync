/**
 * DeepSeek Harness (`dsh`) plugin that automatically tracks and synchronizes
 * local project/workspace directory renames via filesystem inode identity (`dev:ino`).
 * @module dsh-workspace-sync
 */

import fs from "node:fs";
import path from "node:path";
import {
  RelocationTracker,
  defaultWorkspaceTitle,
  getDirectoryIdentity,
} from "./identity.js";

export const name = "dsh-workspace-sync";

export const DEFAULTS = {
  enabled: true,
  watchParentDirs: true,
  followWorkingDirectory: true,
  followWorkspaceRegistry: true,
  syncWorkspaceFiles: true,
  syncSandboxPolicy: true,
  watchDebounceMs: 150,
  verbose: false,
  storagePath: undefined,
};

/**
 * Normalize raw plugin configuration, handling stringified booleans from YAML.
 * @param {Record<string, unknown>} [raw]
 * @returns {typeof DEFAULTS}
 */
export function normalizeConfig(raw) {
  const cfg = { ...DEFAULTS, ...(raw || {}) };
  for (const key of [
    "enabled",
    "watchParentDirs",
    "followWorkingDirectory",
    "followWorkspaceRegistry",
    "syncWorkspaceFiles",
    "syncSandboxPolicy",
    "verbose",
  ]) {
    const value = cfg[key];
    if (typeof value === "string") {
      cfg[key] = !/^(false|0|no|off)$/i.test(value.trim());
    }
  }
  if (typeof cfg.watchDebounceMs !== "number" || !Number.isFinite(cfg.watchDebounceMs) || cfg.watchDebounceMs < 0) {
    cfg.watchDebounceMs = DEFAULTS.watchDebounceMs;
  }
  return cfg;
}

/**
 * Resolve the optional `fs` service from `scope` without tripping cordis's
 * inject guard. A bare `scope.fs` property read on a sub-context that did not
 * declare `fs` (e.g. the `["workingDirectory"]` scope below) throws
 * `cannot get property "fs" without inject` and kills the whole turn;
 * `scope.get("fs")` is the documented inject-free lookup and yields
 * `undefined` when the service is not provided. Plain-object scopes
 * (unit-test mocks without `get`) fall back to the direct property read.
 * @param {any} scope
 * @returns {any}
 */
function resolveFsService(scope) {
  if (typeof scope?.get === "function") {
    try {
      return scope.get("fs");
    } catch {
      return undefined;
    }
  }
  if (scope && typeof scope === "object" && "fs" in scope) {
    try {
      return scope.fs;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/**
 * Check whether `dirPath` currently resolves to an existing directory,
 * preferring `ctx.fs` when mounted and falling back to `node:fs`.
 * @param {any} scope
 * @param {string} dirPath
 * @param {AbortSignal} [signal]
 * @returns {Promise<boolean>}
 */
async function directoryExists(scope, dirPath, signal) {
  if (!dirPath || typeof dirPath !== "string") return false;
  const fsService = resolveFsService(scope);
  if (fsService && typeof fsService.resolve === "function" && typeof fsService.stat === "function") {
    try {
      const target = await fsService.resolve(dirPath, { signal });
      const info = await fsService.stat(target, signal);
      return info?.type === "directory";
    } catch (error) {
      if (signal?.aborted) throw error;
      return false;
    }
  }
  return (await getDirectoryIdentity(dirPath)) !== undefined;
}

/**
 * Update a `WorkspaceRegistry` entity's path (and default title if unchanged)
 * without pruning its accounted sessions.
 * @param {any} reg
 * @param {any} entity
 * @param {string} oldPath
 * @param {string} newPath
 * @param {{ warn?: (...args: unknown[]) => void }} [logger]
 * @returns {Promise<boolean>}
 */
async function relocateWorkspaceEntity(reg, entity, oldPath, newPath, logger) {
  if (!entity || !oldPath || !newPath || oldPath === newPath) return false;

  // Enforce the registry's canonical-path uniqueness invariant before mutating.
  const conflict = reg.list().find((candidate) => candidate.id !== entity.id && candidate.path === newPath);
  if (conflict !== undefined) {
    logger?.warn?.(
      `[dsh-workspace-sync] cannot relocate workspace '${entity.id}' from '${oldPath}' to '${newPath}': `
      + `path is already owned by workspace '${conflict.id}'`,
    );
    return false;
  }

  const candidateIds = Array.isArray(entity.record?.sessionIds)
    ? [...entity.record.sessionIds]
    : [...(entity.sessionIds ?? [])];

  const markSessionRelocated = (sessionId) => {
    if (typeof reg.host?.rememberSessionPath === "function") {
      reg.host.rememberSessionPath(sessionId, newPath);
      return;
    }
    reg.sessionPaths?.set?.(sessionId, newPath);
    reg.missingSessionPaths?.delete?.(sessionId);
    reg.invalidSessionPaths?.delete?.(sessionId);
  };

  for (const sessionId of candidateIds) {
    markSessionRelocated(sessionId);
  }
  if (reg.sessionPaths instanceof Map) {
    for (const [sessionId, sessionPath] of reg.sessionPaths.entries()) {
      if (sessionPath === oldPath) {
        markSessionRelocated(sessionId);
      }
    }
  }
  if (reg.headers instanceof Map) {
    for (const sessionId of candidateIds) {
      const header = reg.headers.get(sessionId);
      if (header && header.cwd === oldPath) {
        try { header.cwd = newPath; } catch { /* header may be frozen */ }
      }
    }
  }

  const oldDefaultTitle = defaultWorkspaceTitle(oldPath);
  const newDefaultTitle = defaultWorkspaceTitle(newPath);

  if (typeof entity.mutate === "function") {
    await entity.mutate((record) => ({
      ...record,
      path: newPath,
      title: record.title === oldDefaultTitle ? newDefaultTitle : record.title,
    }));
    return true;
  }

  // Fallback for minimal mock entities exposing setters.
  if (typeof entity.setPath === "function") {
    await entity.setPath(newPath);
    if (entity.title === oldDefaultTitle && typeof entity.setTitle === "function") {
      await entity.setTitle(newDefaultTitle);
    }
    return true;
  }

  return false;
}

/**
 * Cordis plugin entry point.
 * @param {import('@deepseek-ai/cordis').Context} ctx
 * @param {Record<string, unknown>} [rawConfig]
 */
export function apply(ctx, rawConfig) {
  const config = normalizeConfig(rawConfig);
  if (!config.enabled) return;

  const logger = ctx.logger ?? console;
  const debug = (...args) => {
    if (config.verbose) logger.info?.("[dsh-workspace-sync]", ...args);
  };

  const tracker = new RelocationTracker({
    storagePath: config.storagePath,
    logger,
  });
  tracker.loadSync();

  let triggerWorkspaceReconcile = () => Promise.resolve();

  // Observe any already-open live sessions on plugin startup.
  try {
    const sessions = ctx.get?.("sessions");
    if (sessions && typeof sessions.list === "function") {
      for (const session of sessions.list()) {
        if (session?.header?.cwd) {
          tracker.observeSync(session.header.cwd);
        }
      }
    }
  } catch { /* ignore */ }

  // 1. WorkingDirectoryService integration (fixes `working-directory: directory does not exist`).
  if (config.followWorkingDirectory) {
    ctx.inject(["workingDirectory"], (scope) => {
      const wd = scope.workingDirectory;
      if (!wd) return;

      const origEnsure = wd.ensure;
      const origSet = wd.set;

      wd.set = async function patchedSet(agent, targetPath, signal) {
        const result = await origSet.call(this, agent, targetPath, signal);
        await tracker.observe(result);
        return result;
      };

      wd.ensure = async function patchedEnsure(agent, signal) {
        const current = wd.get(agent.session);
        const headerCwd = agent.session?.header?.cwd;

        if (await directoryExists(scope, current, signal)) {
          await tracker.observe(current);
          return await origEnsure.call(this, agent, signal);
        }

        const relocated = (await tracker.findRelocated(current))
          ?? (headerCwd && headerCwd !== current ? await tracker.findRelocated(headerCwd) : undefined);

        if (relocated !== undefined) {
          debug(`relocated session '${agent.session?.id}' cwd: '${current}' -> '${relocated}'`);
          if (agent.session?.header && (headerCwd === current || !(await directoryExists(scope, headerCwd, signal)))) {
            try {
              agent.session.header.cwd = relocated;
            } catch {
              // SessionHeader may be frozen in-memory; WorkingDirectoryService.set still commits the durable move.
            }
          }
          const committed = await origSet.call(this, agent, relocated, signal);
          await tracker.observe(committed);
          void triggerWorkspaceReconcile().catch(() => {});
          return committed;
        }

        return await origEnsure.call(this, agent, signal);
      };

      scope.on("system-prompt/assemble", async (_assembly, context, next) => {
        if (context?.agent?.session) {
          const current = wd.get(context.agent.session);
          if (await directoryExists(scope, current, context.signal)) {
            await tracker.observe(current);
          }
        }
        return next();
      }, { prepend: true });

      scope.effect(() => () => {
        wd.ensure = origEnsure;
        wd.set = origSet;
      }, "dsh-workspace-sync.workingDirectory");
    });
  }

  // 2. WorkspaceRegistry integration (updates workspace path, default title, and keeps session membership).
  if (config.followWorkspaceRegistry) {
    ctx.inject(["workspaceRegistry"], (scope) => {
      const reg = scope.workspaceRegistry;
      if (!reg) return;

      let disposed = false;
      let reconcileQueue = Promise.resolve();
      let watchDebounceTimer;
      /** @type {Map<string, fs.FSWatcher>} */
      const parentWatchers = new Map();

      const closeWatchers = () => {
        if (watchDebounceTimer !== undefined) {
          clearTimeout(watchDebounceTimer);
          watchDebounceTimer = undefined;
        }
        for (const watcher of parentWatchers.values()) {
          try { watcher.close(); } catch { /* ignore */ }
        }
        parentWatchers.clear();
      };

      const scheduleReconcile = () => {
        if (disposed) return;
        if (watchDebounceTimer !== undefined) {
          clearTimeout(watchDebounceTimer);
        }
        watchDebounceTimer = setTimeout(() => {
          watchDebounceTimer = undefined;
          void reconcileWorkspaces().catch((error) => {
            logger.warn?.(`[dsh-workspace-sync] watcher reconcile failed: ${String(error)}`);
          });
        }, config.watchDebounceMs);
        watchDebounceTimer.unref?.();
      };

      const syncParentWatchers = () => {
        if (disposed || !config.watchParentDirs) return;
        const desiredParents = new Set();
        for (const entity of reg.list()) {
          const parent = path.dirname(entity.path);
          if (parent && parent !== entity.path) {
            desiredParents.add(parent);
          }
        }
        for (const [parent, watcher] of parentWatchers.entries()) {
          if (!desiredParents.has(parent)) {
            try { watcher.close(); } catch { /* ignore */ }
            parentWatchers.delete(parent);
          }
        }
        for (const parent of desiredParents) {
          if (parentWatchers.has(parent)) continue;
          try {
            if (!fs.existsSync(parent)) continue;
            const watcher = fs.watch(parent, { persistent: false }, () => {
              scheduleReconcile();
            });
            watcher.on("error", () => {
              try { watcher.close(); } catch { /* ignore */ }
              parentWatchers.delete(parent);
            });
            parentWatchers.set(parent, watcher);
          } catch (error) {
            debug(`cannot watch parent directory '${parent}': ${String(error)}`);
          }
        }
      };

      const reconcileWorkspaces = () => {
        const run = reconcileQueue.then(async () => {
          if (disposed) return;
          for (const entity of reg.list()) {
            if (disposed) return;
            const status = await entity.status();
            if (status === "ok") {
              await tracker.observe(entity.path);
              continue;
            }
            const oldPath = entity.path;
            const relocated = await tracker.findRelocated(oldPath);
            if (relocated && relocated !== oldPath) {
              const moved = await relocateWorkspaceEntity(reg, entity, oldPath, relocated, logger);
              if (moved) {
                debug(`relocated workspace '${entity.id}': '${oldPath}' -> '${relocated}'`);
              }
            }
          }
          syncParentWatchers();
        });
        reconcileQueue = run.then(() => {}, () => {});
        return run;
      };

      triggerWorkspaceReconcile = reconcileWorkspaces;

      const origCreate = reg.create;
      const origResolveByPath = reg.resolveByPath;

      reg.create = async function patchedCreate(targetPath, title) {
        await reconcileWorkspaces();
        const workspace = await origCreate.call(this, targetPath, title);
        if (workspace?.path) {
          await tracker.observe(workspace.path);
          syncParentWatchers();
        }
        return workspace;
      };

      reg.resolveByPath = async function patchedResolveByPath(targetPath) {
        await reconcileWorkspaces();
        return await origResolveByPath.call(this, targetPath);
      };

      // Initial startup reconciliation (handles renames performed while DSH was closed).
      void reconcileWorkspaces().catch((error) => {
        logger.warn?.(`[dsh-workspace-sync] startup workspace reconciliation failed: ${String(error)}`);
      });

      scope.effect(() => () => {
        disposed = true;
        triggerWorkspaceReconcile = () => Promise.resolve();
        reg.create = origCreate;
        reg.resolveByPath = origResolveByPath;
        closeWatchers();
      }, "dsh-workspace-sync.workspaceRegistry");
    });
  }

  // 3. WorkspaceFiles lookup override (fixes sidebar file tree & previews after folder rename).
  if (config.syncWorkspaceFiles) {
    ctx.inject(["sessions", "typert"], (scope) => {
      const lookups = scope.typert?.lookups;
      if (!lookups || typeof lookups.configure !== "function") return;

      try {
        lookups.configure("workspaceFileScope", async (sessionId) => {
          const live = scope.sessions.get(sessionId);
          const stored = live === undefined
            ? await scope.get?.("sessionPersistence")?.stat?.(sessionId)
            : undefined;
          const header = live?.header ?? stored?.header;
          if (header === undefined) return undefined;

          const wdPath = live ? scope.get?.("workingDirectory")?.get?.(live) : undefined;
          const fallbackRoot = scope.get?.("sandboxPolicy")?.workspaceRoot;
          const candidateRoot = wdPath ?? header.cwd ?? fallbackRoot;
          if (!candidateRoot) return undefined;

          const effectiveRoot = (await tracker.findRelocated(candidateRoot)) ?? candidateRoot;
          return {
            sessionId,
            workspaceRoot: effectiveRoot,
          };
        });
      } catch (error) {
        logger.warn?.(`[dsh-workspace-sync] could not configure workspaceFileScope lookup: ${String(error)}`);
      }
    });
  }

  // 4. SandboxPolicyService integration (updates workspace-write root after folder rename).
  if (config.syncSandboxPolicy) {
    ctx.inject(["sandboxPolicy"], (scope) => {
      const policy = scope.sandboxPolicy;
      if (!policy || typeof policy.resolve !== "function") return;

      const origResolve = policy.resolve;

      policy.resolve = function patchedResolve(request = {}) {
        const resolved = origResolve.call(this, request);
        const session = request?.session;
        const wdPath = session ? scope.get?.("workingDirectory")?.get?.(session) : undefined;
        const candidateRoot = wdPath ?? resolved.workspaceRoot;
        const effectiveRoot = tracker.resolveKnownSync(candidateRoot);
        if (effectiveRoot === resolved.workspaceRoot) return resolved;
        return {
          ...resolved,
          workspaceRoot: effectiveRoot,
        };
      };

      scope.effect(() => () => {
        policy.resolve = origResolve;
      }, "dsh-workspace-sync.sandboxPolicy");
    });
  }
}

export default { name, apply };
