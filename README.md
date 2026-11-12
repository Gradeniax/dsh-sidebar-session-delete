# dsh-sidebar-session-delete

English | [中文](#中文)

Delete any conversation from the left workspace sidebar, with a **trash** in
between so nothing disappears on the first click.

## What it adds

**1. A `Delete conversation` row** in every Session's `⋯` menu, between the
shipped *Archive session* and *Session ID* rows.

**2. A Trash panel**, opened from a trash-can icon in the sidebar's icon rail.

| Where | Command | Effect |
|---|---|---|
| Session `⋯` menu | **Delete conversation** | Moves the conversation to the trash and hides its row. Reversible. |
| Trash panel | **Restore** | Moves it back to its workspace and unhides the row. |
| Trash panel | **Delete forever** | Removes the conversation and its log permanently. |
| Trash panel | **Empty trash** | Permanently removes every trashed conversation. |

Every command that destroys data asks first, naming the conversation. The UI
follows the GUI language (Chinese / English).

## How deletion works

The DSH Session log is append-only and the persistence seam exposes no delete
API — the JSONL backend documents this outright ("Nothing deletes session
files"). So deletion is modelled as two explicit stages:

1. **Trash** — the Session's log directory is *moved* out of the persistence
   root into a sibling trash directory, the Session is archived (which is what
   hides the row), and an entry is recorded in `trash.json`.
2. **Delete forever** — the trashed directory is removed and the Session's
   Workspace slot is dropped. The archive flag is deliberately *kept*, so a
   Session that is still resident in memory cannot reappear as an "Ungrouped"
   row now that its log is gone.

Because stage one is a move, it is fully reversible, and it also takes the log
out of the persistence root so the Host stops indexing it. The trash directory
is deliberately a **sibling** of the Sessions root: the backend scans that root
for project directories, so a trash folder inside it would be re-indexed as
conversations.

## Safety

- **Running Sessions are refused.** A live turn keeps appending, and its open
  log handle must not be yanked.
- **A failed move loses nothing.** Moving is atomic; when it fails the archive
  is rolled back and the row reappears intact.
- **Containment checks.** Every path is verified to sit inside the Sessions or
  trash root before any move or removal; the plugin refuses to load at all if
  the trash root would land inside the Sessions root.
- **Bookkeeping never blocks.** Archive/detach failures after a successful move
  are reported as warnings, not as a failed delete.
- **A deleted conversation stays hidden.** Deleting forever keeps the archive
  flag instead of clearing it. A Session can still be resident in memory after
  its log is gone, and clearing the flag would make exactly that Session
  reappear — detached from every Workspace — under "Ungrouped". The leftover id
  is inert: it can only hide an id that no longer exists.
- **Restore undoes the trashing only.** A conversation archived *before* it was
  trashed stays archived when restored; the trashing you are undoing does not
  silently unarchive something you hid earlier.

## Trash storage

| Path | Contents |
|---|---|
| `$DSH_HOME/sessions-trash/` | Default trash root (beside `$DSH_HOME/sessions`). |
| `…/trash.json` | Manifest: title, cwd, deletion time, warnings per entry. |
| `…/<session-id>/` | The moved log directory, verbatim. |

A missing or damaged manifest degrades to entries without titles instead of
losing the trash, and the panel reconciles the manifest against the directories
actually present, so a hand-copied or hand-deleted folder never desynchronizes
it.

## Install

The package is **not published to npm**, so a bare package name will not
resolve. Install it straight from this repository with the `github:` spec:

```text
github:Gradeniax/dsh-sidebar-session-delete
```

### From the DSH UI or an agent

Open **Plugins → add / install** and paste the spec above, or simply ask the
agent to install it. Both reach the same `install_bundle` operation.

### From the dsh CLI

```bash
dsh plugin --profile <profile> add github:Gradeniax/dsh-sidebar-session-delete
```

### Manually

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add github:Gradeniax/dsh-sidebar-session-delete
```

Then list the bundle in that profile's `package.json`, so the patch it ships is
applied:

```json
{
  "dsh": { "profile": { "bundles": ["dsh-sidebar-session-delete"] } }
}
```

### After installing

Restart DSH. A change to the **Host half** only takes effect after a restart —
Node caches the ES module, and reinstalling runs the patch without reloading
code. A change to the **browser half** appears on the next page load.

Repository: <https://github.com/Gradeniax/dsh-sidebar-session-delete>

## Compatibility

Built and tested against DSH `0.2.1-rc.5` (desktop). It requires these Host
services — `webServer`, `sessionPersistence`, `workspaceRegistry`, `sessions`,
`agents` — and these slots: `sidebar.workspaces.session.menu.item`,
`sidebar.panellist`, `main`, `shell.overlay`, plus `locale` on the Client side.
A deployment that renames or removes any of them leaves the plugin inactive
rather than breaking the UI.

## Configuration

| Field | Default | Meaning |
|---|---|---|
| `root` | `''` | Sessions root. Empty resolves the `sessionPersistence` service's own root, then `$DSH_HOME/sessions`. |
| `trashRoot` | `''` | Trash root. Empty uses a sibling of `root` named `<root>-trash`. Must stay outside `root`. |

```yaml
- id: sidebar-session-delete
  config:
    root: D:\dsh-sessions
    trashRoot: D:\dsh-trash
```

## Limitations

- **Open-but-idle Sessions.** A Session is only fully released when its Agent
  is torn down. Trashing an open-but-idle Session hides it immediately, but the
  in-memory Agent may hold a stale view until the page reloads.
- **Restore is best-effort by path.** A Session is restored under the project
  directory recorded for it at delete time; if that workspace directory no
  longer exists, the log is restored but the row may not reappear until the
  workspace is reconnected.
- **Purge is final.** There is no second-level undo past the trash.

## License

MIT

---

## 中文

在左侧工作区直接删除任意对话，并提供**回收站**作为中间层，第一次点击不会真正消失。

### 功能

**1. 会话 `⋯` 菜单新增「删除对话」行**，位于自带的 *归档会话* 与 *Session ID* 之间。

**2. 回收站面板**，通过侧栏图标栏的垃圾桶图标打开。

| 位置 | 命令 | 效果 |
|---|---|---|
| 会话 `⋯` 菜单 | **删除对话** | 移入回收站并隐藏该行，可恢复。 |
| 回收站 | **恢复** | 移回原工作区并重新显示该行。 |
| 回收站 | **永久删除** | 永久移除该对话及其日志。 |
| 回收站 | **清空回收站** | 永久移除回收站内全部对话。 |

所有会销毁数据的操作都会先确认并显示对话名称。界面跟随语言（中文 / 英文）。

### 删除的实现方式

DSH 会话日志为只追加结构，持久化层没有删除 API（JSONL 后端文档明确写了 "Nothing deletes session files"），因此删除被建模为两个明确阶段：

1. **移入回收站** —— 把会话日志目录从持久化根目录**移动**到相邻的回收站目录，归档该会话（这正是让行消失的机制），并在 `trash.json` 中记录条目。
2. **永久删除** —— 删除回收站中的目录，并移除该会话的工作区账目；**保留归档标记**。

因为第一阶段是移动，所以完全可逆；同时把日志移出持久化根目录，Host 便不再索引它。回收站目录刻意放在会话根目录的**同级**：后端会扫描该根目录下的项目目录，若回收站放在其中会被当成会话重新索引。

### 安全设计

- **运行中的会话会被拒绝**：进行中的回合会持续追加，不能强行抽走其打开着的日志句柄。
- **移动失败不会丢数据**：移动是原子的；失败时回滚归档，行重新出现且内容完好。
- **路径包含校验**：任何移动或删除前都校验路径位于会话根或回收站根之内；若回收站会落在会话根内部，插件直接拒绝加载。
- **簿记不阻塞删除**：移动成功后的归档/摘除失败只记为警告，不算删除失败。
- **永久删除后仍保持隐藏**：永久删除会**保留**归档标记而不是清除。会话日志虽已删除，但该会话仍可能驻留内存；一旦清除标记，它就会以"已从所有工作区摘除"的形态重新出现在**未分组**下。残留的归档 id 是无害的——它只能隐藏一个已不存在的 id。
- **恢复只撤销"移入回收站"这一步**：若某对话在移入回收站**之前**就已被归档，恢复后仍保持归档；恢复不会顺手把你先前隐藏的对话解除归档。

### 回收站存储

| 路径 | 内容 |
|---|---|
| `$DSH_HOME/sessions-trash/` | 默认回收站根目录（与 `$DSH_HOME/sessions` 同级）。 |
| `…/trash.json` | 清单：标题、cwd、删除时间、警告。 |
| `…/<session-id>/` | 被移动过来的日志目录，原样保留。 |

清单缺失或损坏时降级为"无标题条目"而不会丢失回收站；面板会把清单与实际存在的目录对齐，手工复制或删除的目录不会造成不同步。

### 安装

本包**未发布到 npm**，直接写包名是装不上的。请用 `github:` 形式从本仓库安装：

```text
github:Gradeniax/dsh-sidebar-session-delete
```

#### 在 DSH 界面里或让 AI 安装

打开 **插件 → 添加 / 安装**，粘贴上面的 spec；或直接让 AI 帮你装。两者最终都走同一个 `install_bundle`。

#### 用 dsh 命令行

```bash
dsh plugin --profile <profile> add github:Gradeniax/dsh-sidebar-session-delete
```

#### 手动安装

```bash
cd "$DSH_HOME/profiles/<profile>"
pnpm add github:Gradeniax/dsh-sidebar-session-delete
```

然后把该 bundle 加入该 profile 的 `package.json`，使其自带的 patch 生效：

```json
{
  "dsh": { "profile": { "bundles": ["dsh-sidebar-session-delete"] } }
}
```

#### 安装之后

**重启 DSH**。改动 **Host 半** 必须重启才生效——Node 会缓存 ESM 模块，重新安装只重跑 patch、不重载代码；改动 **浏览器半** 刷新页面即可。

仓库地址：<https://github.com/Gradeniax/dsh-sidebar-session-delete>

### 兼容性

基于 DSH `0.2.1-rc.5`（桌面版）开发并测试。依赖以下 Host 服务：`webServer`、`sessionPersistence`、`workspaceRegistry`、`sessions`、`agents`；依赖以下 slot：`sidebar.workspaces.session.menu.item`、`sidebar.panellist`、`main`、`shell.overlay`，以及客户端的 `locale`。若某个部署改名或移除了其中任一，插件会保持未激活，而不会破坏界面。

### 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `''` | 会话根目录。留空时取 `sessionPersistence` 自身的 root，其次 `$DSH_HOME/sessions`。 |
| `trashRoot` | `''` | 回收站根目录。留空时使用 `root` 的同级目录 `<root>-trash`，必须位于 `root` 之外。 |

### 已知限制

- **已打开但空闲的会话**：只有 Agent 被拆除时会话才完全释放。移入回收站会立即隐藏，但内存中的 Agent 可能持有旧视图直到页面重载。
- **恢复依赖原路径**：会话按删除时记录的工程目录恢复；若该工作区目录已不存在，日志会恢复但行可能不会立刻出现，需重新连接工作区。
- **永久删除不可逆**：回收站之后没有第二层撤销。

### 许可证

MIT
