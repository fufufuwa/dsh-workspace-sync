# OpenAI Codex GitHub Issue Draft

- **Target repository:** `https://github.com/openai/codex/issues/new`
- **Note:** Per `docs/contributing.md` in `openai/codex`, the repository does not accept external Pull Requests and asks contributors to submit detailed bug reports with reproduction steps, root-cause analysis, and proposed approaches in GitHub Issues.

---

## 中文说明（提交前参考）

下面英文部分是一份可直接复制粘贴到 `openai/codex` Issues 页面提交的完整 Bug 报告，核心点包括：
1. **现象**：当本地项目文件夹被重命名或移动后，Codex Desktop/CLI 中的旧会话不报 `cwd` 缺失错误，反而会在旧路径下重新创建出一个包含 `.git` / `.codex` / `.agents` 等空目录的“幽灵旧文件夹”，导致工作区状态分裂。
2. **精准源码根因**（已核对 `openai/codex` `main` 分支源码）：
   - `codex-rs/windows-sandbox-rs/src/allow.rs` 虽然在计算常规保护子目录时加了 `if p.exists()` 检查；
   - 但 `codex-rs/windows-sandbox-rs/src/setup_provisioning.rs` 在第 1109 行跳过不存在的 `write_roots` 之后，却在 **第 1213–1216 行** 对 `payload.deny_write_paths` 无条件调用 `std::fs::create_dir_all(path)`；
   - `codex-rs/windows-sandbox-rs/src/spawn_prep.rs` **第 285–293 行** 对 `additional_deny_write_paths` 同样无条件调用 `std::fs::create_dir_all(path)`；
   - `codex-rs/windows-sandbox-rs/src/deny_read_acl.rs` **第 464–467 行** 对 `deny_read` 路径也直接调用 `std::fs::create_dir_all(&path)`。
   - 当旧会话带着已改名消失的 `cwd` / `workspace_roots` 刷新或执行命令时，`create_dir_all` 会把整个已不存在的旧项目根目录树静默递归重建出来。
3. **修复建议与补丁草案**：在执行 `create_dir_all` 物化 carveout 前校验该路径所属的 `write_root`（或最近父级根目录）确实存在，若 `cwd`/工作区本身已缺失则返回结构化错误或跳过，绝不通过 `create_dir_all` 重建已消失的工作区目录。

---

## Copy-Paste Issue Content (English)

### Title

`[Bug][Windows Sandbox] Stale/renamed workspace directory gets silently recreated via create_dir_all on deny_write_paths / deny_read_paths instead of failing cleanly`

### Body

