#!/usr/bin/env bash
# smoke.sh —— 全链路自测（不会改动仓库里的真实密码库）
#
#   bash tests/smoke.sh
#
# 覆盖：库读写 / 数据清洗 / CLI 各子命令 / 解压校验 / 服务端接口 / 前端语法与 MD5 实现
set -uo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
export ROOT
TMP=$(mktemp -d)
PORT=$(( (RANDOM % 2000) + 18000 ))
PASS=0
FAIL=0
SRV_PID=""

cleanup() {
  [ -n "$SRV_PID" ] && kill "$SRV_PID" 2>/dev/null
  rm -rf "$TMP"
}
trap cleanup EXIT

green() { printf '\033[1;32m%s\033[0m\n' "$*"; }
red() { printf '\033[1;31m%s\033[0m\n' "$*"; }

check() { # check <描述> <期望> <实际>
  if [ "$2" = "$3" ]; then
    green "  ✓ $1"
    PASS=$((PASS + 1))
  else
    red "  ✗ $1 （期望: $2 / 实际: $3）"
    FAIL=$((FAIL + 1))
  fi
}

echo "=== 0. 语法检查 ==="
if python3 -m py_compile "$ROOT"/tools/*.py "$ROOT"/cli/*.py "$ROOT"/server/*.py; then
  green "  ✓ Python 全部通过"; PASS=$((PASS + 1))
else
  red "  ✗ Python 语法错误"; FAIL=$((FAIL + 1))
fi
if command -v node >/dev/null 2>&1; then
  if node --check "$ROOT/assets/app.js" && node --check "$ROOT/assets/md5.js" && node --check "$ROOT/sw.js"; then
    green "  ✓ JS 语法通过"; PASS=$((PASS + 1))
  else
    red "  ✗ JS 语法错误"; FAIL=$((FAIL + 1))
  fi
else
  echo "  - 跳过 JS 语法检查（无 node）"
fi

echo
echo "=== 1. 密码库读写（pwlib） ==="
python3 - "$TMP" <<'PY'
import os, sys
sys.path.insert(0, os.path.join(os.environ['ROOT'], 'tools'))
import pwlib
tmp = sys.argv[1]
s = pwlib.Store(os.path.join(tmp, 'db.json.gz'))
assert s.load() == {}
assert s.put('619293e69a6b5a90be2c04a6e3bf4715', 'pw1') is True
assert s.put('619293E69A6B5A90BE2C04A6E3BF4715', 'pw1') is False   # 大小写归一 + 幂等
assert s.get('619293E69A6B5A90BE2C04A6E3BF4715') == 'pw1'
try:
    s.put('not-an-md5', 'x'); raise AssertionError('应当拒绝非法 MD5')
except ValueError:
    pass
assert s.delete('619293e69a6b5a90be2c04a6e3bf4715') is True
assert s.delete('619293e69a6b5a90be2c04a6e3bf4715') is False
# 旧版列表格式兼容
raw = pwlib.dumps({'a'*32: 'v'})
assert pwlib.loads(raw) == {'a'*32: 'v'}
assert pwlib.loads(b'[["b' + b'b'*31 + b'", "z"]]') == {'b'*32: 'z'}
# 打码
assert pwlib.mask('secret') == 'se**et'
print('  ✓ 读写/校验/兼容/打码 全部通过')
PY
[ $? -eq 0 ] && PASS=$((PASS + 1)) || { red "  ✗ pwlib 测试失败"; FAIL=$((FAIL + 1)); }

echo
echo "=== 2. 数据清洗（build_db） ==="
# 造一个「脏库」：1 条合法 + 1 条非 MD5 key + 1 条空密码 + 1 条超长密码
python3 - "$TMP/src.json.gz" <<'PY'
import sys, os
sys.path.insert(0, os.path.join(os.environ['ROOT'], 'tools'))
import pwlib
data = {
    'a' * 32: 'good-password',
    '93be1fa6d52526a9aef8d2e82c0f': 'badkey',      # 30 位，不是 MD5
    'b' * 32: '',                                   # 空密码
    'c' * 32: 'x' * 300,                            # 超长
}
open(sys.argv[1], 'wb').write(pwlib.dumps(data))
PY
python3 "$ROOT/tools/build_db.py" --from "$TMP/src.json.gz" --out "$TMP/out" --report "$TMP/bad.json" >"$TMP/build.log" 2>&1
check "构建退出码" "0" "$?"
check "生成网页版 JSON" "yes" "$([ -f "$TMP/out/passwords_local.json" ] && echo yes)"
check "生成压缩版" "yes" "$([ -f "$TMP/out/passwords_local.json.gz" ] && echo yes)"
check "脏数据被剔除" "3" "$(python3 -c "import json;print(len(json.load(open('$TMP/bad.json'))))" 2>/dev/null)"
check "干净库无脏数据可剔" "0" "$(python3 "$ROOT/tools/build_db.py" --from "$ROOT/passwords_local.json.gz" --out "$TMP/out2" --report "$TMP/bad2.json" >/dev/null 2>&1; [ -s "$TMP/bad2.json" ] && echo has || echo 0)"
python3 - "$TMP/out/passwords_local.json" <<'PY'
import json, re, sys
d = json.load(open(sys.argv[1], encoding='utf-8'))
bad = [k for k in d if not re.fullmatch(r'[0-9a-f]{32}', k)]
assert not bad, f'仍有非法 key: {bad[:3]}'
print(f'  ✓ 清洗后 {len(d)} 条，key 全部合法')
PY
[ $? -eq 0 ] && PASS=$((PASS + 1)) || { red "  ✗ 清洗结果仍有脏数据"; FAIL=$((FAIL + 1)); }

echo
echo "=== 3. 哈希一致性 ==="
echo -n "hello pwdash" > "$TMP/sample.txt"
EXPECT=$(md5sum "$TMP/sample.txt" | cut -d' ' -f1)
GOT=$(python3 "$ROOT/cli/pwdkit.py" hash -f "$TMP/sample.txt")
check "Python 文件 MD5" "$EXPECT" "$GOT"
GOT2=$(python3 "$ROOT/cli/pwdkit.py" hash "hello pwdash")
check "Python 字符串 MD5" "$EXPECT" "$GOT2"

if command -v node >/dev/null 2>&1; then
  JS=$(node -e '
    const fs=require("fs");
    eval(fs.readFileSync(process.argv[1],"utf8"));
    const h=new Md5();
    h.update(fs.readFileSync(process.argv[2]));
    console.log(h.hex());
  ' "$ROOT/assets/md5.js" "$TMP/sample.txt")
  check "浏览器版 MD5 与 md5sum 一致" "$EXPECT" "$JS"
fi

echo
echo "=== 4. CLI 子命令 ==="
DB="$TMP/cli-db.json.gz"
M="619293e69a6b5a90be2c04a6e3bf4715"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" add "$M" "p@ss" >/dev/null
check "add" "0" "$?"
OUT=$(python3 "$ROOT/cli/pwdkit.py" -d "$DB" query "$M" --no-remote --json)
check "query --json 命中" "True" "$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["found"])')"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" query "${M/6/7}" --no-remote >/dev/null 2>&1
check "query 未找到退出码" "4" "$?"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" query "zzz" --no-remote >/dev/null 2>&1
check "query 非法 MD5 非零退出" "4" "$?"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" list | grep -q 'p@ss' && CRASH=yes || CRASH=no
check "list 默认打码" "no" "$CRASH"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" list --reveal | grep -q 'p@ss'
check "list --reveal 显示明文" "0" "$?"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" export -o "$TMP/exp.json" >/dev/null
check "export" "0" "$?"
python3 "$ROOT/cli/pwdkit.py" -d "$TMP/cli-db2.json.gz" import "$TMP/exp.json" >/dev/null
check "import 到新库" "0" "$?"
python3 "$ROOT/cli/pwdkit.py" -d "$DB" remove "$M" >/dev/null
check "remove" "0" "$?"
python3 "$ROOT/cli/pwdkit.py" doctor >/dev/null 2>&1
check "doctor" "0" "$?"

echo
echo "=== 5. 解压（需要 zip 命令） ==="
if command -v zip >/dev/null 2>&1; then
  mkdir -p "$TMP/arc" && echo "top secret" > "$TMP/arc/secret.txt"
  ( cd "$TMP/arc" && zip -q -P ark123 box.zip secret.txt )
  python3 "$ROOT/cli/pwdkit.py" -d "$DB" extract "$TMP/arc/box.zip" -p ark123 --verify-only >/dev/null
  check "正确密码校验通过" "0" "$?"
  python3 "$ROOT/cli/pwdkit.py" -d "$DB" extract "$TMP/arc/box.zip" -p wrong --verify-only >/dev/null 2>&1
  check "错误密码退出码 5" "5" "$?"
  rm -rf "$TMP/outdir"
  python3 "$ROOT/cli/pwdkit.py" -d "$DB" extract "$TMP/arc/box.zip" -p ark123 -o "$TMP/outdir" >/dev/null
  check "解压出的文件内容" "top secret" "$(cat "$TMP/outdir/box/secret.txt" 2>/dev/null)"
else
  echo "  - 跳过（无 zip 命令）"
fi

echo
echo "=== 6. 服务端接口 ==="
cp "$ROOT/passwords_local.json.gz" "$TMP/srv.json.gz"
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$PORT" --db "$TMP/srv.json.gz" >"$TMP/srv.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do
  curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && break
  sleep 0.2
done
BASE="http://127.0.0.1:$PORT"

check "GET /health" "200" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/health)"
check "GET /query 命中" "200" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/query/$M)"
check "GET /query 未命中" "404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/query/00000000000000000000000000000000)"
check "GET /query 非法" "400" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/query/nope)"
check "POST /upload 无 token" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/upload -H 'Content-Type: application/json' -d '{"password":"abc"}')"
check "POST /upload 带 token" "201" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/upload -H 'Content-Type: application/json' -H 'Authorization: Bearer testtoken' -d '{"password":"abc"}')"
check "GET /db 无 token" "401" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/db)"
check "GET /db 带 token" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer testtoken' $BASE/db)"
check "POST /bulk" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/bulk -H 'Content-Type: application/json' -H 'Authorization: Bearer testtoken' -d '{"entries":{"'$M'":"zzz"}}')"
check "非法 JSON 请求体" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $BASE/upload -H 'Content-Type: application/json' -H 'Authorization: Bearer testtoken' -d 'not json')"
check "未知路径" "404" "$(curl -s -o /dev/null -w '%{http_code}' $BASE/nothing)"

# CLI ↔ 服务端联动
OUT=$(python3 "$ROOT/cli/pwdkit.py" -d "$TMP/link.json.gz" --server "$BASE" query "$M" --json)
check "CLI 走服务端查询命中" "True" "$(printf '%s' "$OUT" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["found"])')"
python3 "$ROOT/cli/pwdkit.py" -d "$TMP/link.json.gz" --server "$BASE" --token testtoken sync pull >/dev/null
check "CLI sync pull" "0" "$?"

kill "$SRV_PID" 2>/dev/null; SRV_PID=""


echo
echo "=== 6b. 公开投稿 + 审核队列 ==="
# 每个场景用独立库 + 独立待审文件
CT="$TMP/ct"; mkdir -p "$CT"
cp "$ROOT/passwords_local.json.gz" "$CT/db.json.gz"
CPORT=$(( PORT + 1 ))
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$CPORT" --db "$CT/db.json.gz" \
  --pending "$CT/pending.json.gz" --contrib-mode queue >"$CT/srv.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$CPORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
CB="http://127.0.0.1:$CPORT"
NEWMD5=$(python3 -c "import hashlib;print(hashlib.md5(b'community-pass').hexdigest())")

check "匿名投稿入队" "202" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contribute -H 'Content-Type: application/json' -d '{"password":"community-pass"}')"
check "重复投稿不重复入队" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contribute -H 'Content-Type: application/json' -d '{"password":"community-pass"}')"
check "空密码被拒" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contribute -H 'Content-Type: application/json' -d '{"password":""}')"
check "非法 MD5 被拒" "400" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contribute -H 'Content-Type: application/json' -d '{"md5":"zzz","password":"p"}')"
check "未审核前查不到" "404" "$(curl -s -o /dev/null -w '%{http_code}' $CB/query/$NEWMD5)"
check "待审数量公开可读" "1" "$(curl -s $CB/contrib/count | python3 -c 'import json,sys;print(json.load(sys.stdin)["pending"])')"
check "待审列表需 token" "401" "$(curl -s -o /dev/null -w '%{http_code}' $CB/contrib/pending)"
check "待审列表带 token" "200" "$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer testtoken' $CB/contrib/pending)"
check "审核通过需 token" "401" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contrib/approve -H 'Content-Type: application/json' -d '{"all":true}')"
check "审核通过" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contrib/approve -H 'Authorization: Bearer testtoken' -H 'Content-Type: application/json' -d '{"all":true}')"
check "审核后可查到" "community-pass" "$(curl -s $CB/query/$NEWMD5 | python3 -c 'import json,sys;print(json.load(sys.stdin).get("password",""))')"
check "审核后队列清空" "0" "$(curl -s $CB/contrib/count | python3 -c 'import json,sys;print(json.load(sys.stdin)["pending"])')"
check "拒绝投稿不入库" "200" "$(curl -s -o /dev/null -w '%{http_code}' -X POST $CB/contrib/reject -H 'Authorization: Bearer testtoken' -H 'Content-Type: application/json' -d '{"ids":["'$NEWMD5'"]}')"
kill "$SRV_PID" 2>/dev/null; SRV_PID=""

# 关闭投稿模式
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$CPORT" --db "$CT/db2.json.gz" \
  --contrib-mode off >"$CT/srv2.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$CPORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
check "关闭投稿后返回 403" "403" "$(curl -s -o /dev/null -w '%{http_code}' -X POST http://127.0.0.1:$CPORT/contribute -H 'Content-Type: application/json' -d '{"password":"x"}')"
kill "$SRV_PID" 2>/dev/null; SRV_PID=""

# CLI 投稿与审核命令（重新起一个 queue 模式服务）
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$CPORT" --db "$CT/db3.json.gz" \
  --pending "$CT/pending3.json.gz" --contrib-mode queue >"$CT/srv3.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$CPORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
C3="http://127.0.0.1:$CPORT"
python3 "$ROOT/cli/pwdkit.py" --server "$C3" contribute cli-pass >/dev/null 2>&1
check "CLI contribute 提交成功" "0" "$?"
python3 "$ROOT/cli/pwdkit.py" --server "$C3" --token testtoken review --list >/dev/null 2>&1
check "CLI review --list" "0" "$?"
CLIMD5=$(python3 -c "import hashlib;print(hashlib.md5(b'cli-pass').hexdigest())")
python3 "$ROOT/cli/pwdkit.py" --server "$C3" --token testtoken review --approve "$CLIMD5" >/dev/null 2>&1
check "CLI review --approve" "0" "$?"
check "CLI 审核后服务端可查" "cli-pass" "$(curl -s $C3/query/$CLIMD5 | python3 -c 'import json,sys;print(json.load(sys.stdin).get("password",""))')"
python3 "$ROOT/cli/pwdkit.py" --server "$C3" --token wrong review --list >/dev/null 2>&1
check "错误 token 被拒（退出码 7）" "7" "$?"
kill "$SRV_PID" 2>/dev/null; SRV_PID=""


echo
echo "=== 6c. 多库（自己的库 + 陌生人库）==="
ML="$TMP/ml"; mkdir -p "$ML"
cp "$ROOT/passwords_local.json.gz" "$ML/main.json.gz"
MPORT=$(( PORT + 2 ))
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$MPORT" \
  --db "$ML/main.json.gz" --contrib-mode queue >"$ML/srv.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$MPORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
MB="http://127.0.0.1:$MPORT"

check "启动即两个库" "main,community" "$(curl -s $MB/health | python3 -c 'import json,sys;print(",".join(d["name"] for d in json.load(sys.stdin)["dbs"]))')"
SMD5=$(python3 -c "import hashlib;print(hashlib.md5(b'stranger-only').hexdigest())")
curl -s -X POST $MB/contribute -H 'Content-Type: application/json' -d '{"password":"stranger-only"}' >/dev/null
check "待审记录标注目标库" "community" "$(curl -s -H 'Authorization: Bearer testtoken' $MB/contrib/pending | python3 -c 'import json,sys;print(json.load(sys.stdin)["detail"][0]["db"])')"
curl -s -X POST $MB/contrib/approve -H 'Authorization: Bearer testtoken' -H 'Content-Type: application/json' -d '{"all":true}' >/dev/null
check "投稿落在 community 库" "community" "$(curl -s $MB/query/$SMD5 | python3 -c 'import json,sys;print(json.load(sys.stdin).get("db",""))')"
check "主库没被污染" "404" "$(curl -s -o /dev/null -w '%{http_code}' "$MB/query/$SMD5?db=main")"
check "只查 community 能查到" "stranger-only" "$(curl -s "$MB/query/$SMD5?db=community" | python3 -c 'import json,sys;print(json.load(sys.stdin).get("password",""))')"
check "主库记录仍在" "200" "$(curl -s -o /dev/null -w '%{http_code}' "$MB/query/$(python3 -c "import json;print(list(json.load(open('$ROOT/passwords_local.json')))[0])")?db=main")"
check "不存在的库名 400" "400" "$(curl -s -o /dev/null -w '%{http_code}' "$MB/query/$SMD5?db=ghost")"
check "两个库各自落盘" "2" "$(ls $ML/main.json.gz $ML/community_passwords.json.gz 2>/dev/null | wc -l)"
kill "$SRV_PID" 2>/dev/null; SRV_PID=""

# --dbs 显式配置 + 自定义投稿库
PWDASH_TOKEN=testtoken python3 "$ROOT/server/server.py" --port "$MPORT" \
  --dbs "own=$ML/main.json.gz,public=$ML/community_passwords.json.gz" --contrib-db public \
  --contrib-mode queue >"$ML/srv2.log" 2>&1 &
SRV_PID=$!
for _ in $(seq 1 40); do curl -sf -m 1 "http://127.0.0.1:$MPORT/health" >/dev/null 2>&1 && break; sleep 0.2; done
check "--dbs 自定义库名" "own,public" "$(curl -s http://127.0.0.1:$MPORT/health | python3 -c 'import json,sys;print(",".join(d["name"] for d in json.load(sys.stdin)["dbs"]))')"
check "--contrib-db 生效" "public" "$(curl -s -X POST http://127.0.0.1:$MPORT/contribute -H 'Content-Type: application/json' -d '{"password":"x2"}' | python3 -c 'import json,sys;print(json.load(sys.stdin).get("db",""))')"
kill "$SRV_PID" 2>/dev/null; SRV_PID=""

echo
echo "=== 7. 前端资源 ==="
for f in index.html sw.js manifest.webmanifest assets/app.css assets/app.js assets/md5.js assets/icon.svg assets/icon-192.png assets/icon-512.png; do
  check "存在 $f" "yes" "$([ -s "$ROOT/$f" ] && echo yes)"
done
check "index.html 引用了新样式" "yes" "$(grep -q 'assets/app.css' "$ROOT/index.html" && echo yes)"
check "index.html 有 manifest" "yes" "$(grep -q 'manifest.webmanifest' "$ROOT/index.html" && echo yes)"
check "无外链背景图" "no" "$(grep -rq 'api.rls.ovh' "$ROOT/index.html" "$ROOT/assets/" && echo yes || echo no)"
check "manifest 是合法 JSON" "yes" "$(python3 -c 'import json;json.load(open("'"$ROOT"'/manifest.webmanifest"));print("yes")' 2>/dev/null)"

echo
echo "================ 结果 ================"
green "通过: $PASS"
if [ "$FAIL" -gt 0 ]; then
  red "失败: $FAIL"
  exit 1
fi
green "全部通过 🎉"
