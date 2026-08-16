# 生产部署

本部署方案适用于以下结构：Sub2API 和 PostgreSQL 已在应用服务器宿主机运行，扩展在该服务器使用 Docker，Nginx 位于另一台服务器。扩展只与 Sub2API 共用 PostgreSQL 实例，不共用数据库和数据库账号。文中的域名、IP、数据库账号和数据库名均为占位示例，部署前必须替换。

## 1. 克隆代码

新服务器需要先配置 GitHub SSH Key 或具有私有仓库读取权限的访问令牌，然后将项目克隆到固定目录：

```bash
cd /opt
git clone git@github.com:DeanZFC/sub2api-extension.git
cd /opt/sub2api-extension
```

使用 HTTPS 时，GitHub 会要求使用访问令牌而不是账号密码：

```bash
git clone https://github.com/DeanZFC/sub2api-extension.git /opt/sub2api-extension
```

确认服务器已经安装 Docker。本文使用 Compose V2 的 `docker compose`；如果服务器只有旧版
`docker-compose`，可以把后续命令中的 `docker compose` 原样替换为 `docker-compose`。

```bash
docker --version
docker compose version
systemctl enable --now docker
```

## 2. 创建扩展数据库和用户

不要让扩展使用 PostgreSQL 超级用户，也不要把表建进现有 Sub2API 数据库。先生成一个只含十六进制字符的随机密码，记录到安全的密码管理器中：

```bash
openssl rand -hex 24
```

然后使用 PostgreSQL 系统管理员创建独立登录角色。命令会交互询问两次密码，不会把密码写进 shell 历史：

```bash
sudo -u postgres createuser \
  --login --pwprompt --no-superuser --no-createdb --no-createrole \
  sub2api_extension_user

sudo -u postgres createdb \
  --owner=sub2api_extension_user \
  --encoding=UTF8 --template=template0 \
  sub2api_extension

sudo -u postgres psql -d sub2api_extension \
  -c 'GRANT ALL ON SCHEMA public TO sub2api_extension_user;'
```

验证扩展账号能够登录自己的数据库。该命令会交互询问密码：

```bash
psql -h 127.0.0.1 -U sub2api_extension_user -d sub2api_extension \
  -c 'select current_user, current_database(), now();'
```

如果 `createuser` 或 `createdb` 提示对象已存在，先用下面的只读查询确认是否正是准备给扩展使用的对象，不要直接删除现有角色或数据库：

```bash
sudo -u postgres psql -c '\du sub2api_extension_user'
sudo -u postgres psql -c "select datname, pg_catalog.pg_get_userbyid(datdba) as owner from pg_database where datname = 'sub2api_extension';"
```

## 3. 上线前检查

确认 DNS 的 `A` 记录已经把扩展域名指向 Nginx 服务器公网 IP：

```bash
dig +short extension.example.com
```

再次确认扩展数据库和账号可以在宿主机登录。执行时会交互询问密码，不要把密码直接写进 shell 历史：

```bash
psql -h 127.0.0.1 -U sub2api_extension_user -d sub2api_extension \
  -c 'select current_user, current_database();'
```

## 4. 配置环境

进入刚刚克隆的项目并创建只保存在服务器上的生产配置：

```bash
cd /opt/sub2api-extension
cp .env.example .env
chmod 600 .env
openssl rand -hex 32
```

编辑 `.env`，必须替换以下三项：

```dotenv
SUB2API_ADMIN_API_KEY=新创建的管理员APIKey
SESSION_SECRET=刚刚生成的随机值
DATABASE_URL=postgresql://sub2api_extension_user:数据库密码@127.0.0.1:5432/sub2api_extension
```

同时根据新的 Sub2API 和扩展域名检查以下配置。管理员 API Key 必须在这套新的 Sub2API
实例中重新创建；旧实例的 Key 不应复用：

```dotenv
SUB2API_BASE_URL=https://ai.example.com
FRAME_ANCESTORS=https://ai.example.com
SESSION_COOKIE_SECURE=true
SESSION_COOKIE_SAME_SITE=Lax
LOCAL_TEST_ENABLED=false
ACTIVITY_TIME_ZONE=Asia/Shanghai
```

如果扩展与 Sub2API 不属于同一个主域名，跨站 iframe 需要把
`SESSION_COOKIE_SAME_SITE` 改成 `None`。如果有两个 Sub2API 域名，使用空格把两个完整 origin
都写入 `FRAME_ANCESTORS`。

数据库密码如果含有 `@`、`:`、`/`、`?`、`#`、`%` 等字符，必须先做 URL 编码。不要再次使用曾粘贴到聊天、截图或日志里的旧数据库密码和管理员 API Key。

## 5. 构建、初始化并启动

生产 Compose 使用 Linux 的 host 网络。容器因此可以通过 `127.0.0.1:5432` 访问同一台应用服务器上的 PostgreSQL。扩展监听应用服务器的 `0.0.0.0:8081`，供另一台 Nginx 服务器反向代理。

