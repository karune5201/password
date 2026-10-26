# pwdash · 压缩包密码查询与解压工具

按**文件 MD5** 查压缩包解压密码，配套网页版、命令行工具和自建查询服务。
网页端可离线使用、可拖入文件自动算 MD5；命令行端支持自动查库解压与本地库维护。

> 仅用于找回**自己**遗忘密码的压缩包，或查询公开分享者公布的密码。请勿用于侵犯他人权利。

---

## 目录

- [能力一览](#能力一览)
- [目录结构](#目录结构)
- [快速开始](#快速开始)
  - [1. 网页版](#1-网页版)
  - [2. 命令行](#2-命令行)
  - [3. 自建服务端](#3-自建服务端)
- [命令速查](#命令速查)
- [数据格式与维护](#数据格式与维护)
- [多库：自己的库 / 陌生人的库](#多库自己的库--陌生人的库)
- [让别人上传 MD5 和密码](#让别人上传-md5-和密码)
- [全托管部署：GitHub + Cloudflare Workers & Pages](#全托管部署github--cloudflare-workers--pages)
- [其它部署方式](#其它部署方式)
- [安全与隐私](#安全与隐私)
- [测试](#测试)
- [从旧版迁移](#从旧版迁移)
- [常见问题](#常见问题)

---

## 能力一览

**网页版（`index.html`）**

| 能力 | 说明 |
| --- | --- |
| 按 MD5 查询 | 自动规范化大写、带空格/横线的输入，回车即查 |
| 拖入文件算 MD5 | 浏览器内流式计算，文件**不上传**；支持 7z / zip / rar 等任意文件 |
| 批量查询 | 一次粘贴多个 MD5（换行/空格/逗号分隔），结果列表可一键复制 |
| 密码打码 | 命中后默认打码，点「显示」看明文，一键复制 |
| 多库合并 | 可配任意多个库（如「自己的库」+「陌生人投稿库」），按顺序合并，**靠前优先**；设置里可增删、排序、启停 |
| 离线可用 | 合并结果整库缓存到 localStorage + Service Worker，断网照样查 |
| 只读设计 | 不提供导入/导出按钮，防止误把别人的库覆盖到自己身上；改库走 CLI |
| 公开投稿 | 「投稿」页签可把自己的密码提交给别人（进审核队列），支持从文件取 MD5 |
| 无痕 | 无埋点、无外链图片/字体，纯本地渲染 |
| 其他 | 深/浅色主题、查询历史、`/` 与 `Ctrl+K` 快捷键、`?md5=` 直达、可安装为 PWA |

**命令行（`cli/pwdkit.py`，零第三方依赖）**

- 查密码（本地库优先 → 可选自建服务端兜底，命中后自动缓存）
- 自动查库解压：算文件 MD5 → 查库 → 校验密码 → 解压，一步完成
- 库维护：新增、删除、列出（默认打码）、合并导入、导出、统计体检
- 与服务端双向同步（`sync push` / `sync pull`）
- 多解压后端自动降级，缺依赖时给出明确提示而**不会偷偷 pip install**

**云后端（`worker/`，Cloudflare Workers，零运维）**

- 数据放 GitHub、接口跑在 Workers、前端放 Pages —— 全流程不碰服务器
- 两套存储自动切换：**KV 模式**（快，省 GitHub API 配额）或**纯 GitHub 模式**（投稿直接变成 Issue）
- 自带手机可用的审核页 `/admin?token=…`，点两下就通过/拒绝

**自建服务端（`server/server.py`，纯标准库，可选）**

- `GET /query/<md5>`、`POST /upload`、`POST /bulk`、`GET /db`、`GET /stats`、`GET /health`
- 公开投稿：`POST /contribute`、`GET /contrib/count`、`GET /contrib/pending`、`POST /contrib/approve|reject`
- token 鉴权 + 按 IP 限流 + 请求体上限 + 默认只监听本机
- 日志只记路径与状态码，永不打印密码

---

## 目录结构

```
password/
├── index.html              # 网页版入口（部署到 Pages 时放在根目录）
├── manifest.webmanifest    # PWA 清单
├── sw.js                   # Service Worker（离线缓存）
├── assets/
│   ├── app.css             # 样式（明/暗主题，纯 CSS 变量）
│   ├── app.js              # 前端逻辑（多源、缓存、查询、批处理）
│   ├── md5.js              # 流式 MD5（WebCrypto 不提供 MD5）
│   └── icon.svg / icon-*.png
├── cli/
│   ├── pwdkit.py           # 命令行主程序
│   └── archive.py          # 解压后端抽象（zip/7z/rar 自动降级）
├── server/server.py        # 自建查询服务（可选，本机/VPS 用）
├── worker/                 # Cloudflare Workers 后端（推荐，零运维）
│   ├── src/index.js        #   单文件 Worker，KV / 纯 GitHub 双模式
│   ├── wrangler.toml       #   部署配置
│   └── package.json
├── .github/workflows/
│   ├── validate-db.yml     #   数据体检 + 冒烟测试（PR 门禁）
│   └── deploy.yml          #   自动部署 Worker + Pages
├── tools/
│   ├── pwlib.py            # 库读写层（原子写入 + 文件锁）
│   ├── build_db.py         # 库构建/清洗（体检、去脏数据、生成 gz 与 JSON）
│   ├── make_icons.py       # 生成 PWA 图标
│   ├── serve.py            # 本地预览静态服务
│   └── git-menu.sh         # 通用 git 操作菜单（原 1.sh）
├── tests/
│   ├── smoke.sh            # 全链路自测（80 项）
│   ├── dom_test.mjs        # jsdom 跑真实 app.js（29 项）
│   └── web_test.mjs        # 无头 Chrome 端到端（CDP，无需 puppeteer）
├── passwords_local.json    # 网页版明文库（发到 GitHub 供前端 fetch）
├── passwords_local.json.gz # 命令行用压缩库
├── community_passwords.json # 陌生人投稿库（审核通过后写入；初始为 {}）
├── data/rejected.json      # 被清洗掉的脏记录（备查，不参与查询）
├── pending_uploads.json.gz # 公开投稿的待审队列（首次有投稿时自动生成）
├── 1.py / 2.py             # 旧入口的兼容壳（等价于 pwdkit menu / build_db）
└── pwdash                   # 命令行快捷入口
```

---

## 快速开始

### 1. 网页版

直接打开 `index.html` 即可（本地 `file://` 也能用，但 Service Worker 离线缓存需 http 环境）。

本地预览：

```bash
python3 tools/serve.py            # → http://127.0.0.1:8080
```

### 2. 命令行

```bash
# 环境体检：看解压后端、库、服务端是否就绪
python3 cli/pwdkit.py doctor
# 或
./pwdash doctor
```

查密码：

```bash
./pwdash query 619293e69a6b5a90be2c04a6e3bf4715
./pwdash query -f 影片.7z              # 先算文件 MD5 再查
./pwdash query <md5> -q                # 只输出密码，方便脚本调用
cat md5list.txt | ./pwdash query - --json
```

用密码解压（自动查库）：

```bash
./pwdash extract 影片.7z                     # 自动算 MD5 → 查库 → 校验 → 解压到 ./影片/
./pwdash extract 影片.zip -o /sdcard/out     # 指定输出目录
./pwdash extract 影片.rar -p 手动密码 --verify-only   # 只验证密码对不对
./pwdash extract 影片.7z --upload            # 成功后把密码回传自建服务端
```

维护库：

```bash
./pwdash add --from-password 'password'  # 只给密码，自动反算 MD5 登记
./pwdash add <md5> <password>
./pwdash list --limit 20                # 默认打码
./pwdash list --reveal                  # 看明文
./pwdash remove <md5>
./pwdash export -o mydb.json            # 导出（json / gz / pretty）
./pwdash import other.json --overwrite  # 合并别人的库
./pwdash stats                          # 记录数、体积、脏 key 体检
./pwdash                                # 不带参数 = 交互菜单
```

退出码：`0` 成功 / `2` 用法错误 / `3` 库错误 / `4` 未找到 / `5` 解压失败 / `6` 缺依赖 / `7` 网络错误。

### 3. 自建服务端

```bash
PWDASH_TOKEN=换个长口令 python3 server/server.py --port 5000
```

- 未设置 `PWDASH_TOKEN` 时，写接口**只允许本机回环地址**调用；
- 想监听 `0.0.0.0` 必须先设置 token，否则拒绝启动；
- 反向代理后如需按真实 IP 限流，再设 `PWDASH_TRUST_PROXY=1`。

接口示例：

```bash
curl -s localhost:5000/health
curl -s localhost:5000/query/<md5>
curl -s -X POST localhost:5000/upload \
     -H 'Content-Type: application/json' -H "Authorization: Bearer $PWDASH_TOKEN" \
     -d '{"password":"your-password"}'    # 只给密码，服务端自己算 MD5
```

客户端对接：

```bash
export PWDASH_SERVER=http://127.0.0.1:5000
export PWDASH_TOKEN=换个长口令
./pwdash query <md5>        # 本地没有再问服务端
./pwdash sync pull          # 把服务端整库拉下来合并
./pwdash sync push          # 把本地库整库推上去
```

网页版也可以在「设置 → 私有服务端」填地址和 token，库里查不到时再问服务端。

---

## 命令速查

| 命令 | 作用 |
| --- | --- |
| `hash [-f 文件] [文本]` | 计算 MD5 |
| `query <md5…> [-f 文件] [-q] [--json] [--no-remote]` | 查密码 |
| `add [md5] [password] [--from-password P] [--upload]` | 登记密码 |
| `remove <md5…>` | 删除记录 |
| `list [--limit N] [--search S] [--reveal] [--json]` | 列出记录 |
| `stats [--json]` | 库体检 |
| `export [-o 文件] [-f json\|gz\|pretty]` | 导出 |
| `import <文件> [--overwrite]` | 合并导入 |
| `extract <压缩包> [-p 密码] [-o 目录] [--no-db] [--verify-only] [--force] [--upload]` | 解压 |
| `contribute [密码] [--md5 M]` | 把一条密码投稿到别人的服务端 |
| `review [--list] [--approve\|--reject MD5\|all] [--reveal]` | 管理员处理待审投稿 |
| `sync push\|pull [--overwrite]` | 与服务端同步 |
| `doctor` | 环境体检 |
| `menu` | 交互菜单 |

全局参数：`-d/--db` 指定库文件、`--server` 指定服务端、`--token` 指定令牌（或环境变量 `PWDASH_DB` / `PWDASH_SERVER` / `PWDASH_TOKEN`）。

---

## 数据格式与维护

库文件是 `{"<32 位小写 md5>": "<密码>"}` 的 JSON；`.gz` 版本用 zlib 压缩（网页端可用 `DecompressionStream('deflate')` 直接解）。
旧版的 `[[md5, password], ...]` 列表格式仍可读。

构建 / 清洗：

```bash
python3 tools/build_db.py                 # 清洗当前库并重新生成 gz + 网页版 JSON
python3 tools/build_db.py --check         # 只体检，不改文件
python3 tools/build_db.py --from a.json b.json.gz --out dist/   # 从多来源合并
python3 tools/build_db.py --dedupe-passwords                    # 同密码只留一条
python3 tools/build_db.py --report data/rejected.json           # 导出被剔除的记录
```

清洗规则：key 必须是 32 位 MD5、密码非空、长度 ≤ 256。被剔除的记录写入 `data/rejected.json`
而不是直接丢掉，可人工复核。**写入都是原子操作**（临时文件 + `os.replace` + 文件锁），
中途断电或并发写入不会把库写坏。

---

## 多库：自己的库 / 陌生人的库

投稿一旦开放，就不该和主库混在一起——别人塞进来的字符串会直接改变你的查询结果。
所以库是**可以拆成多个**的：各自独立文件、独立审核、查询时按顺序合并。

### 默认布局

| 库名 | 文件 | 谁的 | 说明 |
| --- | --- | --- | --- |
| `main` | `passwords_local.json` | 你的 | 你自己维护，优先级最高 |
| `community` | `community_passwords.json` | 陌生人的 | 投稿先落这里，审核通过才生效 |

查询规则：**先查 `main`，再查 `community`**；同一个 MD5 两个库都有时用 `main` 的值。
任何一个库里已有这条记录，投稿接口就直接回 `exists`，不会重复堆。

### 服务端怎么开多库

```bash
# 最简单：给一个主库，第二个库自动按约定生成
python3 server/server.py --bind 0.0.0.0 --port 5000 --db data/passwords_local.json.gz

# 自定义：名字=路径，逗号分隔，**靠前的优先**
python3 server/server.py --bind 0.0.0.0 --port 5000 \
  --dbs "own=data/my.json.gz,public=data/community.json.gz" \
  --contrib-db public
```

- `--dbs`：多库配置，等价环境变量 `PWDASH_DBS`
- `--contrib-db`：陌生人投稿默认写进哪个库，等价 `PWDASH_CONTRIB_DB`
- 查询可指定库：`GET /query/<md5>?db=community`，不指定就跨库查找
- 待审记录会记住「该进哪个库」，审核通过时自动写回对应的库

### Worker 怎么开多库

```toml
# worker/wrangler.toml
GH_PATH = "passwords_local.json"
GH_DBS = "main=passwords_local.json,community=community_passwords.json"
CONTRIB_DB = "community"
```

审核通过后，Worker 会分别 commit 到各自的文件；`community_passwords.json` 不存在时自动新建。

### 网页怎么用多库

设置 → 数据源，按优先级列出来即可：

1. `我的库` → `.../passwords_local.json`
2. `投稿库` → `.../community_passwords.json`

页面会合并两个库，并在「库信息」显示「2 个库合并」；设置里每个源后面标着「优先 / 第 2 库」。
某一条命中时，结果里会注明它来自哪个库。

> 投稿库暂时是空的（`{}`）也没关系：那个源会显示 ✕，主库照常可用；
> 等有人投稿并通过审核，它就有内容了。

---

## 让别人上传 MD5 和密码

三种方式，按「要不要自己运维」自行选择。

### 方式 A：开自建服务端 + 公开投稿（推荐）

服务端默认就是 `queue` 模式——**谁都能提交，但必须你审核才进库**，不会被灌垃圾。

```bash
# 1. 起服务（对外就加 HTTPS 反代；token 是审核口令，务必改）
PWDASH_TOKEN=$(openssl rand -hex 16) python3 server/server.py --bind 0.0.0.0 --port 5000

# 2. 告诉别人你的地址，他们这样投稿：
#    网页：设置里填服务端地址 → 「投稿」页签 → 填密码 → 提交
#    命令行：
./pwdash --server https://你的域名 contribute '解压密码'
./pwdash --server https://你的域名 contribute --md5 <32位md5> '解压密码'

# 3. 你审核（在有 token 的机器上）
./pwdash --server https://你的域名 --token $PWDASH_TOKEN review --list
./pwdash --server https://你的域名 --token $PWDASH_TOKEN review --approve all
./pwdash --server https://你的域名 --token $PWDASH_TOKEN review --reject <md5>
```

投稿三种模式用 `--contrib-mode` 切换（也可用环境变量 `PWDASH_CONTRIB_MODE`）：

| 模式 | 行为 | 适用 |
| --- | --- | --- |
| `queue`（默认） | 进 `pending_uploads.json.gz` 待审，审核通过才进主库 | 开放给陌生人 |
| `auto` | 校验通过直接入库 | 只给信任的群友 |
| `off` | `POST /contribute` 返回 403 | 完全关闭 |

投稿侧的保护：每 IP 每小时最多 `CONTRIB_LIMIT`（默认 10）次，超出返回 429；
待审队列超过 `contrib_max_pending`（默认 500）条时拒收；已存在或已在队列里的记录不会重复堆积。

### 方式 B：发一个共享 token 给信任的人，直接写库

```bash
# 对方直接批量推送，无需审核（慎用，务必只给熟人）
curl -X POST https://你的域名/bulk \
  -H "Authorization: Bearer $SHARED_TOKEN" -H 'Content-Type: application/json' \
  -d '{"entries":{"<md5>":"<密码>"},"overwrite":false}'

# 或让对方在本地整理好库后整库同步
./pwdash --server https://你的域名 --token $SHARED_TOKEN sync push
```

### 方式 C：不用服务端，走 GitHub

- 让对方 **fork 仓库 → 改 `passwords_local.json` → 提 PR**，你合并后线上立刻生效；
- 或者开一个 Issue 模板收投稿，你手动 `./pwdash add --from-password '密码'` 再 push。

这种方式零运维、全程留痕，代价是要人工合并。

### 投稿相关的安全提醒

- 匿名投稿**一定要用 `queue` 模式**：`auto` 模式下任何人能往你的库里塞任意字符串；
- 公网部署必须配 `PWDASH_TOKEN`（否则程序拒绝监听 `0.0.0.0`），并放在 HTTPS 反代之后；
- 投稿内容可能是别人的私人密码，公开库等于公开它——审核时看清楚再放行；
- 定期备份 `passwords_local.json.gz` 与 `pending_uploads.json.gz`。

---

## 全托管部署：GitHub + Cloudflare Workers & Pages

不买服务器、不开进程，三块拼起来就是完整产品：

```
┌─────────────────────┐   读公开库     ┌──────────────────────┐
│ Cloudflare Pages    │ ─────────────► │ GitHub 仓库           │
│  index.html + 资源   │                │ passwords_local.json │
└─────────┬───────────┘                └──────────┬───────────┘
          │ 库里查不到 / 投稿                      │ 审核通过后回写
          ▼                                       │
┌─────────────────────┐   读写 KV / Issue         │
│ Cloudflare Worker   │ ──────────────────────────┘
│  /query /contribute │
└─────────────────────┘
```

- **GitHub**：唯一的数据源（`passwords_local.json`），公开、可追溯、能回滚
- **Pages**：纯静态前端，全球 CDN，免费
- **Workers**：查询兜底 + 投稿接收入口 + 审核 API，免费额度（10 万请求/天）足够

### 步骤 1：让仓库有个可用的库

仓库里已有 `passwords_local.json` 就直接跳到下一步。要重建：

```bash
python3 tools/build_db.py --check          # 先体检
python3 tools/build_db.py                  # 清洗并重写 json + gz
git add passwords_local.json passwords_local.json.gz && git commit -m 'chore: 更新库' && git push
```

### 步骤 2：部署 Worker

```bash
cd worker
npx wrangler login                                     # 浏览器授权一次

# （可选）建 KV：绑了更快，不绑就用纯 GitHub 模式
npx wrangler kv namespace create DB
# 把输出的 id 填进 wrangler.toml 的 [[kv_namespaces]] 并取消注释

# 改 wrangler.toml 里的 GH_OWNER / GH_REPO / GH_BRANCH
npx wrangler deploy
# → https://pwdash.<你的账号>.workers.dev
```

### 步骤 3：配两个密钥

`GH_TOKEN` 需要有 **Contents 写** + **Issues 读写** 权限：

- 细粒度 PAT：Repository access 选该仓库，Permissions → Contents: Read and write，Issues: Read and write
- 经典 PAT：勾 `repo`

```bash
cd worker
npx wrangler secret put GH_TOKEN        # 粘贴 PAT
npx wrangler secret put ADMIN_TOKEN     # 自己编一个长口令，审核时用
```

> 有 KV 时 `GH_TOKEN` 只在「审核通过后回写仓库」用；纯 GitHub 模式下投稿也要用它开 Issue。

### 步骤 4：验证

```bash
BASE=https://pwdash.<你的账号>.workers.dev
curl -s $BASE/health            # {"status":"ok","backend":"kv","gh_token":true}
curl -s $BASE/query/<md5>       # 200 + 密码 / 404

# 匿名投稿（不需要 token）
curl -s -X POST $BASE/contribute -H 'Content-Type: application/json' \
     -d '{"password":"某个解压密码"}'

# 审核
curl -s -H "Authorization: Bearer $ADMIN_TOKEN" $BASE/contrib/pending
curl -s -X POST $BASE/contrib/approve -H "Authorization: Bearer $ADMIN_TOKEN" \
     -H 'Content-Type: application/json' -d '{"all":true}'
```

审核通过后 Worker 会自动 commit 回仓库，Pages 上的公开库随之更新。

手机上也行：浏览器打开 `https://pwdash.<你>.workers.dev/admin?token=<ADMIN_TOKEN>`，点「通过 / 拒绝」。

### 步骤 5：部署 Pages 并把地址告诉前端

方式一（连 Git，推荐）：Cloudflare Dashboard → Workers & Pages → Create → Pages → 连接仓库，
构建命令留空，输出目录填 `/`（根目录）。

方式二（命令行）：

```bash
npx wrangler pages deploy . --project-name=pwdash
```

然后把 Worker 地址填进前端，**只需改一处**：

```js
// assets/app.js 第 30 行附近
const DEFAULT_SERVER_URL = 'https://pwdash.<你的账号>.workers.dev';
```

这样访客打开页面，库里查不到时会自动去问 Worker；「投稿」页签也直接可用，无需手动配置。

### 步骤 6：用 GitHub Actions 自动化（可选）

仓库已带两个工作流：

| 文件 | 触发 | 作用 |
| --- | --- | --- |
| `.github/workflows/validate-db.yml` | 改动数据/工具、PR | 数据体检 + JSON 与 gz 一致性校验 + 跑冒烟测试，不通过就拦住 PR |
| `.github/workflows/deploy.yml` | 推送前端/Worker 相关改动 | 跑单元测试 → 部署 Worker → 发布 Pages |

启用 `deploy.yml` 需要在仓库 Secrets 里加：

- `CLOUDFLARE_API_TOKEN`：权限 Workers Scripts:Edit、Workers KV Storage:Edit、Pages:Edit
- `CLOUDFLARE_ACCOUNT_ID`：Cloudflare 后台右侧的 Account ID

### 两种 Worker 存储怎么选

| | KV 模式（推荐） | 纯 GitHub 模式 |
| --- | --- | --- |
| 绑定 `DB` KV | 需要 | 不需要 |
| 读库 | 读 KV，快且不吃 GitHub 配额 | 每次读 raw.githubusercontent（有 CDN 缓存） |
| 投稿落到哪 | KV 待审队列 | **自动开一个 GitHub Issue** |
| 审核界面 | `/admin` 网页，或 `pwdash review` | GitHub Issue 列表，或 `/admin` |
| 审核通过 | 更新 KV + commit 回仓库 | 关 Issue + commit 回仓库 |
| 适合 | 有人频繁投稿 | 不想用 KV、想全程留在 GitHub 里 |

纯 GitHub 模式的隐藏好处：**每一条投稿都在 Issue 里留痕**，谁、什么时候、提交了什么，GitHub 帮你记账。

### 成本与配额

- Workers 免费：10 万请求/天；KV 免费：10 万读/天、1000 写/天
- Pages 免费：无限静态请求、500 次构建/月
- GitHub API：PAT 5000 次/小时（审核回写才用到）

个人自用完全够。唯一要留意的是 KV 的**写**额度（1000/天），大批量导入请用 `--bulk` 一次推完，而不是逐条 `--upload`。

### 安全清单

- [ ] `ADMIN_TOKEN` 换成长随机串（`openssl rand -hex 24`），别用示例值
- [ ] `GH_TOKEN` 用细粒度 PAT，只授权这一个仓库
- [ ] `CORS_ORIGIN` 从 `*` 改成你的 Pages 域名，避免别人拿你的 Worker 当免费 API
- [ ] 投稿保持 `CONTRIB_MODE=queue`，别用 `auto`
- [ ] Worker 密钥只放 `wrangler secret`，绝不写进 `wrangler.toml` / 仓库
- [ ] 定期在 GitHub 上看 commit 历史，发现异常数据直接 revert

---

## 其它部署方式

**GitHub Pages**（纯静态，后端用 Worker 时也够用）

1. 把 `index.html`、`manifest.webmanifest`、`sw.js`、`assets/`、`passwords_local.json` 推到仓库默认分支；
2. Settings → Pages → Source 选该分支根目录；
3. 访问 `https://<用户名>.github.io/<仓库>/`。

改过前端后把 `sw.js` 里的 `VERSION` 加一，否则老访客会继续用旧缓存。

**Cloudflare Pages / Netlify**：构建命令留空，输出目录填仓库根目录即可。

**自建**：`python3 tools/serve.py --bind 0.0.0.0 --port 8080`，或任何静态服务器。

**没有服务器也能跑后端**：见上面 [全托管部署](#全托管部署github--cloudflare-workers--pages)。

---

## 安全与隐私

**这个项目的定位是「公开密码库 + 本地工具」**，请清楚以下事实：

- `passwords_local.json` 是**明文密码库**，一旦推到公开仓库，任何人都能整库拉走。
  如果你的库里有不想公开的密码，别用公开仓库：改用自建服务端（`/query` 按需返回单条），
  或把库放进私有仓库、只在内网用；
- 本地缓存会把整库写进浏览器 localStorage 与磁盘文件，公共电脑上用完请「清除缓存」；
- 网页端计算文件 MD5 全程在本地，文件不会上传；页面不加载任何外部图片/字体/统计脚本（旧版外链背景图已移除）；
- 命令行默认**不上传**密码，只有显式 `--upload` 才会回传服务端；
- 服务端默认只监听 `127.0.0.1`；对外监听必须配 `PWDASH_TOKEN`，并建议放在 HTTPS 反代之后；
- 输出密码时默认打码（`list` 需 `--reveal`），日志不记录密码内容。

---

## 测试

```bash
bash tests/smoke.sh        # 80 项：库读写、清洗、CLI、解压、服务端、投稿审核、多库、前端资源
```

需要 Node 时可选跑前端：

```bash
npm install jsdom
node tests/dom_test.mjs                                    # 35 项，用真实 app.js 跑交互
node tests/web_test.mjs --chrome "$(which google-chrome)"   # 真浏览器 CDP 端到端
node tests/worker_test.mjs                                 # 78 项，Worker 双后端 + 多库（mock KV + mock GitHub）
```

`smoke.sh` 全程使用临时目录与随机端口，不会动仓库里的真实密码库。

---

## 从旧版迁移

旧版只有几个硬编码脚本和静态页，本次改动如下：

| 旧 | 新 | 说明 |
| --- | --- | --- |
| `python 1.py`（交互菜单） | `./pwdash` 或 `python cli/pwdkit.py menu` | 入口保留，`1.py` 变成转发壳 |
| `python 2.py`（gz→json） | `python tools/build_db.py` | 增加了校验、清洗、合并、报告 |
| `script.js` / `style.css` | `assets/app.js` / `assets/app.css` | 完全重写 |
| 硬编码单一 GitHub 地址 | 多数据源 + 本地缓存 + 可配置 | 源可增删排序启停 |
| 自动上传密码到 `127.0.0.1:5000` | 默认不上传，需 `--upload` | 隐私优先 |
| 失败时静默、无退出码 | 明确退出码与错误信息 | 可被脚本调用 |
| `delete_local_record` 未定义等 bug | 已修复并纳入自测 | 数十项自动化断言 |

已知兼容性：仓库根目录的 `passwords_local.json` 路径未变，线上前端的 raw 地址继续有效。

---

## 常见问题

**Q：网页版提示「所有数据源都不可用」？**
检查网络与源地址；已缓存过的库仍能离线查询（右上角会出现「离线」角标）。
被墙的话在设置里加一个镜像地址即可。

**Q：显示「缺少解压后端」？**
按提示任选安装：`pip install pyzipper py7zr rarfile`，或系统包管理器装 `p7zip` / `unrar`。
纯 zip 的传统加密（ZipCrypto）用 Python 内置 `zipfile` 就能解，无需额外安装。

**Q：AES-256 加密的 zip 解不开？**
需要 `pyzipper`（Python 侧）或 `7z` 命令行，程序会自动挑可用的那个。

**Q：别人怎么给我投稿？**
见 [让别人上传 MD5 和密码](#让别人上传-md5-和密码)。默认是「投稿进队列 → 我审核」，不会污染主库。

**Q：为什么网页没有导入/导出了？**
按需求去掉了。现在网页只负责查和投稿，改库统一走 CLI——避免手滑把别人的库盖到自己库上，
也避免「导出的库再导入回来」这种容易出错的操作。需要搬运数据就用：
`pwdash export -o x.json` / `pwdash import x.json`。

**Q：陌生人的投稿会不会把我的库搞乱？**
不会。投稿默认落到独立的 `community` 库，和你的 `main` 库是两个文件；
而且要你审核通过才进库，查询时 `main` 优先。详见 [多库](#多库自己的库--陌生人的库)。

**Q：不想买服务器，能只用 GitHub + Cloudflare 吗？**
能。Worker 就是为这个场景写的，见 [全托管部署](#全托管部署github--cloudflare-workers--pages)：
GitHub 存数据，Workers 跑接口，Pages 跑前端，全程免费。

**Q：Worker 和 server/server.py 冲突吗？**
不冲突。两者接口一致，可以只跑一个：想零运维就用 Worker；想完全自己掌控数据就用 Python 服务。

**Q：投稿队列积压了怎么办？**
`./pwdash --server <地址> --token <口令> review --list` 看清单，`--approve all` 一次过；
也可以 `--reject all` 全部丢弃。

**Q：MD5 是怎么算的？**
整文件按字节流式计算，与 `md5sum` / `md5` 结果一致；网页端与命令行实现已互相对拍验证。
注意 MD5 只用于「按内容找密码」，不用于安全校验。
