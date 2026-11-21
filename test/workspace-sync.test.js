import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { RelocationTracker } from "../lib/identity.js";
import { apply as applyPlugin } from "../lib/index.js";
import {
  installToProfiles,
  statusOfProfiles,
  uninstallFromProfiles,
} from "../lib/installer.js";

/**
 * Minimal Cordis-like Context harness supporting `inject`, `on`, `effect`, and `get`
 * matching the subset used by `dsh-workspace-sync`.
 */
function createMockContext(services = {}) {
  const cleanups = [];
  const listeners = new Map();
  const injectors = [];
  const state = { ...services };

  const ctx = {
    logger: {
      info() {},
      warn() {},
      error() {},
    },
    get(key) {
      return state[key];
    },
    setService(key, value) {
      state[key] = value;
      runInjectors();
    },
    inject(deps, callback) {
      const entry = { deps, callback, ran: false };
      injectors.push(entry);
      runInjectors();
    },
    on(eventName, handler, options = {}) {
      const list = listeners.get(eventName) ?? [];
      if (options.prepend) list.unshift(handler);
      else list.push(handler);
      listeners.set(eventName, list);
      return () => {
        const current = listeners.get(eventName) ?? [];
        listeners.set(eventName, current.filter((h) => h !== handler));
      };
    },
    async emitWaterfall(eventName, ...args) {
      const list = [...(listeners.get(eventName) ?? [])];
      let idx = 0;
      const next = async () => {
        if (idx >= list.length) return args[0];
        const fn = list[idx++];
        return await fn(...args, next);
      };
      return await next();
    },
    effect(factory) {
      const dispose = factory();
      if (typeof dispose === "function") cleanups.push(dispose);
      return dispose;
    },
    async dispose() {
      for (const fn of cleanups.splice(0).reverse()) {
        await fn();
      }
    },
  };

  for (const [k, v] of Object.entries(services)) {
    ctx[k] = v;
  }

  function runInjectors() {
    for (const entry of injectors) {
      if (entry.ran) continue;
      if (entry.deps.every((d) => state[d] !== undefined)) {
        entry.ran = true;
        const scope = Object.create(ctx);
        for (const d of entry.deps) scope[d] = state[d];
        entry.callback(scope);
      }
    }
  }

  return ctx;
}

/**
 * Create a faithful DSH-compatible WorkingDirectoryService mock where
 * `header.cwd` is frozen/immutable and `ensure()` throws `directory does not exist`
 * when the tracked directory disappears.
 */
function createMockWorkingDirectoryService() {
  const projections = new Map();
  const service = {
    defaultDirectory: os.tmpdir(),
    get(session) {
      return projections.get(session.id) ?? session.header.cwd ?? this.defaultDirectory;
    },
    async ensure(agent) {
      const current = this.get(agent.session);
      if (fs.existsSync(current) && fs.statSync(current).isDirectory()) {
        return current;
      }
      const original = agent.session.header.cwd ?? this.defaultDirectory;
      if (!fs.existsSync(original) || !fs.statSync(original).isDirectory()) {
        throw new Error(`working-directory: directory does not exist: ${JSON.stringify(original)}`);
      }
      projections.set(agent.session.id, original);
      return original;
    },
    async set(agent, targetPath) {
      const canonical = await fs.promises.realpath(targetPath);
      if (!fs.statSync(canonical).isDirectory()) {
        throw new Error(`working-directory: directory does not exist: ${JSON.stringify(targetPath)}`);
      }
      projections.set(agent.session.id, canonical);
      return canonical;
    },
  };
  return service;
}

/**
 * Create a faithful DSH-compatible WorkspaceRegistry mock enforcing
 * `candidateMatches` pruning inside `entity.mutate` and canonical path uniqueness.
 */
