# Runbook · 把消费项目从 SOLO v1.0 升级到 v1.1

> 适用:用 `deploy/scaffold/init.sh` 派生、`.solo-version` = `v1.0.x` 的项目(如 my-app)。
> 原则:**[Solo] 文件整体覆盖,[Project] 文件一律不动。** 升级是替换 artifact,不是改业务代码。
> 校对基准:2026-06-14(SOLO v1.1.0)。权威以 `deploy/scaffold/README.md` §升级 + 本文为准。

---

## 0. v1.0 → v1.1 关键变化(升级前必读)

| 维度 | v1.1 带来的变化 | 升级动作 |
|------|----------------|---------|
| **bundle** | `solo.v1.1.0.js`(含 v1.1 治理线 + 生产硬化包) | 覆盖 |
| **library/** | 新增 `risk` `cors` `health` `walarchiver` `validate` `jsonlogic` `permit` `optimistic` 等 | 整目录覆盖(自动带) |
| **deploy/seed-registry.js** | ⭐**新文件**:启动时把服务注册表写进 Redis `active_services` | **手动补 + 接线 run.sh**(见 §2) |
| **run.sh** | 新增 seed-registry 调用 + redis-stack 启动 | 刷新(见 §2) |
| **redis** | orchestrator/storage/nexus/walarchiver 依赖 **RedisJSON** | 必须 `redis-stack-server`(见 §2) |
| **services.solo.json** | 模板已含 13 服务(storage 已并入) | 项目自有,**不覆盖**;按需加服务行 |
| **治理线(可选)** | 分层审批 + 签名审批人 + approval 消费 + orchestrator C1 审核闸 | 用 orchestrator 工作流才需接入(§4) |

> ⚠️ **最容易踩的洞 = 服务注册。** v1.0 的脚手架没有 `seed-registry.js`,run.sh 也不注册服务——靠 Redis 里**已持久化**的 `active_services` 撑着。一旦换新 bundle + 清过 Redis / 全新部署,Router 启动只认识 administrator,其余方法全 `-32601 Method not found`。**§2 的 seed-registry 是这次升级的重点,不是可选。**

---

## 1. 机械替换([Solo] 文件,整体覆盖)

> ⚡ **现在一条命令搞定本节 + 前端 bundle**:
> ```bash
> cd /path/to/solo && bash deploy/scaffold/upgrade.sh /path/to/<project>
> #   先 --dry-run 预览;它会构建 bundle + 前端、整目录覆盖 library/sample/autocheck、
> #   把 system/mobile tarball 钉到当前版本并清旧、补缺失的 seed-registry.js,
> #   并跑升级后自检。[Project] 文件一律不动;改过的 run.sh 等不覆盖,只把新 stock
> #   存成 <name>.solo-v{ver}.new 供你 diff(见 §2.1 的接线 + §2.2 的 redis-stack)。
> ```
> 下面是它等价的手工步骤(想手动做、或要理解它在干嘛时看)。

```bash
SOLO=/path/to/solo
PROJ=/path/to/<project>
NEW_VER=v1.1.0

# 1) 构建新 bundle(SOLO 侧)
cd "$SOLO" && bash deploy/build.sh                 # 产出 api/publish/solo.js

# 2) 覆盖 bundle + 版本标记
cp api/publish/solo.js "$PROJ/api/publish/solo.${NEW_VER}.js"
echo "$NEW_VER" > "$PROJ/.solo-version"

# 3) 同步 Solo 提供给私有 apps 引用的源码目录(整目录覆盖)
cp -r api/library   "$PROJ/api/library"
cp -r api/sample    "$PROJ/api/sample"
cp -r api/autocheck "$PROJ/api/autocheck"

# 4) 前端 bundle(system / mobile 走 bundle,均钉 .solo-version;v1.1 两端都有更新)
cd "$SOLO" && bash deploy/build-frontend.sh        # 自动清旧 + 钉 ${NEW_VER}
cp portal/publish/system.${NEW_VER}.tar.gz "$PROJ/portal/publish/"
cp client/publish/mobile.${NEW_VER}.tar.gz "$PROJ/client/publish/"
```

> 旧 bundle(`solo.v1.0.0.js`、旧前端 tarball)可留可删——`.solo-version` 决定 run.sh 加载哪个。
>
> `portal/operator` 是**源码分发、团队所有**,升级**不覆盖**;要参考 Solo 新版运维台 UI 时手动 diff `portal/operator/`(详见 `deploy/scaffold/README.md` 的「前端 bundle 分发」)。

**不动**(项目所有):`.env` · `.keypair` · `api/seed.json` · `deploy/solo-services.json` · `deploy/services.json` · `deploy/seed.json` · `api/apps/` · `portal/operator/` 团队改过的源码。

---

## 2. v1.1 新增的手动步骤(重点)

### 2.1 补 `seed-registry.js` + 接线 run.sh

```bash
cp "$SOLO/deploy/scaffold/seed-registry.js" "$PROJ/deploy/seed-registry.js"
```

`run.sh` 是 [Solo→Project] 文件,v1.1 在「确保 Redis」之后、「启动 bundle」之前**加了 seed-registry 调用**。两种做法:

- **A(推荐,项目没改过 run.sh)**:直接覆盖 `cp "$SOLO/deploy/scaffold/run.sh" "$PROJ/deploy/run.sh"`。
- **B(项目改过 run.sh)**:手动把这段插到启动 bundle 之前:
  ```bash
  if [ -f "$SCRIPT_DIR/seed-registry.js" ]; then
      REDIS_URL="$REDIS_URL" node "$SCRIPT_DIR/seed-registry.js" \
          || log_warn "seed-registry failed — services can still be added via the system portal"
  fi
  ```

> 它读 `solo-services.json` + `services.json`,把每个服务(router 除外)写成 stub 进 `active_services`;Router boot 载入,约 2s 后自动内省补全方法表。幂等,已在表里的跳过。

### 2.2 Redis 必须是 redis-stack(RedisJSON)

v1.1 多个服务/套件用 `JSON.SET` 与 stream。普通 `redis-server` 会让它们**挂死(非报错,无限等)**。

- 本地:`redis-stack-server --port <你的端口> --daemonize yes`(v1.1 的 run.sh 已优先用它)。
- 生产:redis-stack + `requirepass` + 内网绑定。

### 2.3 (按需)往 `solo-services.json` 加服务

`solo-services.json` 不覆盖。若要用 v1.1 才接入的能力(如 approval 消费),在其中加一行并挑一个空闲端口,重启即生效。storage 若你之前手动加过,保持即可。

---

## 3. 升级后验证(逐项过)

```bash
cd "$PROJ"
# 1) 起栈
bash deploy/run.sh --plain --no-ssl &
# 2) 注册表写入了?(应列出你启用的服务)
redis-cli -p <redis端口> --raw GET active_services | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>console.log(Object.keys(JSON.parse(d))))"
# 3) Router 能路由?(挑一个公开方法,不该返回 -32601)
curl -s -X POST -H 'Content-Type: application/json' --data '{"jsonrpc":"2.0","method":"<svc>.<entity>.list","params":{},"id":1}' http://localhost:<router端口>/
# 4) 私有 app autocheck 仍绿
node api/autocheck/checker.js api/apps/<svc> --static
# 5) 有 e2e 的项目跑一遍
( cd e2e && npm test )
```

通过标准:`active_services` 含全部启用服务 · 公开方法不再 -32601 · autocheck 无 ERROR · e2e 绿。

---

## 4. (可选)接入 v1.1 治理线

只有用 `orchestrator` 工作流的项目才相关。v1.1 起:`workflow.create` 默认进 `PENDING_REVIEW`(C1 审核闸),需经审批才转 ACTIVE;高风险走 approval 多签 + 签名审批人。详见 `docs/planning/VERSION.md §3` 与 `api/core/orchestrator/AUDIT.md`。不用 orchestrator 的项目无感。

---

## 5. 破坏性变更与排查

> ⚠️ **本文未做逐方法的 v1.0→v1.1 API 破坏性审计。** 首次真实升级一个项目时,用 §3 的 e2e + autocheck 兜底,把暴露的破坏点回填到这里。已知需留意:

- **Router 压缩 token**:微服务 auth middleware 必须 `req.user`=UID 字符串、`req.permit`=`'admin'|'user'`、`req.constraints`=对象(`library/router-auth.js parseRouterToken` 已封装)。v1.0 若有服务自写解析、把整个 payload 当 `req.user`,升级后会错——改用共享解析。
- **方法目录裁剪**:v1.1 外部 snapshot 只见 ACTIVE + ai:true 方法。若前端依赖 introspection 拿全量目录,注意可见面变窄。
- **公开白名单**:`router/logic/system.js` 的公开方法集若有调整,核对你前端用到的免鉴权方法仍在表内。
