# QR 路由与解析协议 (QR Routing & Resolution Protocol)

> [!WARNING]
> **路由前缀注册表为约定示例，非已实现清单。** §3 中列出的 commodity / space / asset / authority 等业务服务在当前代码中**不存在**(SOLO 是纯框架)。QR URL 结构与解析契约本身是框架级设计，但具体业务服务的 `*.qr.resolve` 实现需各业务自行落地。判断以 `CLAUDE.md` §2 为准。

## 1. 概述

Solo·AI 采用**各服务自治 QR** 的体系：每个业务服务独立管理属于自己域的 QR 码（创建、绑定、解析），通过 URL 前缀字母与客户端路由表完成统一分发。

核心设计原则：
- **前缀即归属**：一个字母前缀对应一个服务，该服务拥有此前缀下 QR 的完整生命周期
- **统一接口契约**：所有服务的 `*.qr.resolve` 返回相同字段结构，客户端无需感知服务差异
- **客户端按前缀路由**：`client/qr` 根据 URL 前缀决定调用哪个服务的 resolve 方法

---

## 2. URL 结构规范

QR 码中编码的原始 URL 格式：

```
https://{domain}/{prefix}/{qrId}
```

- **prefix**：1 位路由字母，决定归属服务及业务意图
- **qrId**：Base58 编码的唯一标识，**位数由各服务自定义**（当前 commodity / asset 均为 6 位），由各服务的 QR Entity 生成

---

## 3. 路由前缀注册表 (Prefix Registry)

| 前缀 | 业务模型 | 归属服务 | resolve 方法 | 前端跳转路径 |
| :--- | :--- | :--- | :--- | :--- |
| **`p`** | 商品 (Product) | `commodity` | `commodity.qr.resolve` | `/product/:id` |
| **`s`** | 展位/货架 (Space) | `space` | `space.node.resolve` | `/space/:id` |
| **`a`** | 资产 (Asset) | `asset` | `asset.qr.resolve` | `/vehicle/:id` |
| **`u`** | 用户/身份 (User) | `authority` | *(待实现)* | `/user/:id` |

> **扩展原则**：新增业务实体时，由架构组分配 1 位字母前缀，同步更新本表、`client/qr` 的 `App.tsx` 路由表，并在对应服务中实现 `*.qr.*` 方法集。

---

## 4. 解析全生命周期 (Lifecycle)

### 4.1 扫码与前端分发

`client/qr` 的 `App.tsx` 为每个前缀注册独立路由，全部指向 `Resolver` 组件：

```
/p/:code  →  Resolver
/a/:code  →  Resolver
/s/:code  →  Resolver
```

### 4.2 逻辑解析 (Resolution)

`Resolver` 内的 `useResolveQr` hook 读取当前路径前缀，选择对应服务的 resolve 方法：

```ts
const prefix = location.pathname.split('/')[1];
const resolveMethod = prefix === 'a' ? 'asset.qr.resolve' : 'commodity.qr.resolve';
```

**RPC 入参**：`{ id: "7vA9W2" }`

**统一出参格式**（所有服务均须遵守）：

```json
{
  "id": "7vA9W2",
  "targetType": "asset.vehicle",
  "targetId": "kP2m4N",
  "meta": { }
}
```

| 字段 | 说明 |
| :--- | :--- |
| `id` | QR 码自身 ID |
| `targetType` | 绑定目标类型，未绑定时为 `null` |
| `targetId` | 绑定目标的实体 ID，未绑定时为 `null` |
| `meta` | 服务自定义扩展数据（如资产分类、商品信息等） |

### 4.3 视图路由 (View Dispatching)

`useResolveQr` 根据 `targetType` 进行二次跳转：

| targetType | 跳转路径 |
| :--- | :--- |
| `product` | `/product/:targetId` |
| `space` | `/space/:targetId` |
| `asset.vehicle` | `/vehicle/:targetId` |
| `null` | 停在 `UnboundView` |

---

## 5. 各服务 QR 方法规范

每个拥有 QR 前缀的服务，须实现以下标准方法集：

| 方法 | 职责 |
| :--- | :--- |
| `*.qr.create` | 生成未绑定的空白 QR 码 |
| `*.qr.list` | 列出该服务下的 QR 码 |
| `*.qr.bind` | 将 QR 绑定到具体实体 |
| `*.qr.resolve` | 解析 QR，返回统一格式响应 |

各服务在自己的 Redis 命名空间内维护 QR 实体（如 `ASSET:QR:*`、`QR:*`），互不干扰。

---

## 6. 绑定规范 (Binding)

### 6.1 未绑定流程 (Unbound Flow)

扫描到未绑定 QR（`targetType` 为空）后，进入 `UnboundView`：

1. **意图选择**：用户选择目标业务类型（商品 / 资产 / 其他）
2. **实体搜索**：调用对应服务的 `.list` 或 `.item.list` 接口（需支持 `keyword` 搜索）
3. **执行绑定**：调用该 QR 归属服务的 `*.qr.bind` 方法

| 前缀 | 绑定方法 |
| :--- | :--- |
| `p` | `commodity.qr.update` |
| `s` | `space.node.update` |
| `a` | `asset.qr.bind` |

### 6.2 反向查找

实体自身应存储 `qrId` 字段，支持从实体反查对应 QR 码。

---

## 7. 实现 checklist（新增服务接入 QR）

- [ ] 在前缀注册表（本文档 §3）中分配字母
- [ ] 服务实现 `*.qr.create / list / bind / resolve`，resolve 返回统一格式
- [ ] 在 `client/qr` 的 `App.tsx` 添加 `/{prefix}/:code → Resolver` 路由
- [ ] 在 `useResolveQr.ts` 的前缀映射中添加对应服务的 resolve 方法
- [ ] 实现对应的详情页面并注册到前端路由

---

## 8. 核心总结

QR 协议通过**"前缀归属 + 服务自治 + 统一契约"**的模式，实现了物理标签与业务逻辑的解耦：
- 每个服务完全控制自己域内的 QR 生命周期，无跨服务依赖
- 客户端通过前缀路由自动对接正确服务，扩展新业务类型无需修改现有服务
- 统一的 resolve 响应格式保证前端视图路由逻辑稳定不变

---

## 9. 外部交易安全 (Passport Integration)

当扫码后的后续业务逻辑涉及“外部非登录用户”的写操作（如：供应商确认接单、客户提交新订单）时，必须通过 **[Passport 协议](./passport.md)** 进行身份锚定，严禁仅依靠 URL 参数进行敏感数据修改。

### 9.1 权限升级路径

1.  **匿名解析**：用户扫码，调用 `*.qr.resolve` 获取实体信息（公开）。
2.  **身份挑战**：用户在视图中点击“提交/确认”，前端检测到无 `Passport` 令牌，立即呼起手机号验证补全。
3.  **令牌挂载**：验证成功后，通过 `Passport` 签发设备令牌。
4.  **安全写入**：后续的业务 RPC 请求（如 `supply.order.ack`）强制校验该令牌。

### 9.2 场景规范

| 扫码意图 | 读操作 (Public) | 写操作 (Passport Required) |
| :--- | :--- | :--- |
| **供应链协作** | 查看订单摘要、品名、数量 | 确认接单 (ACK)、修改交期、留言回复 |
| **自助下单/商城** | 查看产品详情、库存、价格 | 提交采购单、修改收货地址、取消订单 |
| **资产报修** | 查看资产履历、基本参数 | 提交故障申报、上传维修证明 |