function createMockWorkspaceRegistry(initialWorkspaces = []) {
  const records = new Map();
  const entities = new Map();
  const sessionPaths = new Map();
  const missingSessionPaths = new Set();
  const invalidSessionPaths = new Map();

  const host = {
    candidateMatches: (id, targetPath) =>
      sessionPaths.get(id) === targetPath || missingSessionPaths.has(id),
    rememberSessionPath: (id, targetPath) => {
      sessionPaths.set(id, targetPath);
      missingSessionPaths.delete(id);
      invalidSessionPaths.delete(id);
    },
  };

  function makeEntity(id, initialRecord) {
    const entity = {
      id,
      record: initialRecord,
      get path() { return this.record.path; },
      get title() { return this.record.title; },
      get sessionIds() {
        return this.record.sessionIds.filter((sid) => host.candidateMatches(sid, this.record.path));
      },
      async status() {
        try {
          return (await fs.promises.stat(this.record.path)).isDirectory() ? "ok" : "missing-dir";
        } catch {
          return "missing-dir";
        }
      },
      async setTitle(title) {
        await this.mutate((rec) => ({ ...rec, title }));
      },
      async mutate(fn) {
        const current = records.get(id);
        const changed = fn(current);
        // Mirror WorkspaceEntity.mutate: prune candidates failing candidateMatches!
        const sessionIds = changed.sessionIds.filter((sid) => host.candidateMatches(sid, changed.path));
        const next = { ...changed, sessionIds, updatedAt: new Date().toISOString() };
        records.set(id, next);
        this.record = next;
      },
    };
    return entity;
  }

  for (const item of initialWorkspaces) {
    const rec = {
      path: item.path,
      title: item.title ?? path.basename(item.path),
      sessionIds: [...(item.sessionIds ?? [])],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    records.set(item.id, rec);
    entities.set(item.id, makeEntity(item.id, rec));
    for (const sid of rec.sessionIds) {
      if (item.missingOnBoot) missingSessionPaths.add(sid);
      else sessionPaths.set(sid, item.path);
    }
  }

  return {
    host,
    sessionPaths,
    missingSessionPaths,
    invalidSessionPaths,
    list() {
      return [...entities.values()];
    },
    get(id) {
      return entities.get(id);
    },
    async resolveByPath(targetPath) {
      const canonical = await fs.promises.realpath(targetPath);
      for (const entity of entities.values()) {
        if (entity.path === canonical) return entity;
      }
      return undefined;
    },
    async create(targetPath, title) {
      const canonical = await fs.promises.realpath(targetPath);
      const existing = await this.resolveByPath(canonical);
      if (existing) return existing;
      const id = `ws-${entities.size + 1}`;
      const rec = {
        path: canonical,
        title: title ?? path.basename(canonical),
        sessionIds: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      records.set(id, rec);
      const entity = makeEntity(id, rec);
      entities.set(id, entity);
      return entity;
    },
  };
}

test("RelocationTracker tracks dev:ino, resolves transitive renames, and persists across restarts", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-tracker-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const storagePath = path.join(root, "state", "workspace-sync.json");
  const dirA = await fs.promises.realpath(await fs.promises.mkdir(path.join(root, "proj-a"), { recursive: true }) || path.join(root, "proj-a"));
  const dirB = path.join(root, "proj-b");
  const dirC = path.join(root, "proj-c");

  const tracker1 = new RelocationTracker({ storagePath });
  const observed = await tracker1.observe(dirA);
  assert.ok(observed?.identity, "directory should yield a valid dev:ino identity");
  assert.equal(observed.canonicalPath, dirA);

  // Rename proj-a -> proj-b
  await fs.promises.rename(dirA, dirB);
  const foundB = await tracker1.findRelocated(dirA);
  const realB = await fs.promises.realpath(dirB);
  assert.equal(foundB, realB);
  assert.equal(tracker1.resolveKnownSync(dirA), realB);

  // Rename proj-b -> proj-c while offline, then reload in a fresh tracker
  await fs.promises.rename(dirB, dirC);
  const realC = await fs.promises.realpath(dirC);
  const tracker2 = new RelocationTracker({ storagePath });
  tracker2.loadSync();

  assert.equal(await tracker2.findRelocated(dirB), realC);
  assert.equal(await tracker2.findRelocated(dirA), realC);
  assert.equal(tracker2.resolveKnownSync(dirA), realC);
});

test("WorkingDirectoryService hook follows renamed directory even with frozen session header.cwd", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-wd-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const storagePath = path.join(root, "workspace-sync.json");
  const originDir = path.join(root, "untitled-project");
  const renamedDir = path.join(root, "renamed-project");
  await fs.promises.mkdir(originDir);
  const realOrigin = await fs.promises.realpath(originDir);

  const wd = createMockWorkingDirectoryService();
  const ctx = createMockContext({ workingDirectory: wd });
  applyPlugin(ctx, { storagePath, watchParentDirs: false });
  t.after(() => ctx.dispose());

  const session = {
    id: "sess-1",
    header: Object.freeze({ id: "sess-1", cwd: realOrigin }),
  };
  const agent = { session, ctx: { fiber: { assertActive() {} } } };

  // First ensure observes originDir
  assert.equal(await wd.ensure(agent), realOrigin);

  // Rename project externally
  await fs.promises.rename(realOrigin, renamedDir);
  const realRenamed = await fs.promises.realpath(renamedDir);

  // Without plugin this throws `working-directory: directory does not exist`;
  // with plugin it follows the inode to `renamedDir`!
  const ensured = await wd.ensure(agent);
  assert.equal(ensured, realRenamed);
  assert.equal(wd.get(session), realRenamed);
});

