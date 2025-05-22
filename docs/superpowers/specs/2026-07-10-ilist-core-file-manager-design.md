# ilist 核心文件管理器设计

日期：2026-07-10

## 1. 背景

ilist 当前是一个运行在 Cloudflare 原生 Worker 上的 R2 文件分享站，使用 React、Workers Assets、R2 和 D1。现有版本已经支持公开目录浏览、文件下载、管理员登录、上传、删除、公开状态和元数据编辑，但页面更像 R2 对象管理面板，尚未形成 OpenList 式文件浏览器的完整操作模型。

本次迭代先建立可靠的文件系统语义和完整操作闭环。视觉方向采用 OpenList 经典型：居中的单列文件面板，面包屑和文件列表为页面核心。字体、色彩、动画和品牌等精修在功能稳定后单独设计。

## 2. 已确认决策

- 保留 React、Vite 和 Cloudflare 原生 Worker，不迁移前端框架，不引入 Hono。
- 访客和管理员共用同一套文件浏览器。
- 未登录时只读；管理员登录后在原页面增加上传和管理能力。
- 采用居中单列的 OpenList 经典型布局，不使用固定目录树或常驻详情侧栏。
- D1 管理虚拟目录结构，R2 仅保存文件内容。
- 文件使用稳定 ID 和不可变 R2 storage key，重命名与移动不复制 R2 对象。
- 功能阶段包含浏览、预览、上传进度、新建文件夹、真正重命名、移动、删除和多选批量操作。
- 功能完成后再单独讨论视觉提升。

## 3. 范围

### 3.1 本次包含

- 真实路径 URL、面包屑和浏览器前进后退。
- 列表与网格视图、目录内搜索和排序。
- 图片、视频、音频、PDF、文本和 Markdown 基础预览。
- 管理员登录后原地增强操作能力。
- 拖放与文件选择上传、真实上传进度、取消和失败重试。
- 显式空目录、新建文件夹、重命名、移动和递归删除。
- 文件与文件夹多选，以及批量移动、删除和公开状态切换。
- 稳定文件预览与下载链接。
- 现有 D1 objects 数据的幂等迁移。
- 结构化错误、局部失败反馈和必要的自动化测试。

### 3.2 本次不包含

- 视觉品牌重做和像素级 OpenList 复刻。
- 批量打包下载。
- 浏览器直传、分片上传和断点续传。
- 分享密码、到期时间和独立分享记录。
- OneDrive、Google Drive 或其他外部驱动。
- WebDAV、压缩与解压、离线任务和跨存储复制。
- 多用户和复杂权限系统。
- Office 文档与压缩包内容预览。

## 4. 页面与导航

### 4.1 路径 URL

- 根目录使用 `/`。
- 子目录直接使用编码后的路径，例如 `/R2/Projects`。
- `/api`、`/file` 和 `/admin` 是保留的顶级系统路径，根目录下不得创建同名条目。
- 每个路径段独立进行 URL 编码和解码，禁止将整条路径一次性编码。
- URL 是当前目录的唯一真相来源。刷新、前进、后退和复制目录链接必须恢复同一目录。
- `/admin` 只作为登录深链。登录成功后回到进入登录前的目录，不渲染另一套管理页面。

### 4.2 页面骨架

页面从上到下包含：

1. 顶部栏：品牌、搜索入口、视图切换和账户入口。
2. 面包屑：所有层级均可点击。
3. 上下文工具栏：根据访客、管理员和多选状态切换命令。
4. 居中文件面板：列表或网格。
5. 浮动上传任务面板：仅在存在上传任务时显示。
6. 预览层、操作菜单和必要的对话框。

删除现有统计卡、当前路径统计和常驻详情栏。文件详情进入“属性”对话框或预览界面。

### 4.3 点击规则

- 单击文件夹进入目录。
- 单击文件打开预览。
- 复选框只负责多选，不触发打开或预览。
- 桌面端右键菜单与行尾菜单使用同一份动作定义。
- 移动端行尾菜单打开底部操作面板，不依赖右键。
- 切换目录后清空多选状态并关闭当前菜单。
- 预览使用 `?preview=<entry_id>` 表达；浏览器返回可关闭预览并恢复原目录滚动位置。

## 5. 权限与能力

### 5.1 访客

访客可执行：

- 浏览公开目录。
- 搜索、排序、列表与网格切换。
- 预览公开文件。
- 下载公开文件。
- 复制稳定文件链接。

### 5.2 管理员

管理员在相同页面额外获得：

- 查看隐藏条目。
- 上传和新建文件夹。
- 重命名、移动和删除。
- 编辑描述、排序和公开状态。
- 多选与批量操作。

