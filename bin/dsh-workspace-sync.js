#!/usr/bin/env node
/**
 * CLI for installing, uninstalling, and checking `dsh-workspace-sync` across DSH profiles.
 */

import {
  installToProfiles,
  statusOfProfiles,
  uninstallFromProfiles,
} from "../lib/installer.js";

const command = (process.argv[2] ?? "status").toLowerCase();

function printHelp() {
  console.log([
    "dsh-workspace-sync — sync renamed local project folders in DeepSeek Harness",
    "",
    "Usage:",
    "  dsh-workspace-sync status      Inspect DSH profiles and installation state",
    "  dsh-workspace-sync install     Link plugin and enable bundle in DSH profiles",
    "  dsh-workspace-sync uninstall   Remove plugin registration and link from profiles",
  ].join("\n"));
}

switch (command) {
  case "status": {
    const status = statusOfProfiles();
    console.log(`DSH_HOME: ${status.dshHome}`);
    console.log(`Plugin:   ${status.pluginDir}`);
    if (status.profiles.length === 0) {
      console.log("Profiles: (none found)");
    } else {
      console.log("Profiles:");
      for (const p of status.profiles) {
        const mark = p.inBundles && p.moduleLinked ? "✓" : "·";
        console.log(
          `  ${mark} ${p.name}: bundles=${p.inBundles}, linked=${p.moduleLinked}`
          + (p.dependencySpec ? `, dep=${p.dependencySpec}` : ""),
        );
      }
    }
    break;
  }
  case "install": {
    const res = installToProfiles();
    console.log(`Installed dsh-workspace-sync into ${res.results.length} profile(s) under ${res.dshHome}:`);
    for (const r of res.results) {
      console.log(`  - ${r.name}: ${r.ok ? `ok (manifestChanged=${r.manifestChanged}, linked=${r.linked})` : r.reason}`);
    }
    console.log("Restart DeepSeek Harness (Web / Desktop) to activate.");
    break;
  }
  case "uninstall": {
    const res = uninstallFromProfiles();
    console.log(`Uninstalled dsh-workspace-sync from ${res.results.length} profile(s) under ${res.dshHome}:`);
    for (const r of res.results) {
      console.log(`  - ${r.name}: ${r.ok ? `ok (manifestChanged=${r.manifestChanged}, removedLink=${r.removedLink})` : r.reason}`);
    }
    break;
  }
  case "-h":
  case "--help":
  case "help":
    printHelp();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    printHelp();
    process.exitCode = 1;
}