test("workingDirectory scope must not bare-read `fs` (cordis inject-guard regression)", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-guard-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const wd = createMockWorkingDirectoryService();
  const ctx = createMockContext({ workingDirectory: wd });
  // Simulate the real cordis proxy guard: the sub-context created by
  // `ctx.inject(["workingDirectory"], ...)` only declared `workingDirectory`,
  // so a bare `scope.fs` property read throws instead of returning undefined.
  Object.defineProperty(ctx, "fs", {
    get() {
      throw new Error('cannot get property "fs" without inject');
    },
    configurable: true,
  });
  applyPlugin(ctx, { storagePath: path.join(root, "workspace-sync.json"), watchParentDirs: false });
  t.after(() => ctx.dispose());

  const session = {
    id: "sess-guard",
    header: Object.freeze({ id: "sess-guard", cwd: root }),
  };
  const agent = { session, ctx: { fiber: { assertActive() {} } } };

  // Before the fix, the patched wd.ensure threw
  // `cannot get property "fs" without inject` on the very first turn.
  assert.equal(await wd.ensure(agent), root);

  // The prepended system-prompt/assemble hook must survive the same guard.
  await ctx.emitWaterfall("system-prompt/assemble", {}, { agent, signal: undefined });
});

test("WorkspaceRegistry hook preserves accounted sessions, updates path/default title, and preserves custom title", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-reg-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const storagePath = path.join(root, "workspace-sync.json");
  const dir1 = path.join(root, "alpha-old");
  const dir1New = path.join(root, "alpha-new");
  const dir2 = path.join(root, "beta-old");
  const dir2New = path.join(root, "beta-new");
  await fs.promises.mkdir(dir1);
  await fs.promises.mkdir(dir2);
  const realDir1 = await fs.promises.realpath(dir1);
  const realDir2 = await fs.promises.realpath(dir2);

  const reg = createMockWorkspaceRegistry([
    { id: "ws-1", path: realDir1, title: "alpha-old", sessionIds: ["s-1", "s-2"] },
    { id: "ws-2", path: realDir2, title: "Custom Label", sessionIds: ["s-3"] },
  ]);

  const ctx = createMockContext({ workspaceRegistry: reg });
  applyPlugin(ctx, { storagePath, watchParentDirs: true, watchDebounceMs: 50 });
  t.after(() => ctx.dispose());

  // Wait for startup reconciliation & watcher installation
  await delay(80);

  // Rename both workspaces externally
  await fs.promises.rename(realDir1, dir1New);
  await fs.promises.rename(realDir2, dir2New);
  const realDir1New = await fs.promises.realpath(dir1New);
  const realDir2New = await fs.promises.realpath(dir2New);

  // Trigger reconciliation via resolveByPath / create (deterministic across OS watcher timings)
  const resolved = await reg.resolveByPath(realDir1New);
  assert.ok(resolved, "resolveByPath should locate the renamed workspace");
  assert.equal(resolved.id, "ws-1");
  assert.equal(resolved.path, realDir1New);
  assert.equal(resolved.title, "alpha-new", "default title should track the renamed folder name");
  assert.deepEqual(resolved.sessionIds, ["s-1", "s-2"], "accounted sessions must not be pruned");

  // Re-adding the renamed folder should reuse the existing workspace instead of creating a duplicate
  const created = await reg.create(realDir1New);
  assert.equal(created.id, "ws-1");
  assert.equal(reg.list().length, 2);

  // Custom title on ws-2 should be preserved while its path updates
  const ws2 = reg.get("ws-2");
  assert.equal(ws2.path, realDir2New);
  assert.equal(ws2.title, "Custom Label");
  assert.deepEqual(ws2.sessionIds, ["s-3"]);
});