后端为每个条目返回 `capabilities`，前端只根据能力显示操作，不根据文件类型和登录状态自行重复推导权限。该约定为后续外部存储驱动保留兼容空间。

### 5.3 公开状态

- 条目记录自身 `is_public`。
- 访客访问条目的条件是：条目为 `ready`，且自身和全部祖先目录均公开。
- 隐藏目录不会覆盖子项原有 `is_public`；重新公开目录后，子项恢复其原有有效状态。
- 新文件和新目录默认继承父目录的 `is_public`。
- 隐藏条目的文件响应必须要求管理员会话，并使用私有缓存策略。

## 6. 数据模型

### 6.1 D1 为虚拟文件系统真相来源

新增 `entries` 表。固定根目录条目 ID 为 `root`，所有顶级条目的 `parent_id` 均为 `root`。

建议字段：

```sql
CREATE TABLE entries (
  id TEXT PRIMARY KEY,
  parent_id TEXT REFERENCES entries(id),
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('file', 'folder')),
  storage_key TEXT,
  size INTEGER NOT NULL DEFAULT 0,
  content_type TEXT,
  etag TEXT,
  status TEXT NOT NULL CHECK (status IN ('uploading', 'ready', 'deleting')),
  is_public INTEGER NOT NULL DEFAULT 1,
  sort_order INTEGER NOT NULL DEFAULT 0,
  description TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (
    (kind = 'file' AND storage_key IS NOT NULL) OR
    (kind = 'folder' AND storage_key IS NULL)
  ),
  UNIQUE (parent_id, name)
);

CREATE UNIQUE INDEX entries_storage_key_unique
ON entries(storage_key)
WHERE storage_key IS NOT NULL;

CREATE INDEX entries_parent_order
ON entries(parent_id, sort_order, name);
```

根条目自身 `parent_id` 为 `NULL`，名称为空字符串，类型为 `folder`，状态为 `ready`，且不可重命名、移动或删除。

### 6.2 名称规则

- 除固定根条目外，名称不能为空。
- 名称不能是 `.` 或 `..`。
- 名称不能包含 `/`、NUL 或控制字符。
- UTF-8 编码后不得超过 255 字节。
- 同一父目录下名称唯一，采用区分大小写语义。
- 顶级条目不能使用 `api`、`file` 或 `admin`。
- 移动文件夹时必须阻止移动到自身或任意后代目录。

### 6.3 R2 对象

- 新上传文件使用不可变物理键，例如 `blobs/<entry_id>`。
- 用户文件名和虚拟路径不进入新 R2 storage key。
- 重命名与移动只更新 D1，不触碰 R2。
- 下载、预览和删除通过 entry ID 解析 storage key。
- 迁移前已有对象继续使用原 key 作为 storage key，无需复制或重新上传。

## 7. Worker 模块边界

现有 Worker 保持原生 `fetch(request, env)` 入口，并按职责拆分：

- `router.ts`：匹配请求并调用服务，不直接编写 D1 业务查询。
- `auth.ts`：登录、会话和管理员校验。
- `entries.ts`：路径解析、目录列表、可见性和条目查询。
- `file-system.ts`：新建、重命名、移动、批量操作和状态转换。
- `r2.ts`：R2 流式上传、读取、Range 响应和删除。
- `db.ts`：D1 低层查询和事务封装。
- `http.ts`：结构化响应、错误码和安全响应头。

暂不建立通用驱动框架。业务服务不得把 R2 key 当作虚拟路径，从而为未来新增驱动保留边界。

## 8. API 设计

### 8.1 读取接口

`GET /api/fs/list?path=/R2/Projects`

根据可选管理员会话返回当前目录、面包屑和可见子项：

```json
{
  "ok": true,
  "data": {
    "current": {},
    "breadcrumbs": [],
    "items": []
  }
}
```

`GET /api/fs/entries/:id`

返回单个条目详情。访客不能读取隐藏或非 `ready` 条目。

`GET /file/:id/:name`

- `name` 仅用于可读 URL 和 Content-Disposition，不作为查找键。
- 默认 `inline`，增加 `?download=1` 时返回 `attachment`。
- 支持 `GET`、`HEAD`、ETag、条件请求和 Range。
- 公开文件可使用受控公共缓存；隐藏文件使用 `private, no-store`。

### 8.2 管理接口

- `POST /api/admin/folders`，JSON：`{ parentId, name }`。
- `PUT /api/admin/files/:id?parentId=<id>&name=<encoded>`，请求体为文件流。
- `PATCH /api/admin/entries/:id`，JSON 可包含 `name`、`description`、`sortOrder`、`isPublic`。
- `POST /api/admin/entries/move`，JSON：`{ ids, destinationId }`。
- `POST /api/admin/entries/delete`，JSON：`{ ids }`。
- `POST /api/admin/entries/visibility`，JSON：`{ ids, isPublic }`。
- 登录、退出和 `me` 接口保持现有路径。

