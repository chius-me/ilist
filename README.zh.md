<div align="right"><a href="./README.md">English</a> | 简体中文</div>

<div align="center">

# ilist

面向 Cloudflare Workers 的自托管文件索引与管理器。

[![Release](https://img.shields.io/badge/release-v0.1.3-2ea44f?logo=github)](https://github.com/chius-me/ilist/releases/tag/v0.1.3)
[![License](https://img.shields.io/badge/license-GPL--3.0--only-blue)](https://github.com/chius-me/ilist/blob/main/LICENSE)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-f38020?logo=cloudflare&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-5.8-3178c6?logo=typescript&logoColor=white)
![Tests](https://img.shields.io/badge/tests-Vitest-6e9f18)

</div>

> [v0.1.3](https://github.com/chius-me/ilist/releases/tag/v0.1.3) 面向单管理员使用，并提供公开只读浏览。升级前请查看[限制](#限制)并备份 D1。

## 功能

- 支持虚拟根目录以及多个可独立命名的存储挂载
- 支持通过 PKCE 进行 OneDrive Personal OAuth 授权，并加密保存刷新令牌
- 支持多个 OneDrive 账户，每个账户都可挂载到自定义的顶层路径
- 支持使用 AWS Signature Version 4 的 S3 兼容挂载
- 支持通过 S3 凭据或内置 Worker 绑定使用 Cloudflare R2
- 支持公开目录浏览、稳定文件链接、下载和常见文件预览
- 支持英文和简体中文界面，并提供跟随系统、浅色和深色主题，偏好保存在本地
- 支持列表和网格视图、面包屑、排序、搜索、键盘选择及响应式布局
- 支持适配桌面、平板和移动屏幕的存储与外观管理界面
- 支持管理员登录、上传、新建文件夹、重命名、移动、删除及可见性控制
- 支持 D1 迁移以及旧版 R2 对象链接的兼容
- 支持流式传输提供商响应，不会将完整文件缓冲在 Worker 内存中

## 支持的存储

| 存储 | 浏览 | 下载 | 上传 | 管理 | 备注 |
| --- | ---: | ---: | ---: | ---: | --- |
| OneDrive Personal | ✓ | ✓ | ✓ | ✓ | 仅支持个人 Microsoft 账户 |
| Cloudflare R2 绑定 | ✓ | ✓ | ✓ | ✓ | 内置的 `R2` 兼容挂载 |
| 通过 S3 接入 Cloudflare R2 | ✓ | ✓ | ✓ | ✓ | 使用 R2 S3 端点和限定范围的凭据 |
| 其他 S3 兼容存储 | ✓ | ✓ | ✓ | ✓ | 兼容性取决于提供商的 S3 实现 |

不提供 OneDrive Personal Vault。Microsoft Graph 返回的锁定保险库不包含可用的文件或文件夹类型信息，因此 ilist 会跳过它，避免导致父目录加载失败。

## 架构

```text
浏览器
  |
  +-- React + Vite 界面（Workers Assets）
  |
  +-- Cloudflare Worker
        +-- 原生请求路由与会话认证
        +-- 虚拟文件系统与存储驱动注册表
        +-- OneDrive Personal 驱动 -> Microsoft Graph
        +-- S3 驱动 -> R2 或其他 S3 兼容提供商
        +-- D1 -> 挂载、加密凭据、文件条目和会话
        +-- R2 绑定 -> 内置兼容存储
```

Worker 作为控制平面，在可能的情况下对文件数据进行流式传输或重定向。提供商凭据在写入 D1 前会先经过加密。

## 快速开始

1. **前置条件。** 安装 Node.js 22.12 或更高版本以及 npm 10 或更高版本。准备好已启用 Workers、D1 和 R2 的 Cloudflare 账户，使用 `npx wrangler login` 完成 Wrangler 身份验证；如果要使用 OneDrive Personal，还需要一个 Microsoft Entra 应用。
2. **克隆并安装。**

   ```bash
   git clone https://github.com/chius-me/ilist.git
   cd ilist
   npm install
   ```

3. **创建 D1 和 R2 资源。**

   ```bash
   npx wrangler d1 create ilist-db
   npx wrangler r2 bucket create ilist-files
   ```

4. **配置 `wrangler.jsonc` 并应用 D1 迁移。** 将 Wrangler 返回的 D1 `database_id` 复制到 `wrangler.jsonc`，确认数据库和存储桶名称，然后运行：

   ```bash
   npx wrangler d1 migrations apply ilist-db --remote
   ```

5. **生成管理员密码哈希和随机密钥。**

   ```bash
   npm run hash-password -- "choose-a-strong-password" # ADMIN_PASSWORD_HASH
   openssl rand -base64 32                              # CREDENTIAL_MASTER_KEY
   openssl rand -hex 32                                 # SESSION_SECRET
   ```

6. **存储全部六个必需的 Worker secret。** 使用生成的值和 Microsoft 应用值，通过 `npx wrangler secret put` 写入：

   ```bash
   npx wrangler secret put ADMIN_PASSWORD_HASH
   npx wrangler secret put CREDENTIAL_MASTER_KEY
   npx wrangler secret put SESSION_SECRET
   npx wrangler secret put MICROSOFT_CLIENT_ID
   npx wrangler secret put MICROSOFT_CLIENT_SECRET
   npx wrangler secret put PUBLIC_ORIGIN
   ```

   `PUBLIC_ORIGIN` 必须是部署后的准确 HTTPS origin，且不能带末尾斜杠，例如 `https://ilist.example.com`。

7. **运行 `npm run check` 和 `npm run deploy`。**

   ```bash
   npm run check
   npm run deploy
   ```

8. **使用 `ADMIN_USERNAME` 值登录，该值默认为 `admin`。** 密码就是用于生成 `ADMIN_PASSWORD_HASH` 的明文值。

## 存储设置

登录后打开 `/admin/storages`。每个挂载都有自己的显示名称、顶层挂载路径、提供商及加密凭据、公开或私有可见性、启用状态以及可选的提供商根路径。删除或断开挂载只会移除 ilist 的配置和凭据，不会删除提供商账户、存储桶、云盘或已存储对象。

对于 OneDrive Personal，请遵循 [docs/onedrive-setup.md](docs/onedrive-setup.md)。使用一个仅配置为个人 Microsoft 账户的 Microsoft Entra 应用，并设置 Web 重定向 URI `https://YOUR_ILIST_ORIGIN/api/admin/oauth/onedrive/callback` 以及委托的 Graph 权限 `User.Read` 和 `Files.ReadWrite`。

对于通过 S3 使用 Cloudflare R2 的情况，请使用：

```text
Endpoint: https://ACCOUNT_ID.r2.cloudflarestorage.com
Region: auto
Addressing mode: path style
Bucket name: ilist-files
Access key ID: R2 API token access key ID
Secret access key: R2 API token secret access key
```

使用仅限于存储桶范围、并且只拥有 ilist 所需权限的 R2 API token。

## 本地开发

从已纳入版本控制的模板创建本地 secret：

```bash
cp .dev.vars.example .dev.vars
npx wrangler d1 migrations apply ilist-db --local
npm run dev
```

启动 Wrangler 前填入仅用于测试的值。它通常会在 `http://localhost:8787` 提供应用。OAuth 无法针对普通 HTTP origin 完成；回调流程请使用已部署的 Worker 或 HTTPS 开发主机名。本地 D1 和 R2 数据与生产环境隔离。永远不要将生产凭据放入 `.dev.vars`。

## 命令

| 命令 | 用途 |
| --- | --- |
| `npm run dev` | 运行本地 Worker 和 UI |
| `npm run dev:web` | 运行仅前端的 Vite 开发服务器 |
| `npm run build` | 构建 Vite 前端 |
| `npm run test:worker` | 运行 Worker 运行时测试 |
| `npm run test:ui` | 运行 UI 测试 |
| `npm run test:e2e` | 在桌面、平板和移动视口运行浏览器流程测试 |
| `npm run test:visual` | 运行浏览器截图场景 |
| `npm run test` | 运行全部测试 |
| `npm run check` | 类型检查、构建并运行全部测试 |
| `npm run deploy` | 使用 Wrangler 构建并部署 |
| `npm run hash-password -- "..."` | 生成管理员密码哈希 |
| `npm run migrate:objects -- --local` | 在本地将旧版对象行导入条目模型 |
| `npm run migrate:objects -- --remote` | 在生产环境导入旧版对象行 |

## 安全

- 保持 `CREDENTIAL_MASTER_KEY` 稳定。未经重新加密迁移就修改它，会使已存储的提供商凭据无法读取。
- 任何出现在终端录制、截图、issue 或聊天中的凭据都必须轮换。
- 在应用迁移或部署新版本前备份 D1。
- 使用最小权限、限定存储桶范围的 S3 或 R2 凭据。
- 不要提交 `.dev.vars`、D1 导出文件、访问令牌、client secret 或临时上传文件。
- 私有挂载依赖 ilist 授权；请检查部署中的 Cloudflare 日志、Access 策略和缓存规则。

## 限制

- 单个管理员；不支持注册或多用户权限模型
- 仅支持 OneDrive Personal；暂不支持工作和学校租户
- 不支持 Google Drive、WebDAV、FTP、SFTP、SMB 或本地文件系统驱动
- 上传使用单个不可续传的 Worker 请求，并受 Cloudflare 请求体限制
- 暂不支持 multipart S3 上传或 OneDrive 上传会话
- 不支持跨挂载复制或移动
- 不支持离线下载、归档解压、媒体转码或后台任务系统
- 提供商列表实时获取；尚未实现分布式目录缓存
- 内置 R2 的递归删除有数量上限，并会逐条报告失败；S3 兼容存储和 OneDrive 文件夹删除遵循各提供商的行为

## 旧版 R2 升级

修改生产环境前，导出 D1 并将导出文件保存在 Git 之外：

```bash
npx wrangler d1 export ilist-db --remote --output /tmp/ilist-db-before-multi-mount.sql
npx wrangler d1 migrations apply ilist-db --remote
npm run migrate:objects -- --remote
npm run deploy
```

`v0.1.x` 版本旨在继续兼容旧版 R2 对象链接。迁移会添加条目和挂载模型，但不会删除文件或旧版行。如果部署失败，请部署之前的 Worker 版本并保留增量迁移；只有在数据本身损坏时才恢复 D1 导出，不要仅为了回滚 Worker 代码而恢复。

## 项目结构

```text
src/
  ui/                         React 文件浏览器和管理界面
  worker/
    index.ts                  原生 Worker 入口
    router.ts                 HTTP 路由分发
    file-system.ts            虚拟文件系统操作
    drivers/
      onedrive/               Microsoft Graph 驱动和 OAuth 令牌
      s3/                     S3 兼容驱动和 SigV4 客户端
migrations/                   D1 数据库结构迁移
tests/worker/                 Worker 运行时测试
tests/ui/                     React 组件和交互测试
docs/                         配置与实现文档
```

## 路线图

- 工作和学校 Microsoft 账户
- 可续传上传和 multipart 上传
- 跨挂载复制和移动
- 更多存储驱动和后台操作

## 贡献

提交变更前运行 `npm run check`。不要将提供商凭据、本地变量、D1 导出文件和临时上传文件放入 Git。修改存储行为或部署要求时，请同步更新相关文档。

## 许可证

ilist 采用 GPL-3.0-only 许可证。
