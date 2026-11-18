/**
 * Safe postinstall hook: ensures `dsh-workspace-sync` is listed in `dsh.profile.bundles`
 * when installed inside a DSH profile, without failing standalone installs.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLUGIN_NAME } from "../lib/installer.js";

if (process.env.DSH_WORKSPACE_SYNC_NO_POSTINSTALL === "1" || process.env.CI === "true") {
  process.exit(0);
}

try {
  const pkgRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const parentDir = path.basename(path.dirname(pkgRoot));
  if (parentDir === "node_modules") {
    const profileDir = path.dirname(path.dirname(pkgRoot));
    const manifestPath = path.join(profileDir, "package.json");
    if (fs.existsSync(manifestPath)) {
      const pkg = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      if (pkg?.dsh?.profile && Array.isArray(pkg.dsh.profile.bundles)) {
        if (!pkg.dsh.profile.bundles.includes(PLUGIN_NAME)) {
          pkg.dsh.profile.bundles.push(PLUGIN_NAME);
          fs.writeFileSync(manifestPath, JSON.stringify(pkg, null, 2) + "\n", "utf8");
        }
      }
    }
  }
} catch {
  // Never fail npm/pnpm install from postinstall metadata sync.
}
