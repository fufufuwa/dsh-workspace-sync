# dsh-workspace-sync

Automatically track and synchronize local project/workspace directory renames in **DeepSeek Harness (`dsh`)** using filesystem inode identity (`dev:ino`).

English | [简体中文](#简体中文)

## Problem Solved

In DeepSeek Harness (`dsh`), renaming or moving a local project directory on disk breaks 4 independent layers because absolute paths are bound at creation time:

1. **`WorkingDirectoryService` (`@deepseek-ai/dsh-working-directory`)**: `session.header.cwd` is immutable; once the folder is renamed, `ensure()` throws `working-directory: directory does not exist` on every subsequent turn.
2. **`WorkspaceRegistry` (`@deepseek-ai/dsh-workspace`)**: `WorkspaceRecord.path` stays on the old path, sidebar previews break, re-adding the renamed folder creates a duplicate empty workspace, and mutating a workspace whose `sessionPaths` still point to the old path prunes existing sessions.
3. **`WorkspaceFiles` (`@deepseek-ai/dsh-api-workspace-files`)**: `workspaceFileScope` Typert lookup resolves `header.cwd`, breaking file tree & document preview after rename.
4. **`SandboxPolicyService` (`@deepseek-ai/dsh-sandbox-policy`)**: `resolve()` returns `session.header.cwd`, locking `workspace-write` permissions to the obsolete path.

## How `dsh-workspace-sync` Works

Without modifying DSH core source files, this plugin hooks into all four layers cleanly via Cordis:

- **Persistent Identity Map (`$DSH_HOME/storages/workspace-sync.json`)**: Observes directory `dev:ino` (via `fs.stat(..., { bigint: true })`, falling back to `birthtimeNs` if `ino` is 0). Supports both live renames and offline renames across DSH restarts, as well as transitive/nested renames.
- **Working Directory Follow**: Wraps `workingDirectory.ensure` & `workingDirectory.set` to locate renamed directories by `dev:ino` and migrate the session's active working directory seamlessly.
- **Workspace Registry Sync + `fs.watch`**: Watches workspace parent directories (non-persistent, debounced) and reconciles on startup and before `create` / `resolveByPath`, updating `WorkspaceEntity` path & default title while preserving custom titles and all `sessionIds`.
- **File View & Sandbox Sync**: Configures the official `workspaceFileScope` Typert lookup and wraps `sandboxPolicy.resolve()` so file previews and `workspace-write` boundaries follow the renamed directory immediately.

## Installation & Usage

```bash
# Check DSH profiles status
node bin/dsh-workspace-sync.js status

# Link and enable in all local DSH profiles (~/.dsh/profiles/*)
node bin/dsh-workspace-sync.js install

# Uninstall from local DSH profiles
node bin/dsh-workspace-sync.js uninstall
```

Restart DeepSeek Harness (Desktop or Web) after running `install`.

## Testing

```bash
node --test test/workspace-sync.test.js
```

## Codex Issue Draft

See [CODEX_ISSUE.md](./CODEX_ISSUE.md) for the root-cause analysis and ready-to-submit GitHub Issue for `openai/codex` regarding its directory-recreation behavior (`std::fs::create_dir_all` on stale `deny_write_paths` / `deny_read_paths`).

---

## 简体中文

为 **DeepSeek Harness (`dsh`)** 提供本地项目文件夹重命名自动同步插件：

- **自动识别改名目录**：通过文件系统底层 `dev:ino` 唯一标识（持久化保存在 `$DSH_HOME/storages/workspace-sync.json`），支持**运行中改名**与**关闭重启后改名**。
- **全链路四层同步**：
  1. **会话工作目录**：拦截 `workingDirectory.ensure()`，自动跟随改名后的新路径，彻底消除 `working-directory: directory does not exist` 报错卡死。
  2. **工作区列表与会话归属**：监听工作区父目录变更并在启动/创建前自动对账，同步更新工作区路径及默认标题（保留自定义标题与全部历史 `sessionIds`，不会误删会话或产生重复工作区）。
  3. **右侧文件树与预览**：通过官方 `typert.lookups.configure("workspaceFileScope")` 实时映射到新路径。
  4. **沙箱写权限边界**：同步更新 `sandboxPolicy.resolve()` 返回的 `workspaceRoot`，避免 `workspace-write` 拒绝写入新目录。

### 安装与测试

```powershell
cd "E:\dsh-workspace-sync"
node --test test/workspace-sync.test.js
node bin/dsh-workspace-sync.js status
node bin/dsh-workspace-sync.js install
```

安装后重启 DeepSeek Harness 即可生效。如需卸载可执行 `node bin/dsh-workspace-sync.js uninstall`。