状态修改接口必须验证同源 `Origin`，并继续使用 HttpOnly、Secure、SameSite 会话 Cookie。

### 8.3 条目响应

统一条目至少包含：

```ts
interface Entry {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number;
  contentType: string | null;
  updatedAt: string;
  isPublic: boolean;
  effectivePublic: boolean;
  sortOrder: number;
  description: string;
  capabilities: {
    open: boolean;
    preview: boolean;
    download: boolean;
    rename: boolean;
    move: boolean;
    delete: boolean;
    changeVisibility: boolean;
  };
}
```

前端不得接收或展示 `storage_key`。

## 9. 操作一致性

### 9.1 上传

1. 前端为任务生成 entry ID。
2. Worker 在 D1 创建 `uploading` 条目。
3. Worker 流式写入 R2。
4. R2 成功后更新大小、类型、ETag，并将条目标记为 `ready`。
5. R2 失败时删除临时条目。
6. 最终 D1 更新失败时尝试删除 R2 残留和临时 D1 条目，并保留可诊断日志；未清理成功的 `uploading` 条目不得对访客可见。
7. 对同一 `uploading` ID 的重试必须幂等；已存在的 `ready` ID 返回冲突。

### 9.2 重命名和移动

- 重命名只更新 `name`。
- 移动只更新 `parent_id`。
- 单次或批量更新使用 D1 事务。
- 操作前验证名称冲突、目标目录存在、目标目录可写和目录环路。
- entry ID 和稳定文件链接不变。

### 9.3 删除

1. 在 D1 将目标及递归子项标记为 `deleting`。
2. 删除所有文件对应的 R2 对象。
3. 删除已成功清理 R2 内容的文件条目；文件夹仅在已经没有子项时按从叶子到根的顺序删除。
4. R2 删除失败的条目及其仍需保留的祖先目录恢复为 `ready` 并返回失败明细。
5. 已成功删除的条目保持删除结果，不伪装成事务性全成或全败。

同步递归删除设定可配置条目上限，默认 1000。超过上限时拒绝操作并提示未来任务系统处理，避免单个 Worker 请求失控。

### 9.4 批量操作

- 第一阶段支持移动、删除和公开状态切换。
- 每个响应返回 `succeeded` 与 `failed`。
- UI 刷新当前目录，并用结果摘要说明部分失败。
- 批量下载不通过连续打开浏览器窗口实现，本阶段不显示该命令。

## 10. 前端结构

继续使用 React，不引入全局状态库。建议结构：

```text
src/ui/
  app/
    ExplorerApp.tsx
  api/
    client.ts
    entries.ts
    session.ts
    uploads.ts
  features/explorer/
    Breadcrumbs.tsx
    ExplorerToolbar.tsx
    FileList.tsx
    FileGrid.tsx
    EntryRow.tsx
    SelectionToolbar.tsx
    EntryActionMenu.tsx
  features/preview/
    PreviewOverlay.tsx
    preview-kind.ts
  features/uploads/
    UploadPanel.tsx
    UploadTaskRow.tsx
    useUploadQueue.ts
  features/operations/
    RenameDialog.tsx
    MoveDialog.tsx
    DeleteDialog.tsx
    PropertiesDialog.tsx
  hooks/
    useExplorerLocation.ts
    useDirectory.ts
    useSelection.ts
    useSession.ts
  types/
    entries.ts
```

现有 `App.tsx` 逐步变为薄入口。拆分只围绕本次功能，不进行无关架构重写。

## 11. 前端状态与数据流

- `useExplorerLocation` 监听 pathname、query 和 `popstate`，不引入路由库。
- `useDirectory` 根据当前路径请求目录；切换目录时取消陈旧请求。
- 目录加载成功后再替换列表，刷新失败时保留旧列表并显示可重试提示。
- 搜索和排序第一阶段在当前已加载目录内完成。
- `useSelection` 只保存 entry ID；切换目录后清空。
- `useSession` 启动时读取 `me`；401 表示访客，不显示错误页。
- 登录成功后重新请求当前目录，使隐藏条目和管理能力原地出现。
- 退出后清空多选并重新请求当前目录，移除隐藏条目。

## 12. 预览

- 图片：`img`。
- 视频：原生 `video`，依赖 Range 响应支持拖动。
- 音频：原生 `audio`。
- PDF：浏览器内嵌预览。
- 文本和 Markdown：只读取受限大小并作为安全文本渲染，不执行原始 HTML。
- 其他文件：显示名称、类型、大小、修改时间和下载按钮。

