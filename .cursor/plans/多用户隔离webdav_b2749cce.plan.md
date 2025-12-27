---
name: 多用户隔离WebDAV
overview: 将现有单用户 Basic Auth 的 r2-webdav Worker 改为多用户：账号存放在 Cloudflare KV 中，按 username/ 前缀隔离到同一 R2 bucket；并提供受 Bearer token 保护的管理员 API 用于增删用户。
todos:
  - id: kv-binding
    content: 在 wrangler.toml 增加 KV namespace 绑定（users），并在 README 说明如何创建/绑定与配置 ADMIN_TOKEN
    status: pending
  - id: multi-user-auth
    content: 在 src/index.ts 实现 Basic Auth -> KV 用户校验（含 PBKDF2 散列与 timingSafeEqual），替换现有单用户 USERNAME/PASSWORD 模式
    status: pending
    dependencies:
      - kv-binding
  - id: user-scope-prefix
    content: 在 src/index.ts 引入 UserScope（username/ 前缀）并改造所有 WebDAV handlers（含 PROPFIND、列表、COPY/MOVE Destination）保证严格隔离
    status: pending
    dependencies:
      - multi-user-auth
  - id: admin-api
    content: 在 src/index.ts 增加 /admin/users 管理 API（Bearer ADMIN_TOKEN 保护），支持增删查用户
    status: pending
    dependencies:
      - kv-binding
  - id: docs-examples
    content: 在 README.md 增加 curl 示例：创建用户、列用户，以及 WebDAV 客户端连接方式
    status: pending
    dependencies:
      - admin-api
      - user-scope-prefix
---

# 多用户隔离式 r2-webdav（KV + username/ 前缀）

## 目标

- **多人使用**：每个用户用自己的 WebDAV 账号登录。
- **强隔离**：用户只能访问自己在 R2 中的 `username/` 前缀下的对象，互相不可见、不可越权。
- **可管理**：提供一个管理员 API 用于增删用户（不依赖手工改代码）。

## 总体做法（关键点）

- **认证**：解析 `Authorization: Basic ...`，拿到 `username/password`，到 KV 里读取该用户的密码散列并校验。
- **隔离映射**：所有 WebDAV 资源路径 `path` 都映射到 R2 key：`key = username + '/' + normalized(path)`；所有列目录/PROPFIND 返回给客户端的路径都要把 `username/` 前缀再去掉。
- **管理员 API**：以 `Authorization: Bearer <ADMIN_TOKEN>` 保护 `/admin/*`，提供创建/删除/列出用户。
```mermaid
flowchart TD
  client[WebDAVClient] --> worker[WorkerFetch]
  worker -->|"BasicAuth(username,password)"| auth[KVUserAuth]
  auth -->|ok| scope[BuildUserScope(usernamePrefix)]
  scope --> webdav[WebDAVHandlers]
  webdav --> r2[R2Bucket]
  adminClient[AdminClient] -->|"Bearer ADMIN_TOKEN"| admin[AdminAPI]
  admin --> kv[KVNamespace(users)]
  auth --> kv
```




## 需要改动的文件

- 主要逻辑：[`src/index.ts`](D:/code/r2-webdav/src/index.ts)
- 绑定配置：[`wrangler.toml`](D:/code/r2-webdav/wrangler.toml)
- 使用说明：[`README.md`](D:/code/r2-webdav/README.md)

## 实现步骤（最小改动、但保证隔离正确）

1. **接入 KV 绑定**（`wrangler.toml`）

- 增加 `[[kv_namespaces]] `绑定（例如 `binding = "users"`）。
- 新增 secret：`ADMIN_TOKEN`（用于管理员 API）。

2. **改认证模型：从单用户 env 变成多用户 KV**（`src/index.ts`）

- 保留现有 Basic realm 行为，但把 `is_authorized(header, env.USERNAME, env.PASSWORD)` 替换为：
    - `parseBasicAuth(header)` 解出 `username/password`
    - `loadUser(username)` 从 KV 读 `user:<username>`
    - 用 WebCrypto（PBKDF2）校验密码散列（对比用 `timingSafeEqual`）。
- 增加用户名校验（只允许安全字符，例如 `[a-zA-Z0-9._-]`），避免把奇怪的用户名变成危险前缀。

3. **做“用户作用域”映射层，确保所有 handler 都走同一套前缀规则**（`src/index.ts`）

- 新增 `normalizePath()`：去掉开头 `/`，移除末尾 `/`（与现状一致），并显式处理 `.`/`..`（防逃逸）。
- 新增 `UserScope`：
    - `toKey(path)` => `username + '/' + normalizedPath`
    - `fromKey(key)` => 去掉 `username + '/'`，用于生成 href/显示名。
- 修改各 handler（`GET/PUT/DELETE/MKCOL/PROPFIND/PROPPATCH/COPY/MOVE`）统一使用 `scope.toKey()` 与 `scope.fromKey()`：
    - 列目录与 PROPFIND 时，只 list `prefix = username + '/' + (path? path + '/' : '')`。
    - 返回给客户端的 `<href>` 只能是“去前缀后的路径”。
    - `COPY/MOVE` 的 `Destination` 必须同样经过 `normalizePath()` 并映射到同一用户 scope；禁止跨用户。

4. **加管理员 API（/admin/*）**（`src/index.ts`）

- 在 `fetch()` 里先判断 `pathname.startsWith('/admin/')`，走管理路由，不走 WebDAV。
- Bearer 校验：`Authorization: Bearer <ADMIN_TOKEN>`。
- 提供最小但够用的接口：
    - `POST /admin/users`：创建/更新用户（body: `{username,password,isAdmin?}`）。
    - `DELETE /admin/users/:username`：删除用户。
    - `GET /admin/users`：列出用户（不返回密码散列）。
- KV key 规范：`user:<username>`。

5. **更新 README**（`README.md`）

- 增加 KV 绑定创建指引。
- 增加 `ADMIN_TOKEN` 的配置方法。
- 给出创建用户的 curl 示例，以及 WebDAV 客户端如何用该用户登录。

## 兼容性与迁移

- 现有 R2 数据如果之前是“无前缀的全局 key”，迁移到多用户后需要放到某个用户前缀下（例如整体移动到 `alice/`）。