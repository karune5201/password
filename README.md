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
- [部署](#部署)
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
| 多数据源 | 按优先级依次尝试，任一可用即生效；可在设置里增删、排序、启停 |
| 离线可用 | 整库缓存到 localStorage + Service Worker，断网照样查 |
| 导入/导出 | 支持导入 `.json` 与 `.json.gz`（就地解压），随时导出当前库 |
| 公开投稿 | 「投稿」页签可把自己的密码提交给别人（进审核队列），支持从文件取 MD5 |
| 无痕 | 无埋点、无外链图片/字体，纯本地渲染 |
| 其他 | 深/浅色主题、查询历史、`/` 与 `Ctrl+K` 快捷键、`?md5=` 直达、可安装为 PWA |

**命令行（`cli/pwdkit.py`，零第三方依赖）**

- 查密码（本地库优先 → 可选自建服务端兜底，命中后自动缓存）
- 自动查库解压：算文件 MD5 → 查库 → 校验密码 → 解压，一步完成
- 库维护：新增、删除、列出（默认打码）、合并导入、导出、统计体检
- 与服务端双向同步（`sync push` / `sync pull`）
- 多解压后端自动降级，缺依赖时给出明确提示而**不会偷偷 pip install**

**服务端（`server/server.py`，纯标准库）**

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
├── server/server.py        # 自建查询服务
├── tools/
│   ├── pwlib.py            # 库读写层（原子写入 + 文件锁）
│   ├── build_db.py         # 库构建/清洗（体检、去脏数据、生成 gz 与 JSON）
│   ├── make_icons.py       # 生成 PWA 图标
│   ├── serve.py            # 本地预览静态服务
│   └── git-menu.sh         # 通用 git 操作菜单（原 1.sh）
├── tests/
│   ├── smoke.sh            # 全链路自测（70 项）
│   ├── dom_test.mjs        # jsdom 跑真实 app.js（29 项）
│   └── web_test.mjs        # 无头 Chrome 端到端（CDP，无需 puppeteer）
├── passwords_local.json    # 网页版明文库（发到 GitHub 供前端 fetch）
├── passwords_local.json.gz # 命令行用压缩库
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

## 部署

**GitHub Pages**（当前用法）

1. 把 `index.html`、`manifest.webmanifest`、`sw.js`、`assets/`、`passwords_local.json` 推到仓库默认分支；
2. Settings → Pages → Source 选该分支根目录；
3. 访问 `https://<用户名>.github.io/<仓库>/`。

改过前端后把 `sw.js` 里的 `VERSION` 加一，否则老访客会继续用旧缓存。

**Cloudflare Pages / Netlify**：构建命令留空，输出目录填仓库根目录即可。

**自建**：`python3 tools/serve.py --bind 0.0.0.0 --port 8080`，或任何静态服务器。

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
bash tests/smoke.sh        # 70 项：库读写、清洗、CLI、解压、服务端、投稿审核、前端资源
```

需要 Node 时可选跑前端：

```bash
npm install jsdom
node tests/dom_test.mjs                                    # 31 项，用真实 app.js 跑交互
node tests/web_test.mjs --chrome "$(which google-chrome)"   # 真浏览器 CDP 端到端
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

**Q：投稿队列积压了怎么办？**
`./pwdash --server <地址> --token <口令> review --list` 看清单，`--approve all` 一次过；
也可以 `--reject all` 全部丢弃。

**Q：MD5 是怎么算的？**
整文件按字节流式计算，与 `md5sum` / `md5` 结果一致；网页端与命令行实现已互相对拍验证。
注意 MD5 只用于「按内容找密码」，不用于安全校验。
