# Sub2API 活动扩展

这是一个独立于 Sub2API 部署的活动服务，不修改 Sub2API 源码，也不读取或写入 Sub2API 业务库。它通过 Sub2API API 校验用户身份，并在用户参与时实时读取当前用户数据。扩展业务数据可以保存在同一 PostgreSQL 实例的独立数据库中，也可以在本地使用 SQLite，提供以下能力：

- 管理员创建并启动抽奖，用户点击“参与抽奖”并实时通过“当前余额”“累计充值金额”“最近 N 天累计充值金额”等 `AND`、`OR` 组合条件后才会进入参与池。
- 管理员创建每日签到活动，可配置参与条件、开放时间和可选余额奖励；用户详情页按月历展示本月签到日期。
- 管理员为 Sub2API 真实专属分组配置资格活动；只有用户手动申请并满足累计充值金额、当前余额或组合条件后，才会安全追加目标分组。活动结束后对用户隐藏，到达单独配置的分组撤销时间后再自动撤销本活动发放的授权。
- 管理员只从已主动参与且参与时校验通过的用户中锁定名单、随机无放回开奖；可配置定时自动开奖，也可随时手动开奖。
- 奖品支持 Sub2API 可向现有用户自动兑换的余额、并发额度、订阅，以及需要管理员确认的实体或其他人工奖品。

## 累计充值金额的数据来源

扩展使用自己的独立数据库保存抽奖参与记录、分组资格规则、扩展自己授予的分组成员记录、参与时资格快照、开奖结果、发奖任务、会话和审计记录。生产环境推荐在 Sub2API 的 PostgreSQL 实例中新建 `sub2api_extension` 数据库，本地开发也可以继续使用 SQLite。用户点击参与、签到或申请分组时，扩展只实时查询该用户的 Sub2API 数据；它不会访问任何外部支付平台。

“累计充值金额”在用户参与时同时实时读取 Sub2API 用户详情和该用户的
`/admin/users/:id/balance-history` 累计值，并取两者中的较大值。这样既能覆盖支付后写入用户累计值的直接充值，也能覆盖以下正数记录：

- `balance`：余额兑换码，以及支付充值最终在 Sub2API 中生成的余额记录。
- `admin_balance`：管理员直接加款记录。

配置“近期充值金额”时，可以填写 `1–365` 天和金额门槛。例如“最近 7 天大于等于 10 元”或“最近 30 天大于等于 50 元”。用户点击参与、签到或申请资格时，扩展才会按规则需要的最远时间窗口，分页读取该用户的 `balance`、`admin_balance` 流水；遇到早于窗口起点的记录后停止，不扫描其他用户。“最近一个月”按滚动最近 30 天计算。

扩展自身发放的抽奖、签到余额奖励会根据本地发奖记录从累计充值金额中扣除，不会反向增加充值金额。累计充值采用历史口径：后续消费或余额降低不会减少累计充值。整个判断只查询当前正在操作的用户，不扫描或同步全部用户、兑换码。扩展数据库保存活动和参与结果等业务数据，不是一次性缓存，必须持久化并备份。

## Sub2API 专属分组准备

1. 先在 Sub2API 后台创建或编辑目标分组，例如默认倍率 `0.01x` 的“狂欢分组”。
2. 必须将目标分组设为“专属分组”并保持启用；公开分组默认对所有用户可用，无法实现“只给部分人”。
3. 进入扩展的“分组资格”页面，选择该分组，配置“累计充值金额”、“当前余额”或 `AND`/`OR` 组合条件。
4. 资格活动会显示在用户活动中心。系统不会扫描存量或增量用户，只有用户点击申请时才实时检查当前条件并加入分组；不满足时会显示具体原因。到达活动结束时间后，活动对用户隐藏且停止申请；到达更晚的分组撤销时间后，后台才撤销本活动发放的授权。

每个 Sub2API 分组最多只能有一条授权规则。扩展写回用户时只更新 `allowed_groups`：它会先重新读取用户最新分组，做并集后再写回，不会覆盖用户的其他分组，也不会修改图中的“专属倍率”（`group_rates`）。

