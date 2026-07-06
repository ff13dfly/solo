# User 用户认证服务

服务名：`user` | 端口：`8710`

---

## 服务定位

Solo 系统的账号与身份管理中枢。负责用户注册/登录（SHA-256 挑战-响应）、Session 维护、权限存储与更新。不处理业务逻辑，只管"人"。

---

## 登录协议

采用 **SHA-256 挑战-响应**（对称哈希，**不是** Ed25519/公钥签名），两步完成：
1. `user.login.request({ name })`：服务端签发一次性挑战 `challenge`（存 `challenge:{name}`，120s TTL），回带注册时的 `salt`。
2. `user.login.verify({ name, challenge, response, deviceId })`：客户端算 `response = SHA256(challenge + hash)`（`hash = SHA256(password + salt)`，即注册时存入服务端的 `user.hash`）；服务端比对 `SHA256(challenge + user.hash)`，相等则签发 Session Token。

> - `user.hash` 在服务端**不透明**：注册时客户端算好原样存，服务端只做哈希比对、不重新派生密码。
> - **Ed25519 在本系统仅用于 Router→微服务的传输层签名**（`X-Router-Token`），与人登录无关。
> - 管理员是**另一套**：`admin.login.*` + PBKDF2，打 administrator 服务，勿混。
> - 参考客户端：`client/mobile/src/lib/api.ts`。

---

## 核心功能

### 账号管理
- 注册、软删除/恢复、永久销毁
- `user.update`：更新用户资料和分类绑定

### 权限管理
- `user.permit.update`：更新单个用户权限（含 `allow_all`、`services`、`constraints`）
- `user.permit.batch`：批量更新
- 权限结构见 `CLAUDE.md` → 权限体系

### 分类管理
- `user.category.*`：用户维度的分类（如角色标签、部门标注）

---

## 存储说明

- 用户主体：`user:{id}` Hash
- 用户名索引：`user:name:{username}` → id
- Session：`session:{token}` Hash，TTL 由 Router 控制
- 登录挑战：`challenge:{name}` 短 TTL（120s，一次性，验证成功即删）
