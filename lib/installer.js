/**
 * Profile discovery and link/bundle registration helpers for `dsh-workspace-sync`.
 * @module dsh-workspace-sync/installer
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDshHome } from "./identity.js";

export const PLUGIN_NAME = "dsh-workspace-sync";

const DEFAULT_PLUGIN_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function writeJsonAtomicSync(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const content = JSON.stringify(data, null, 2) + "\n";
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
 * List profile directories under `$DSH_HOME/profiles` containing a `package.json`.
 * @param {string} [dshHome]
 * @returns {Array<{ name: string, dir: string, manifestPath: string }>}
 */
export function listProfiles(dshHome = resolveDshHome()) {
  const profilesRoot = path.join(dshHome, "profiles");
  let entries;
  try {
    entries = fs.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(profilesRoot, entry.name);
    const manifestPath = path.join(dir, "package.json");
    if (fs.existsSync(manifestPath)) {
      result.push({ name: entry.name, dir, manifestPath });
    }
  }
  return result;
}

/**
 * Inspect installation status of `dsh-workspace-sync` across DSH profiles.
 * @param {object} [options]
 * @param {string} [options.dshHome]
 * @param {string} [options.pluginDir]
 */
export function statusOfProfiles(options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const pluginDir = path.resolve(options.pluginDir ?? DEFAULT_PLUGIN_DIR);
  const profiles = listProfiles(dshHome).map((profile) => {
    const pkg = readJsonSafe(profile.manifestPath) ?? {};
    const bundles = Array.isArray(pkg?.dsh?.profile?.bundles) ? pkg.dsh.profile.bundles : [];
    const deps = pkg?.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    const modulePath = path.join(profile.dir, "node_modules", PLUGIN_NAME);
    let moduleLinked = false;
    let resolvedTarget = null;
    try {
      if (fs.existsSync(modulePath)) {
        resolvedTarget = fs.realpathSync(modulePath);
        moduleLinked = true;
      }
    } catch {
      moduleLinked = false;
    }
    return {
      name: profile.name,
      dir: profile.dir,
      inBundles: bundles.includes(PLUGIN_NAME),
      dependencySpec: typeof deps[PLUGIN_NAME] === "string" ? deps[PLUGIN_NAME] : null,
      moduleLinked,
      resolvedTarget,
    };
  });
  return { dshHome, pluginDir, profiles };
}

/**
 * Install/link `dsh-workspace-sync` into every discovered DSH profile.
 * @param {object} [options]
 * @param {string} [options.dshHome]
 * @param {string} [options.pluginDir]
 */
export function installToProfiles(options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const pluginDir = path.resolve(options.pluginDir ?? DEFAULT_PLUGIN_DIR);
  const profiles = listProfiles(dshHome);
  const results = [];

  for (const profile of profiles) {
    const pkg = readJsonSafe(profile.manifestPath);
    if (!pkg || typeof pkg !== "object") {
      results.push({ name: profile.name, ok: false, reason: "invalid package.json" });
      continue;
    }

    const linkTarget = `link:${pluginDir.replace(/\\/g, "/")}`;
    pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === "object" ? pkg.dependencies : {};
    let manifestChanged = false;

    const modulePath = path.join(profile.dir, "node_modules", PLUGIN_NAME);
    const sameLocation = path.resolve(modulePath) === pluginDir;

    if (!sameLocation && pkg.dependencies[PLUGIN_NAME] !== linkTarget) {
      pkg.dependencies[PLUGIN_NAME] = linkTarget;
      manifestChanged = true;
    }

    pkg.dsh = pkg.dsh && typeof pkg.dsh === "object" ? pkg.dsh : {};
    pkg.dsh.profile = pkg.dsh.profile && typeof pkg.dsh.profile === "object" ? pkg.dsh.profile : {};
    const bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];
    if (!bundles.includes(PLUGIN_NAME)) {
      pkg.dsh.profile.bundles = [...bundles, PLUGIN_NAME];
      manifestChanged = true;
    }

    if (manifestChanged) {
      writeJsonAtomicSync(profile.manifestPath, pkg);
    }

    let linked = sameLocation;
    if (!sameLocation) {
      const modulesDir = path.join(profile.dir, "node_modules");
      fs.mkdirSync(modulesDir, { recursive: true });
      let needsLink = true;
      try {
        const lstat = fs.lstatSync(modulePath);
        if (lstat.isSymbolicLink()) {
          const currentReal = fs.realpathSync(modulePath);
          if (currentReal === fs.realpathSync(pluginDir)) {
            needsLink = false;
            linked = true;
          }
        }
        if (needsLink) {
          fs.rmSync(modulePath, { recursive: true, force: true });
        }
      } catch {
        // Missing modulePath; create link below.
      }
      if (needsLink) {
        const symlinkType = process.platform === "win32" ? "junction" : "dir";
        fs.symlinkSync(pluginDir, modulePath, symlinkType);
        linked = true;
      }
    }

    results.push({
      name: profile.name,
      ok: true,
      manifestChanged,
      linked,
    });
  }

  return { dshHome, pluginDir, results };
}

/**
 * Remove `dsh-workspace-sync` registration and link from all discovered DSH profiles.
 * @param {object} [options]
 * @param {string} [options.dshHome]
 */
export function uninstallFromProfiles(options = {}) {
  const dshHome = resolveDshHome(options.dshHome);
  const profiles = listProfiles(dshHome);
  const results = [];

  for (const profile of profiles) {
    const pkg = readJsonSafe(profile.manifestPath);
    if (!pkg || typeof pkg !== "object") {
      results.push({ name: profile.name, ok: false, reason: "invalid package.json" });
      continue;
    }

    let manifestChanged = false;
    if (pkg.dependencies && Object.hasOwn(pkg.dependencies, PLUGIN_NAME)) {
      delete pkg.dependencies[PLUGIN_NAME];
      manifestChanged = true;
    }
    const bundles = pkg?.dsh?.profile?.bundles;
    if (Array.isArray(bundles) && bundles.includes(PLUGIN_NAME)) {
      pkg.dsh.profile.bundles = bundles.filter((item) => item !== PLUGIN_NAME);
      manifestChanged = true;
    }
    if (manifestChanged) {
      writeJsonAtomicSync(profile.manifestPath, pkg);
    }

    const modulePath = path.join(profile.dir, "node_modules", PLUGIN_NAME);
    let removedLink = false;
    try {
      fs.lstatSync(modulePath);
      fs.rmSync(modulePath, { recursive: true, force: true });
      removedLink = true;
    } catch {
      removedLink = false;
    }

    results.push({
      name: profile.name,
      ok: true,
      manifestChanged,
      removedLink,
    });
  }

  return { dshHome, results };
}