当前 Sub2API 的公开管理员接口只支持整组更新 `allowed_groups`，没有单个分组的原子增删接口。扩展已把“读取最新用户”放在写回前，并串行化自身对同一用户的操作；仍应避免管理员或其他服务恰好在同一瞬间修改同一用户的专属分组。彻底消除此窗口需要 Sub2API 将现有的原子增删能力暴露为管理员 API，本扩展不会为此修改 Sub2API 源码。

用户申请成功后，不会因为余额后续变化而被后台自动撤销。分组撤销时间必须晚于活动结束时间；两个时间之间活动已经对用户隐藏，但已领取分组仍然有效。到达撤销时间后系统自动撤销，失败会在后续周期继续重试；管理员也可以在管理页面提前撤销并立即停用活动。用户原本就有的授权会标记为 `preexisting`，不会被扩展删除；停用规则只会隐藏活动并阻止新申请，删除规则时也会明确撤销扩展通过该规则添加的授权。到期检查周期可通过 `GROUP_EXPIRY_INTERVAL` 调整，默认 `10s`。

`allowed_groups` 表示用户获得该专属分组的选择/绑定权限。本扩展不会强制把用户已有的 API Key 迁移到“狂欢分组”；如果需要使用 `0.01x` 倍率，用户仍需让对应 API Key 绑定该分组。

## 准备 Sub2API 管理员 API Key

1. 使用管理员账号进入 Sub2API 后台，在 API Key 管理中创建一个管理员 API Key。
2. 将 Key 只填入扩展服务器的 `.env`：`SUB2API_ADMIN_API_KEY=...`。
3. 确认 `SUB2API_BASE_URL` 是 Sub2API 的站点根地址，例如 `https://ai.example.com`，不要附加 `/api/v1`。

管理员 API Key 权限较高，只能保存在扩展后端环境变量中。不要把它写入前端源码、自定义菜单 URL、浏览器参数、截图或日志。用户从菜单进入时携带的是 Sub2API 为当前用户生成的短期登录令牌，扩展校验后会换成自己的 HttpOnly 会话，并跳转到不含令牌的 URL。

## Docker 部署

要求服务器已安装 Docker Engine 和 Docker Compose 插件，并已为扩展域名配置 DNS。

PostgreSQL 位于 Docker 宿主机、Nginx 位于另一台服务器时的完整操作步骤见
[`deploy/PRODUCTION.md`](deploy/PRODUCTION.md)。所有域名、IP、账号和密钥均通过 `.env`
或部署配置注入，源码和示例文件不保存任何实际环境信息。

```bash
cd /path/to/sub2api-extension
cp .env.example .env
openssl rand -hex 32
```

编辑 `.env`，至少替换以下值：

```dotenv
SUB2API_BASE_URL=https://ai.example.com
SUB2API_ADMIN_API_KEY=replace-with-your-admin-api-key
SESSION_SECRET=replace-with-the-generated-random-value
FRAME_ANCESTORS=https://ai.example.com
ACTIVITY_TIME_ZONE=Asia/Shanghai
# 推荐使用同一 PostgreSQL 实例中的独立数据库，不要填写现有 Sub2API 业务库。
DATABASE_URL=postgresql://extension_user:password@postgres.example.com:5432/sub2api_extension?sslmode=require
```

`ACTIVITY_TIME_ZONE` 同时控制页面时间显示、管理端活动时间输入和每日签到日期。数据库仍以 UTC
保存时间，不需要在 `DATABASE_URL` 中追加时区参数，也不受数据库服务器所在国家影响。

首次使用 PostgreSQL 时，先按 [`deploy/PRODUCTION.md`](deploy/PRODUCTION.md) 创建独立的低权限
数据库用户和数据库，再构建镜像并执行幂等初始化脚本。数据库已经存在时，该脚本只初始化或升级扩展表：

```bash
docker compose build
docker compose run --rm extension npm run db:setup
```

然后校验配置并启动：

```bash
docker compose config
docker compose up -d --build
docker compose ps
docker compose logs -f extension
```

默认只监听宿主机 `127.0.0.1:8081`。设置 `DATABASE_URL` 时活动数据保存在 PostgreSQL；不设置时使用命名卷 `sub2api-extension-data` 中的 SQLite。健康检查地址为 `http://127.0.0.1:8081/health`。