```bash
cd /opt/sub2api-extension
docker compose config
docker compose build
docker compose run --rm extension npm run db:setup
docker compose run --rm extension npm run db:verify
docker compose up -d
docker compose ps
docker compose logs --tail=200 extension
curl --fail http://127.0.0.1:8081/health
```

`db:setup` 是幂等操作：数据库已存在时不会重建，只会初始化或升级扩展表结构。健康检查成功后应返回 HTTP 200。

确保 PostgreSQL 和 Docker 都设置为开机启动：

```bash
systemctl enable postgresql
systemctl enable docker
```

服务器重启后若入口和调用日志同时报错，而 PostgreSQL 手动连接正常，说明扩展持有的旧连接已失效，可重新建立连接：

```bash
docker compose restart extension
```

## 6. 限制应用服务器的 8081 端口

优先让两台服务器通过内网 IP 或 WireGuard 等私有网络通信。应用服务器必须在云安全组和系统防火墙中，将 TCP `8081` 的入站来源限制为 Nginx 服务器 IP，不能向整个公网开放。

例如应用服务器使用 UFW 时，将占位符替换为 Nginx 服务器访问应用服务器时使用的源 IP：

```bash
sudo ufw allow from NGINX_SERVER_IP to any port 8081 proto tcp
sudo ufw status numbered
```

还需要在云厂商安全组中配置相同的来源限制。不要只依赖 UFW；如果当前服务器使用的是 firewalld、nftables 或其他防火墙，应使用对应规则。

从 Nginx 服务器测试后端连接，成功时应返回 HTTP 200：

```bash
curl --fail http://EXTENSION_SERVER_PRIVATE_IP:8081/health
```

如果两台服务器之间只能走公网，仍必须把 `8081` 限制为仅允许 Nginx 服务器公网 IP。由于入口请求包含短期登录令牌，更推荐建立私有网络或在应用服务器上再启用回源 HTTPS，不应让两台服务器之间的敏感流量长期通过明文公网传输。

## 7. 在独立 Nginx 服务器配置 HTTPS

把 `deploy/nginx/extension.example.com.conf` 传到 Nginx 服务器，将文件中的 `extension.example.com` 替换为实际扩展域名，并将 `EXTENSION_SERVER_PRIVATE_IP` 替换为扩展部署服务器的内网 IP。然后在 Nginx 服务器安装 Nginx 与 Certbot。Ubuntu/Debian 可执行：

```bash
sudo apt update
sudo apt install -y nginx certbot python3-certbot-nginx
sudo cp extension.example.com.conf /etc/nginx/sites-available/extension.example.com.conf
sudo ln -s /etc/nginx/sites-available/extension.example.com.conf \
  /etc/nginx/sites-enabled/extension.example.com.conf
sudo nginx -t
sudo systemctl reload nginx
sudo certbot --nginx --redirect -d extension.example.com
sudo nginx -t
sudo systemctl reload nginx
```

如果同名 `sites-enabled` 链接已经存在，不要重复执行 `ln -s`。Nginx 不应覆盖扩展返回的 `Content-Security-Policy` 或 `Set-Cookie` 响应头。

如果使用 Cloudflare 代理，部署后在 Cloudflare 控制台将 SSL/TLS 加密模式设为
“完全（严格）”，不要使用“灵活”。当前 Nginx 配置不解析 Cloudflare 的真实访客 IP，
因此扩展调用日志和应用限流记录的是直接连接 Nginx 的来源 IP。

验证公网入口：

```bash
curl --fail https://extension.example.com/health
```

## 8. 配置 Sub2API 菜单

在 Sub2API 后台添加两个自定义菜单，固定 URL 中不要填写用户 ID 或令牌：

| 菜单 | 可见角色 | URL |
| --- | --- | --- |
| 活动中心 | 普通用户和管理员 | `https://extension.example.com/entry/activities` |
| 活动管理 | 仅管理员 | `https://extension.example.com/entry/activities/admin` |

即使普通用户手工输入管理入口，扩展后端仍会实时验证 Sub2API 角色并拒绝访问。

## 9. 上线验收

分别使用管理员和普通用户从 Sub2API 菜单进入，检查：

1. 管理员可以打开活动管理，普通用户访问管理入口会被拒绝。
2. 活动中心能正常加载，浏览器地址中的一次性 `token` 登录后会被清除。
3. 创建一条测试活动，普通用户可以按条件参与或收到不符合条件提示。
4. 管理页“调用日志”能记录测试请求，且不保存 JWT、Cookie、API Key 和请求体。
5. 重启容器后活动数据仍然存在：

```bash
docker compose restart extension
curl --fail http://127.0.0.1:8081/health
```

不要执行 `docker-compose down -v`。扩展业务数据虽然位于 PostgreSQL，但仍应对 `sub2api_extension` 独立数据库配置定期 `pg_dump` 备份。
