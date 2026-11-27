<div align="right"><a href="./README.md">English</a> | 简体中文</div>

<div align="center">

<img src="./public/favicon.svg" width="56" height="56" alt="">

# iList

面向 Cloudflare Workers 的自托管文件索引与管理器。

[![Release](https://img.shields.io/badge/release-v0.2.1-2ea44f?logo=github)](https://github.com/chius-cc/ilist/releases)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![CI](https://github.com/chius-cc/ilist/actions/workflows/ci.yml/badge.svg)](https://github.com/chius-cc/ilist/actions)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18)

[版本发布](https://github.com/chius-cc/ilist/releases) · [反馈问题](https://github.com/chius-cc/ilist/issues) · [文档指南](./docs/)

</div>

> [v0.2.1](docs/releases/v0.2.1.md) 增加按挂载保存的 OAuth 凭据、可选的 OneDrive 根文件夹、iList 产品名，以及资源管理器界面修复。升级前请阅读[发布指南](docs/releases/v0.2.1.md)。v0.1.8 安全加固仍然必需，见 [v0.1.8](docs/releases/v0.1.8.md)。

## 功能

- 支持虚拟根目录以及多个可独立命名的存储挂载
- 支持通过 PKCE 与 POST 启动流程进行 OneDrive Personal OAuth 授权，并加密保存刷新令牌
- 支持多个 OneDrive 账户，每个账户都可挂载到自定义的顶层路径
- 支持多个 Google My Drive 账户或根目录，每个挂载独立授权并使用自定义顶层路径
- 支持多个 Dropbox 账户或根目录，并使用 PKCE OAuth 和加密刷新令牌
- 支持从 `/admin/storages` 管理每个挂载独立的 OAuth 应用凭据，并兼容旧版 Worker secret 回退
- 支持通过 S3 兼容 API 接入 Cloudflare R2 或其他 S3 存储（AWS Signature Version 4、并发分片上传、批量删除 `DeleteObjects`）
- 支持游标分页浏览、访客目录 60 秒边缘缓存（`?refresh=1` 可绕过缓存），以及前端 30 秒 LRU 目录导航缓存
- 支持丰富安全的文件预览：PDF.js Canvas 渲染（`pdfjs-dist`）、防 XSS 净化的 Markdown（`marked`）、代码语法高亮（`highlight.js`）、UTF-8/GB18030 自动文本编码回退、图片缩放旋转，以及同目录文件上下切换
- 支持文件夹上传（`webkitdirectory` 选择器与递归拖拽上传）、网格图片缩略图、超过 100 项列表虚拟滚动、交互式列排序、全选和键盘快捷键（`/`、`Escape`、`Backspace`）
- 支持可撤销的文件与文件夹分享，提供密码保护、过期时间、禁止或限制下载次数、分享页站内搜索排序、URL 状态同步，以及访问/下载统计
- 支持英文和简体中文界面，按需懒加载中文词典，并在本地持久化系统、浅色和深色主题
- 支持通过 `VITE_REPO_URL` 与 `VITE_CONTACT_EMAIL` 在构建时自定义顶部链接
- 支持适配桌面、平板和移动屏幕的响应式文件浏览器、存储管理、分享与外观设置界面
- 支持通过 `triggers.crons` 定期清理过期会话、OAuth 状态、限流窗口与过期上传会话
- 支持流式传输提供商响应，不会将完整文件缓冲在 Worker 内存中

## 支持的存储

| 存储 | 浏览 | 下载 | 上传 | 管理 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| OneDrive Personal | ✓ | ✓ | ✓ | ✓ | 支持可续传上传；仅支持个人 Microsoft 账户 |
| Google My Drive | ✓ | ✓ | ✓ | ✓ | 支持 Range 下载、可续传上传以及 Docs/Sheets/Slides 导出 |
| Dropbox | ✓ | ✓ | ✓ | ✓ | 支持 Range 下载、可续传上传、文件夹复制和云端文件导出 |
| 通过 S3 接入 Cloudflare R2 | ✓ | ✓ | ✓ | ✓ | 使用 R2 S3 端点与限定存储桶范围凭据，支持 3 并发 multipart 上传与批量删除 |
| 其他 S3 兼容存储 | ✓ | ✓ | ✓ | ✓ | multipart 兼容性取决于提供商的 S3 实现 |

不提供 OneDrive Personal Vault。Microsoft Graph 返回的锁定保险库不包含可用的文件或文件夹类型信息，因此 ilist 会跳过它，避免导致父目录加载失败。旧版原生 `R2` Worker 绑定（`native-r2`）已通过迁移 `0020_retire_native_r2_mounts.sql` 退役；请改用 S3 兼容凭据挂载 R2。

## 架构

```text
浏览器
  |
  +-- React + Vite 界面（Workers Assets，按需分块加载）
  |
  +-- Cloudflare Worker（Smart Placement + scheduled Cron 清理）
        +-- 模块化路由（routes/auth、routes/fs、routes/admin-entries）与会话认证
        +-- 虚拟文件系统、游标分页与惰性存储驱动注册表
        +-- OneDrive Personal 驱动 -> Microsoft Graph
        +-- Google Drive 驱动 -> Google Drive API v3
        +-- Dropbox 驱动 -> Dropbox API v2
        +-- S3 驱动 -> Cloudflare R2（S3 API）或其他 S3 兼容提供商
        +-- D1 -> 挂载、加密凭据、文件条目、上传会话和分享
```

Worker 作为控制平面，在可能的情况下对文件数据进行流式传输或重定向。提供商凭据在写入 D1 前会先经过加密。

## 快速开始

1. **前置条件。** 安装 Node.js 22.12 或更高版本以及 npm 10 或更高版本。准备好已启用 Workers 和 D1 的 Cloudflare 账户，使用 `npx wrangler login` 完成 Wrangler 身份验证，并准备好所需云存储的 OAuth 应用或 R2/S3 凭据。
2. **克隆并安装。**

   ```bash
   git clone https://github.com/chius-cc/ilist.git
   cd ilist
   npm install
   ```

3. **创建 D1 数据库。**

   ```bash
   npx wrangler d1 create ilist-d1
   ```

4. **配置 `wrangler.jsonc`、自定义域名并应用 D1 迁移。** 将 Wrangler 返回的 D1 `database_id` 复制到 `wrangler.jsonc`，确认数据库名称；只有当 `ilist.chius.dev` 位于你的 Cloudflare zone 时，才保留已配置的该自定义域名路由。然后运行：

   ```bash
   npx wrangler d1 migrations apply DB --remote --env production
   ```

5. **生成管理员密码哈希和随机密钥。**

   ```bash
   npm run hash-password   # ADMIN_PASSWORD_HASH；按提示输入密码
   openssl rand -base64 32 # CREDENTIAL_MASTER_KEY
   openssl rand -hex 32    # SESSION_SECRET
   ```

   密码命令拒绝通过参数传入密码。在终端中读取密码时会关闭字符回显；自动化场景可通过非 TTY 标准输入提供且仅提供一行密码。stdout 只输出最终哈希，提示和错误只写入 stderr。

   新哈希使用 `pbkdf2-sha256:600000`。旧版 `pbkdf2` 哈希在迁移兼容期内仍可使用，但管理员哈希属于 Cloudflare Secret，Worker 无法自动回写升级。使用旧哈希成功登录后，请执行以下命令轮换：

   ```bash
   npm run hash-password
   npx wrangler secret put ADMIN_PASSWORD_HASH
   ```

6. **存储四个必需的基础设施 Worker secret。** 提供商凭据在 `/admin/storages` 中按挂载输入：

   ```bash
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put CREDENTIAL_MASTER_KEY
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put PUBLIC_ORIGIN
   ```

   规范生产值为 `https://ilist.chius.dev`。`PUBLIC_ORIGIN` 必须与实际部署的 HTTPS origin 完全一致，且不能带末尾斜杠。如需自定义页头仓库或联系邮箱链接，可在构建 UI 时设置 `VITE_REPO_URL` 与 `VITE_CONTACT_EMAIL`。

7. **运行检查并部署。**

   ```bash
   npm run lint
   npm run check
   npm run deploy
   ```

8. **使用 `ADMIN_USERNAME` 值登录，该值默认为 `admin`。** 密码就是用于生成 `ADMIN_PASSWORD_HASH` 的明文值。

## 存储设置

登录后打开 `/admin/storages`。每个挂载都有自己的显示名称、顶层挂载路径、提供商及加密凭据、公开或私有可见性、启用状态以及可选的提供商根路径。断开连接只会移除账户授权，并保留可复用的应用/提供商配置；删除挂载会移除 ilist 挂载及其全部凭据。两者都不会删除提供商账户、存储桶、云盘或已存储对象。

对于 OneDrive Personal，请遵循 [docs/onedrive-setup.md](docs/onedrive-setup.md)。使用一个仅配置为个人 Microsoft 账户的 Microsoft Entra 应用，并设置 Web 重定向 URI `https://ilist.chius.dev/api/admin/oauth/onedrive/callback` 以及委托的 Graph 权限 `User.Read` 和 `Files.ReadWrite`，然后在 `/admin/storages` 输入应用凭据。

对于 Google Drive，请遵循 [docs/google-drive-setup.md](docs/google-drive-setup.md)。启用 Google Drive API，创建 Web OAuth 客户端，将重定向 URI 设置为 `https://ilist.chius.dev/api/admin/oauth/google/callback`，并在 `/admin/storages` 输入客户端 ID 和密钥。

对于 Dropbox，请遵循 [docs/dropbox-setup.md](docs/dropbox-setup.md)。创建 scoped Dropbox 应用，注册 `https://ilist.chius.dev/api/admin/oauth/dropbox/callback`，启用文件 metadata/content 的读写四项 scope，并在 `/admin/storages` 输入应用密钥。

对于通过 S3 使用 Cloudflare R2 的情况，请使用：

```text
Endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
Region: auto
Addressing mode: path style
Bucket name: ilist-r2
Access key ID: R2 API token access key ID
Secret access key: R2 API token secret access key
```

使用仅限于存储桶范围、并且只拥有 ilist 所需权限的 R2 API token。

## 上传行为

- 小于 `10 MiB` 的文件使用单请求上传路径。
- 等于或大于 `10 MiB` 的文件，在当前 OneDrive、Google Drive、Dropbox 或 S3 挂载声明支持 multipart 时使用可续传上传。
- 分片大小为 `10 MiB`；S3/R2 挂载支持最多 3 路分片并发上传，OneDrive、Google Drive 和 Dropbox 按顺序逐片上传。上传队列最多同时处理两个文件。
- 页面保持打开时，暂停、继续和重试会保留不透明的 ilist 会话 ID 以及服务端已确认分片。完整刷新后，未完成的 multipart 会话会重新出现在上传队列中，并要求重新选择本地原文件后才能继续分片（浏览器无法静默读取磁盘文件）。
- 文件夹上传（“上传文件夹”按钮或递归拖拽文件夹）会按层级创建缺失目录，并将文件分组排入对应目标目录。
- 提供商上传 URL、OneDrive 会话证明、Google 可续传会话 URL、Dropbox 会话 ID 和 S3 Upload ID 只保存在加密状态或服务端，绝不会返回浏览器。
- 建议为 S3 兼容存储桶配置未完成 multipart 上传生命周期规则，以便在 Worker 无法完成清理时自动删除遗留上传。

部署当前版本前请确保已应用全部 D1 迁移（直至 `0021_optimize_indexes.sql`）。

## 受控分享

管理员可以从任意文件或文件夹的操作菜单创建分享，并在 `/admin/shares` 管理已有分享（包括查看访问次数和下载次数统计）。分享可设置密码、过期时间、禁止显式下载、限制最大下载次数，也可随时停用或重新启用。文件夹分享支持嵌套浏览、列表与网格视图、前端搜索与排序、URL 查询参数同步，以及与主文件浏览器相同的安全预览类型。

Google Docs、Sheets 和 Slides 会在主文件浏览器与受控分享中显示明确的导出格式，并支持按需点击“预览 PDF”，不会在打开时自动内嵌。下载仍受分享当前下载策略约束。

原始 `/s/:token` 链接只在创建成功或轮换令牌时返回。D1 仅保存令牌的 SHA-256 哈希，因此管理页无法恢复或复制已有链接。管理员可轮换令牌，旧公开 URL 会立即失效且策略字段保留。可选最大下载次数由服务端强制执行。公开条目 ID 是限定到单个分享的加密句柄，不会暴露挂载 ID 或提供商条目 ID。密码授权使用短时有效、`HttpOnly`、`SameSite=Lax` 且限定到该分享路径的 Cookie。

每次元数据、目录、预览和文件请求都会重新检查密码、启用状态、过期时间、目标可用性和下载策略。分享响应使用 `Cache-Control: private, no-store`；不要添加覆盖该策略的 Cloudflare 缓存规则。停用或删除分享会在下一次请求时立即生效。

公开分享路由位于 `/s/:token`。管理员自动化可使用 `/api/admin/shares` 下的 `GET`、`POST`、`PATCH` 和 `DELETE`，并继续受管理员会话与同源保护约束。

## 本地开发

从已纳入版本控制的模板创建本地 secret：

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply DB --local
npm run dev
```

启动 Wrangler 前填入仅用于测试的值。它通常会在 `http://localhost:8787` 提供应用。OAuth 无法针对普通 HTTP origin 完成；回调流程请使用已部署的 Worker 或 HTTPS 开发主机名。本地 D1 数据与生产环境隔离。永远不要将生产凭据放入 `.dev.vars`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 运行本地 Worker 和 UI |
| `npm run dev:web` | 运行仅前端的 Vite 开发服务器 |
| `npm run build` | 构建 Vite 前端 |
| `npm run lint` | 使用 Biome 检查 `src`、`tests` 和 `scripts` 的代码规范 |
| `npm run lint:fix` | 应用安全的 Biome 自动修复 |
| `npm run typecheck` | 运行隔离且严格的 `worker`/`ui`/`node` 类型检查 |
| `npm run test:worker` | 使用 `@cloudflare/vitest-plugin` 运行 Worker 运行时测试 |
| `npm run test:ui` | 运行 UI 单元测试与交互测试 |
| `npm run test:scripts` | 运行 CLI 脚本测试 |
| `npm run test:e2e` | 在桌面、平板和移动视口运行浏览器流程测试 |
| `npm run test:e2e:ci` | 运行非截图浏览器 E2E 测试 |
| `npm run test:visual` | 运行浏览器截图场景 |
| `npm run test` | 运行全部 Worker、UI 和脚本测试 |
| `npm run check` | 运行分组类型检查、构建前端并执行全部单元测试 |
| `npm run deploy:d1` | 向生产 D1 应用远程迁移 |
| `npm run deploy` | 应用迁移、构建并使用 Wrangler 部署 |
| `npm run types` | 重新生成 `src/worker/env.d.ts` 中的 Worker 绑定类型 |
| `npm run hash-password` | 交互输入并生成管理员密码哈希 |

## 持续部署

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) 会在每个 Pull Request 以及每次推送到 `main` 时依次运行 `npm audit --omit=dev --audit-level=high`、`npm run lint`、`npm run check` 与 `npm run test:e2e:ci`。

`main` 上检查通过后（或手动 `workflow_dispatch`），部署任务会应用待执行的远程 D1 迁移，再用 Wrangler 部署 Worker 与 Assets。通过 `wrangler secret put` 写入的 Worker secret 保留在 Cloudflare，不会由 CI 重新上传。

首次自动部署前，请在仓库 **Settings → Secrets and variables → Actions** 配置以下 **repository secrets**：

| Secret | 用途 |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | 具备本账户 Workers、Workers Routes / Custom Domains 与 D1 编辑权限的 API token |
| `CLOUDFLARE_ACCOUNT_ID` | 拥有 `ilist` Worker 与 `ilist-d1` D1 数据库的 Cloudflare 账户 ID |

不要把 `ADMIN_PASSWORD_HASH`、`CREDENTIAL_MASTER_KEY`、OAuth client secret 或其他密钥放进 GitHub。基础设施密钥保存在 Cloudflare Worker secret 中；通过 WebUI 输入的提供商凭据会加密保存在 D1 中。

## 安全

- 保持 `CREDENTIAL_MASTER_KEY` 稳定。未经重新加密迁移就修改它，会使已存储的提供商凭据无法读取。
- 任何出现在终端录制、截图、issue 或聊天中的凭据都必须轮换。
- 在应用迁移或部署新版本前备份 D1。
- 使用最小权限、限定存储桶范围的 S3 或 R2 凭据。
- S3 兼容存储的创建、上传、multipart 完成、重命名和移动操作会拒绝覆盖已存在目标，确保并发安全。
- 不要提交 `.dev.vars`、D1 导出文件、访问令牌、client secret 或临时上传文件。
- 私有挂载依赖 ilist 授权；请检查部署中的 Cloudflare 日志、Access 策略和缓存规则。
- 分享链接属于持有者凭据，请通过合适的私密渠道发送；敏感内容应同时设置密码。
- D1 无法恢复已有分享的原始 URL；链接丢失时应创建替代分享。
- 应用响应配置了严格安全响应头（包含供 PDF.js Worker 使用的 `worker-src 'self'`）；同源 HTML、SVG、XML 和未知类型文件会作为附件下载，并使用隔离的文件响应策略（`sandbox; default-src 'none'`）。
- 新挂载默认私有。公开挂载必须由管理员显式确认，因为未登录访客可以浏览该挂载。
- 每次访问分享条目都会根据实时分享根目录校验句柄；将文件移出被分享文件夹会立即使旧句柄失效。
- 管理员失败尝试会在执行 PBKDF2 前同时受两个限制：每 IP 每分钟最多五次，以及每 IP 加规范化用户名每分钟最多五次。分享密码仍限制为每 IP 加分享每分钟最多十次。请勿在分享响应前配置覆盖其缓存策略的规则。
- OneDrive、Google Drive 和 Dropbox 分享会实时校验祖先目录，但提供商侧移动与元数据或下载请求并发时，仍有一个无法完全消除的短暂 TOCTOU 窗口。敏感公开分享应限制提供商写入权限；需要立即撤销时请禁用分享。

## 限制

- 单个管理员；不支持注册或多用户权限模型
- 仅支持 OneDrive Personal；暂不支持工作和学校租户
- Google 支持当前仅限 My Drive，尚未实现 Shared Drives、Shared with me 和快捷方式遍历
- 尚未实现 Dropbox Business 团队代理和显式 Team Space namespace 选择
- 不支持 WebDAV、FTP、SFTP、SMB 或本地文件系统驱动
- 刷新后续传需要重新绑定本地原文件；浏览器无法在无用户确认时静默恢复上传
- 不支持跨挂载复制或移动（支持同挂载复制）
- 分享不支持上传、接收者账户或邮件通知
- 除定时清理过期会话/状态的 Cron 外，不支持离线下载、归档解压、媒体转码或后台任务队列
- 访客目录列表使用 60 秒边缘 Cache API 缓存（可用 `?refresh=1` 绕过）及 30 秒客户端 LRU 缓存，并非跨区域实时分布式缓存失效总线
- Google Shared Drives、Shared with me、OneDrive 工作/学校账号、多用户 ACL 与 WebDAV 仍不在范围内

## 项目结构

```text
src/
  ui/                         React 文件浏览器、富媒体预览与管理界面
  worker/
    index.ts                  原生 Worker 入口与定时 Cron 处理器
    router.ts                 顶层 HTTP 路由分发
    routes/                   auth / fs / admin-entries 模块化路由
    file-system.ts            虚拟文件系统操作
    shared/                   HTTP 客户端、编码、IP 校验与 OAuth 公共辅助模块
    drivers/
      registry.ts             惰性存储驱动注册表
      onedrive/               Microsoft Graph 驱动和 OAuth 令牌
      google/                 Google Drive API 驱动和 OAuth 令牌
      dropbox/                Dropbox API v2 驱动和 OAuth 令牌
      s3/                     S3 兼容驱动和 SigV4 客户端
migrations/                   D1 数据库结构迁移
tests/worker/                 Worker 运行时测试
tests/ui/                     React 组件和交互测试
tests/e2e/                    Playwright 端到端测试
scripts/                      CLI 脚本工具
docs/                         配置与实现文档
```

## 路线图

- 工作和学校 Microsoft 账户
- Google Shared Drives 与快捷方式
- 跨挂载复制和移动
- 更多存储驱动和后台操作

## 贡献

提交变更前运行 `npm run lint` 与 `npm run check`。不要将提供商凭据、本地变量、D1 导出文件和临时上传文件放入 Git。修改存储行为或部署要求时，请同步更新相关文档。

## 📄 许可证

ilist 采用 [MIT 许可证](LICENSE) 开源发布。

---

<div align="center">
  <sub>Crafted with ❤️ by <a href="https://chius.cc">Chius</a> · Powered by Cloudflare & GitHub</sub>
</div>