```bash
curl --fail http://127.0.0.1:8081/health
```

## HTTPS 反向代理示例

生产环境必须通过 HTTPS 访问扩展。下面是 Nginx 的核心配置，证书路径按实际环境填写：

```nginx
server {
    listen 443 ssl http2;
    server_name activity.example.com;

    # /entry/activities 的首次请求会携带短期登录令牌，避免令牌进入默认访问日志。
    access_log off;

    ssl_certificate     /etc/letsencrypt/live/activity.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/activity.example.com/privkey.pem;

    client_max_body_size 1m;

    # 生产环境禁止通过反向代理访问本地测试入口。
    location ^~ /local-test/ {
        return 404;
    }

    location / {
        proxy_pass http://127.0.0.1:8081;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

不要在 Nginx 中覆盖扩展返回的 `Content-Security-Policy` 或 `Set-Cookie` 响应头。

反向代理覆盖 `X-Real-IP` 且扩展端口只监听本机时，设置 `TRUST_PROXY=true`。扩展内置按 IP 的单进程限流：登录入口、活动参与、管理接口、普通写接口和查询接口可分别通过 `RATE_LIMIT_*` 调整。若部署多个扩展实例，还应在 Nginx 或 Redis 层配置共享限流，应用内存限流不跨实例共享。

所有 `/api/`、`/entry/` 和 `/local-test/` 调用都会保存到扩展数据库的调用日志中，管理员可在“调用日志”页面按 IP、用户和接口筛选。日志不保存查询参数、JWT、Cookie、API Key、CSRF 或请求体；连续限流请求会按 IP、接口和时间窗口聚合计数，默认保留 30 天，可通过 `API_LOG_RETENTION_DAYS` 调整。

## 域名、iframe 和 Cookie

推荐将扩展部署在与 Sub2API 相同主域名的子域，例如：

- Sub2API：`https://ai.example.com`
- 扩展：`https://activity.example.com`

此时配置：

```dotenv
FRAME_ANCESTORS=https://ai.example.com
SESSION_COOKIE_SAME_SITE=Lax
SESSION_COOKIE_SECURE=true
```

`FRAME_ANCESTORS` 必须填写允许嵌入扩展页面的 Sub2API **origin**（协议、域名和可选端口），不能带路径。多个来源以空格分隔。

只有扩展与 Sub2API 属于不同站点、且必须在跨站 iframe 中运行时，才改成：

```dotenv
SESSION_COOKIE_SAME_SITE=None
SESSION_COOKIE_SECURE=true
```

`SameSite=None` 必须配合 HTTPS 和 `Secure`。部分浏览器会继续限制第三方 Cookie，因此跨站方案需要在目标浏览器中实际验证；同主域名子域更稳定。
扩展在该模式下还会为会话 Cookie 添加 `Partitioned`，使支持 CHIPS（分区 Cookie）的现代浏览器可以在不同顶级站点的 iframe 中分别保存会话。对不支持分区 Cookie 或完全禁止第三方存储的浏览器，仍推荐为每个主域名配置同站点的扩展子域。

## 配置 Sub2API 自定义菜单

在 Sub2API 的自定义菜单中只需建立两个不同的固定入口：

| 菜单 | 可见角色 | URL |
| --- | --- | --- |
| 活动中心 | `user` | `https://扩展域名/entry/activities` |
| 活动管理 | `admin` | `https://扩展域名/entry/activities/admin` |

例如：

```text
https://activity.example.com/entry/activities
https://activity.example.com/entry/activities/admin
```

Sub2API 会在打开自定义页面时附加 `user_id`、`token`、`theme`、`lang` 等参数。`/entry/activities` 强制跳转活动中心，`/entry/activities/admin` 会先在后端验证真实管理员身份再跳转活动管理页面，两者都不依赖 `next`。旧的 `/entry`、`/entry/user`、`/entry/admin` 入口已删除，访问时会返回 `404`。以后新增其他页面时，继续在 `/entry/`下使用独立的页面模块名。不要手工把令牌写进固定 URL，也不要缓存或分享带令牌的完整访问地址。