预览使用稳定 entry ID。关闭预览恢复目录滚动位置；移动端预览占满可视区域。

## 13. 上传队列

- 使用 `XMLHttpRequest` 获取可靠的浏览器上传进度事件。
- 同时上传最多 2 个任务。
- 状态包括 `queued`、`uploading`、`completed`、`failed` 和 `cancelled`。
- 每个任务显示百分比、已上传大小、总大小和失败原因。
- 上传中可取消，失败后可使用同一 entry ID 重试。
- 上传成功后只刷新目标目录；其他目录中的任务不改变当前页面。
- 超出 Cloudflare 当前套餐请求大小限制时显示明确错误。
- 分片与断点续传不在本次范围内。

## 14. 错误处理

统一错误格式：

```json
{
  "ok": false,
  "error": {
    "code": "ENTRY_NAME_CONFLICT",
    "message": "当前目录已存在同名条目"
  }
}
```

至少定义：

- `AUTH_REQUIRED`：401。
- `ENTRY_NOT_FOUND`：404。
- `ENTRY_NAME_CONFLICT`：409。
- `INVALID_ENTRY_NAME`：400。
- `INVALID_MOVE_TARGET`：400。
- `ENTRY_NOT_PUBLIC`：404，避免泄露隐藏条目存在。
- `UPLOAD_TOO_LARGE`：413。
- `OPERATION_LIMIT_EXCEEDED`：409。
- `STORAGE_OPERATION_FAILED`：502。

错误响应不包含 SQL、R2 原始错误、密钥、storage key 或调用栈。表单错误在字段附近显示；目录错误使用页面内提示；后台任务错误显示在对应任务行。

## 15. 迁移与兼容

### 15.1 数据迁移

- 新 migration 创建 `entries`，不删除 `objects`。
- 提供幂等迁移脚本读取旧 `objects`。
- 脚本按 key 路径创建缺失文件夹条目，并创建文件条目。
- 文件条目的 storage key 保留旧 key。
- 原 `name`、大小、类型、ETag、时间、公开状态、排序和描述全部保留。
- 迁移用确定性 ID 或迁移映射表保证重复运行不会创建重复条目。
- 验证新旧记录数量和关键元数据后，Worker 切换到 `entries`。
- `objects` 至少保留一个发布周期，再在单独迁移中删除。

### 15.2 URL 兼容

- 旧 `/file/*key` 在迁移期根据旧 key 查找对应 entry，并执行与稳定 ID 下载接口相同的公开状态和管理员权限检查。
- 找到后返回 302 到 `/file/:id/:name`。
- 未找到时返回 404。

## 16. 测试策略

### 16.1 单元测试

- 路径编码、解码和规范化。
- 中文名称、255 字节限制和非法名称。
- 文件类型与预览类型判断。
- 面包屑生成。
- 能力计算和祖先可见性。
- 移动环路检测。
- 上传队列状态转换。

### 16.2 Worker 与 D1/R2 集成测试

- 访客与管理员目录结果不同。
- 空目录创建与浏览。
- 上传成功、上传失败清理和幂等重试。
- GET、HEAD、ETag 和 Range 下载。
- 重命名和移动后 storage key 与稳定链接不变。
- 重名冲突和非法移动。
- 文件删除、递归目录删除和部分失败恢复。
- 旧 objects 数据迁移与旧 URL 重定向。
- 隐藏条目不能通过 ID 或旧 key 绕过权限访问。

### 16.3 前端交互测试

- URL 导航、前进和后退。
- 单击文件夹、文件预览与关闭预览。
- 登录后能力原地出现，退出后隐藏条目消失。
- 多选工具栏、右键菜单和行尾菜单动作一致。
- 上传进度、取消、失败和重试。
- 移动端底部操作面板和全屏预览。

### 16.4 发布验证

- TypeScript 类型检查通过。
- Vite 构建通过。
- 本地 D1 migration 和集成测试通过。
- 本地 Worker 冒烟测试通过。
- 远程 migration 先执行并验证，再部署 Worker。
- 线上验证首页、登录、上传、预览、重命名、移动、删除、公开状态和 Range 下载。

## 17. 实施边界

实施应按数据模型与兼容层、Worker 文件系统服务、读取与预览、管理操作、前端浏览器、上传队列、迁移和端到端验证逐步推进。每一步都必须保持可构建，并不得在同一阶段混入视觉品牌重做。

功能阶段完成的判定标准是：访客可以自然地浏览、预览和下载；管理员在同一界面完成上传、新建目录、重命名、移动、删除和批量管理；刷新、深层链接、前进后退、中文路径和移动端操作均可靠。