```markdown
### Summary

When a user renames or moves a local project folder outside Codex (for example `C:\Projects\my-app` -> `C:\Projects\my-app-v2`), existing threads/tasks retain the old `cwd` / `workspace_roots`. Unlike tools that fail fast with a missing-directory error, Codex on Windows often **does not fail**—instead, it silently **recreates the old deleted/renamed project folder** on disk (frequently containing empty `.git` / `.codex` / `.agents` or carveout directories).

This splits the user's project into two directories (the real renamed folder and a resurrected ghost folder at the old path) and causes commands or patches to run inside the wrong directory.

### Related Issues

- #41776 (`[Windows][Codex Desktop] Existing task retains deleted workspace path after project folder is moved`)
- #32324 / #32872 (Windows sandbox helper materializing empty `.git` directories)
- #52022 (`apply_deny_read_acls` materializing missing deny paths via `create_dir_all`)
- #19838 / #20934 / #26836 / #28289 (Project folder rename leaves stale paths)

### Steps to Reproduce

1. Open a project directory (e.g., `E:\workspace\old-name`) in Codex Desktop / Codex CLI with Windows sandbox enabled (`workspace-write`).
2. Run at least one command or task so the thread persists `cwd = E:\workspace\old-name`.
3. In Windows Explorer or a separate terminal, rename the directory to `E:\workspace\new-name` (so `E:\workspace\old-name` no longer exists).
4. Return to the existing Codex thread and trigger a turn that invokes sandbox setup / command execution or filesystem overrides (`deny_write_paths` / `deny_read_paths`).
5. **Observed:** `E:\workspace\old-name` reappears on disk as a newly created directory tree instead of failing with a clear "workspace directory does not exist" error or prompting to rebind the renamed folder.

### Expected Behavior

1. Sandbox provisioning/setup must **never** call `std::fs::create_dir_all` to materialize a directory whose enclosing `cwd` / writable root does not exist on disk.
2. If the thread's `cwd` or `workspace_roots` no longer exists (e.g. renamed or moved externally), Codex should fail cleanly with a structured missing-cwd error (and optionally allow rebinding the project folder / tracking directory identity) rather than recreating the stale path.

### Root-Cause Analysis (`main`)

In `codex-rs/windows-sandbox-rs`, `compute_allow_paths_for_permissions` (`src/allow.rs`) guards `allow` and `deny` paths with `if p.exists()`, and `workspace_acl.rs` (`protect_workspace_subdir`) guards `.codex` / `.agents` with `if path.is_dir()`. However, three other provisioning paths still unconditionally call `std::fs::create_dir_all` on paths derived from stale `cwd` / `workspace_roots`:

1. **`codex-rs/windows-sandbox-rs/src/setup_provisioning.rs` (lines 1105–1115 vs. lines 1199–1216):**
   - When iterating `&payload.write_roots` (line 1109), the loop explicitly checks:
     ```rust
     if !root.exists() {
         log_line(
             log,
             &format!("write root {} missing; skipping", root.display()),
         )?;
         continue;
     }
     ```
   - However, when iterating `&payload.deny_write_paths` (lines 1213–1216), it does **not** check whether the enclosing `write_root` (or `payload.command_cwd`) exists or was skipped above:
     ```rust
     if !path.exists() {
         std::fs::create_dir_all(path)
             .with_context(|| format!("failed to create deny-write path {}", path.display()))?;
     }
     ```
   - When `path` is under a stale/renamed workspace (e.g., `E:\workspace\old-name\.git` or a carveout under `old-name`), `create_dir_all(path)` recursively recreates `E:\workspace\old-name`.

2. **`codex-rs/windows-sandbox-rs/src/spawn_prep.rs` (`apply_legacy_session_acl_rules`, lines 285–293):**
   ```rust
   for path in additional_deny_write_paths {
       // Explicit carveouts must exist before the command starts so the
       // sandbox cannot create them under a writable parent first.
       if !path.exists() {
           std::fs::create_dir_all(path)
               .with_context(|| format!("create deny-write path {}", path.display()))?;
       }
       deny.insert(path.clone());
   }
   ```
   If `additional_deny_write_paths` references a subpath under a renamed/deleted workspace, `create_dir_all` recreates the missing workspace root.

3. **`codex-rs/windows-sandbox-rs/src/deny_read_acl.rs` (`apply_deny_read_acls`, lines 462–470):**
   ```rust
   if !path.exists() {
       std::fs::create_dir_all(&path)
           .with_context(|| format!("create deny-read path {}", path.display()))?;
   }
   ```
   A missing `deny_read` path inside a moved/renamed directory likewise triggers `create_dir_all`, recreating the old parent tree.

### Proposed Fix

1. **Validate `command_cwd` / enclosing writable roots before materializing any deny carveout:**
   - Only materialize a missing `deny_write_path` if it lies inside an **existing** writable root (`allow` / `existing_write_roots`). If no existing writable root contains `path`, skip materializing it (since a sandboxed process cannot write under a non-existent root anyway, or fail early if `command_cwd` itself does not exist).
   - For `deny_read` paths under `apply_deny_read_acls`, do not call `create_dir_all` when the enclosing workspace root / parent workspace does not exist (or avoid creating arbitrary directory hierarchies on missing paths).

Illustrative patch for `setup_provisioning.rs` and `spawn_prep.rs`:

```rust
// Only materialize missing deny-write carveouts when an existing write_root covers them.
let has_existing_parent_root = existing_write_roots
    .iter()
    .any(|root| workspace_write_root_contains_path(root, path));

if !path.exists() {
    if !has_existing_parent_root {
        log_line(
            log,
            &format!("deny-write path {} has no existing writable root; skipping", path.display()),
        )?;
        continue;
    }
    std::fs::create_dir_all(path)
        .with_context(|| format!("failed to create deny-write path {}", path.display()))?;
}
```

2. **Fail fast when `command_cwd` is missing** before invoking sandbox setup/spawn, and provide a Desktop/CLI recovery path (either UI re-attach or optional inode/file-ID relocation tracking) when a project folder is renamed.
```