管理员首次进入后，可在“分组资格”配置“狂欢分组”的申请条件；在“签到管理”配置每日活动；在“抽奖管理”创建抽奖并从详情页点击“启动抽奖”。启动后用户才会看到活动并可手动参与，管理员可随时手动开奖；配置自动开奖时间后也会在到点时自动开奖。用户不满足参与或申请条件时，页面会显示具体原因。

## 仅本机联调登录

不部署公网域名时，可以在只监听 `127.0.0.1` 的服务上临时开启测试登录：

```dotenv
HOST=127.0.0.1
SESSION_COOKIE_SECURE=false
LOCAL_TEST_ENABLED=true
LOCAL_TEST_SECRET=至少32字符的随机值
```

启动服务后，通过真实 Sub2API 用户 ID 进入：

```text
http://127.0.0.1:8081/local-test/entry?secret=本地测试密钥&user_id=1&next=/admin/lotteries
http://127.0.0.1:8081/local-test/entry?secret=本地测试密钥&user_id=2&next=/
```

该入口同时校验回环来源和独立密钥，并通过管理员 API 实时读取目标用户的真实角色；不会修改上游用户。同一浏览器的管理员和普通用户共享会话 Cookie，打开另一个角色入口会切换当前身份。结束本地测试后必须设置 `LOCAL_TEST_ENABLED=false`，生产环境禁止开启。

当 Sub2API 以 iframe 内嵌本地 HTTP 页面时，浏览器不会发送跨站 `SameSite=Lax` Cookie。在 `LOCAL_TEST_ENABLED=true` 且入口携带 `ui_mode=embedded` 时，扩展会自动通过 URL fragment 一次性交接会话，前端取得后会立即清除地址中的交接值。该机制只在回环地址的本地测试模式可用，生产部署仍必须使用 HTTPS 和 HttpOnly Cookie。

## 备份数据库

PostgreSQL 模式使用 `pg_dump` 备份独立扩展库，不要把它与 Sub2API 业务库混在同一个备份文件中：

```bash
pg_dump "$DATABASE_URL" --format=custom --file="sub2api-extension-$(date +%Y%m%d-%H%M%S).dump"
```

SQLite 模式备份前先停止服务，让 WAL 内容完整落盘：

```bash
mkdir -p backups
docker compose stop extension
docker compose cp extension:/app/data/extension.sqlite ./backups/extension-$(date +%Y%m%d-%H%M%S).sqlite
docker compose start extension
```

请把备份复制到另一台机器或对象存储。仅备份源码和 `.env` 不能恢复活动配置、名单及开奖结果；核心数据位于 PostgreSQL 独立库或 SQLite 卷中。

## 升级

升级前先按上一节备份数据库和当前 `.env`，再更新扩展源码并重建：

```bash
docker compose build --pull
docker compose up -d
docker compose ps
docker compose logs --tail=200 extension
curl --fail http://127.0.0.1:8081/health
```

服务启动时会自动执行所选数据库的结构迁移。SQLite 模式不要在升级过程中删除 `sub2api-extension-data` 卷，也不要使用 `docker compose down -v`，否则会删除持久化数据库。

## 常见排查

- 启动时报 `CONFIG_INVALID`：检查 `SUB2API_BASE_URL`、管理员 API Key 和至少 32 字符的 `SESSION_SECRET`。
- 页面拒绝被 iframe 嵌入：检查 `FRAME_ANCESTORS` 是否与浏览器地址栏中的 Sub2API origin 完全一致。
- iframe 内反复要求登录：先确认全站 HTTPS；跨站部署再检查是否同时使用 `SameSite=None` 和 `Secure`。
- 充值后无法申请专属分组：确认 Sub2API 中目标分组已启用并设为专属分组，再让用户进入对应资格活动手动点击申请；页面会实时返回余额或充值条件未满足的具体原因。
- 规则显示符合但用户原 API Key 倍率没变：自动授权只追加 `allowed_groups`，不会迁移已有 API Key；请检查该 Key 绑定的分组。
- 反向代理返回 502：检查 `docker compose ps`、容器日志以及宿主机 `127.0.0.1:8081/health`。