test("workspaceFileScope lookup and sandboxPolicy resolve follow renamed directories", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-scope-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const storagePath = path.join(root, "workspace-sync.json");
  const projOld = path.join(root, "proj-old");
  const projNew = path.join(root, "proj-new");
  await fs.promises.mkdir(projOld);
  const realOld = await fs.promises.realpath(projOld);

  const session = {
    id: "sess-lookup",
    header: Object.freeze({ id: "sess-lookup", cwd: realOld }),
  };

  let configuredResolver = null;
  const typert = {
    lookups: {
      configure(key, resolver) {
        if (key === "workspaceFileScope") configuredResolver = resolver;
        return () => { configuredResolver = null; };
      },
    },
  };
  const sessions = {
    list: () => [session],
    get: (id) => (id === session.id ? session : undefined),
  };
  const sandboxPolicy = {
    workspaceRoot: root,
    resolve(req = {}) {
      return {
        mode: "workspace-write",
        workspaceRoot: req.session?.header?.cwd ?? this.workspaceRoot,
      };
    },
  };

  const ctx = createMockContext({ typert, sessions, sandboxPolicy });
  applyPlugin(ctx, { storagePath, watchParentDirs: false });
  t.after(() => ctx.dispose());

  // Rename project folder externally
  await fs.promises.rename(realOld, projNew);
  const realNew = await fs.promises.realpath(projNew);

  assert.ok(configuredResolver, "workspaceFileScope lookup resolver should be configured");
  const scopeResult = await configuredResolver(session.id);
  assert.deepEqual(scopeResult, {
    sessionId: session.id,
    workspaceRoot: realNew,
  });

  const policyResult = sandboxPolicy.resolve({ session });
  assert.equal(policyResult.workspaceRoot, realNew);
});

test("installer registers, inspects, and uninstalls plugin cleanly in a temp DSH_HOME", async (t) => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), "dsh-ws-sync-install-"));
  t.after(async () => {
    await fs.promises.rm(root, { recursive: true, force: true });
  });

  const desktopProfile = path.join(root, "profiles", "desktop");
  await fs.promises.mkdir(desktopProfile, { recursive: true });
  await fs.promises.writeFile(
    path.join(desktopProfile, "package.json"),
    JSON.stringify({
      name: "dsh-profile-desktop",
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base"] } },
    }, null, 2),
  );

  const installed = installToProfiles({ dshHome: root });
  assert.equal(installed.results.length, 1);
  assert.equal(installed.results[0].ok, true);

  const st1 = statusOfProfiles({ dshHome: root });
  assert.equal(st1.profiles[0].inBundles, true);
  assert.equal(st1.profiles[0].moduleLinked, true);

  const uninstalled = uninstallFromProfiles({ dshHome: root });
  assert.equal(uninstalled.results[0].ok, true);

  const st2 = statusOfProfiles({ dshHome: root });
  assert.equal(st2.profiles[0].inBundles, false);
  assert.equal(st2.profiles[0].moduleLinked, false);
});
