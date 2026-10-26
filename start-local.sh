#!/bin/sh
# start-local.sh —— 本地一键部署 pwdash
#
#   ./start-local.sh                 # 静态前端 127.0.0.1:8080 + 查询服务 127.0.0.1:5000
#   WEB_PORT=9000 API_PORT=5001 ./start-local.sh
#   BIND=0.0.0.0 ./start-local.sh    # 局域网/手机同网段访问（务必配合 .local-token）
#   ./start-local.sh restart|stop|status
#
# 产物：logs/{web,api}.log、logs/pids/*.pid、.local-token（审核口令，勿外传）
set -e

DIR=$(cd "$(dirname "$0")" && pwd)
cd "$DIR"

WEB_PORT=${WEB_PORT:-8080}
API_PORT=${API_PORT:-5000}
BIND=${BIND:-127.0.0.1}
CORS_ORIGIN=${CORS_ORIGIN:-*}
CONTRIB_MODE=${CONTRIB_MODE:-queue}

LOG_DIR="$DIR/logs"
PID_DIR="$LOG_DIR/pids"
TOKEN_FILE="$DIR/.local-token"
mkdir -p "$PID_DIR"

if [ -n "$PYTHON" ]; then
  PY=$PYTHON
elif command -v python3 >/dev/null 2>&1; then
  PY=python3
else
  PY=python
fi

# ------------------------------------------------------------------ 工具函数
running() { # running <name>
  pidfile="$PID_DIR/$1.pid"
  [ -s "$pidfile" ] || return 1
  kill -0 "$(cat "$pidfile")" 2>/dev/null
}

stop_one() { # stop_one <name>
  if running "$1"; then
    pid=$(cat "$PID_DIR/$1.pid")
    kill "$pid" 2>/dev/null || true
    i=0
    while kill -0 "$pid" 2>/dev/null && [ "$i" -lt 30 ]; do
      sleep 0.2
      i=$((i + 1))
    done
    kill -9 "$pid" 2>/dev/null || true
    echo "⏹  $1 已停止 (pid $pid)"
  else
    echo "·  $1 未在运行"
  fi
  rm -f "$PID_DIR/$1.pid"
}

port_busy() { # port_busy <port>
  "$PY" - "$1" <<'PYEOF'
import socket, sys
port = int(sys.argv[1])
s = socket.socket()
try:
    s.bind(("127.0.0.1", port))
except OSError:
    sys.exit(0)   # 占用
finally:
    s.close()
sys.exit(1)
PYEOF
}

case "${1:-start}" in
  stop)
    stop_one api
    stop_one web
    exit 0
    ;;
  status)
    for n in api web; do
      if running "$n"; then echo "✅ $n 运行中 (pid $(cat "$PID_DIR/$n.pid"))"; else echo "❌ $n 未运行"; fi
    done
    exit 0
    ;;
  restart)
    "$0" stop
    sleep 0.5
    ;;
  start) ;;
  *)
    echo "用法: $0 [start|stop|restart|status]" >&2
    exit 2
    ;;
esac

# ------------------------------------------------------------------ 令牌
if [ ! -s "$TOKEN_FILE" ]; then
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 16 >"$TOKEN_FILE"
  else
    "$PY" -c 'import secrets; print(secrets.token_hex(16))' >"$TOKEN_FILE"
  fi
  chmod 600 "$TOKEN_FILE" 2>/dev/null || true
fi
TOKEN=$(cat "$TOKEN_FILE")

# ------------------------------------------------------------------ 库体检
if [ ! -s "$DIR/passwords_local.json.gz" ]; then
  echo "🔧 库文件缺失，重新构建…"
  "$PY" tools/build_db.py
fi
[ -s "$DIR/community_passwords.json.gz" ] || printf '{}' | "$PY" -c 'import gzip,sys;open("community_passwords.json.gz","wb").write(gzip.compress(sys.stdin.buffer.read()))'

# ------------------------------------------------------------------ 启动服务
if running api; then
  echo "·  api 已在运行 (pid $(cat "$PID_DIR/api.pid"))，跳过"
else
  if port_busy "$API_PORT"; then
    echo "❌ 端口 $API_PORT 已被占用，换一个：API_PORT=5001 $0" >&2
    exit 3
  fi
  PWDASH_TOKEN="$TOKEN" PWDASH_CONTRIB_MODE="$CONTRIB_MODE" nohup "$PY" server/server.py \
    --bind "$BIND" --port "$API_PORT" \
    --db "$DIR/passwords_local.json.gz" \
    --pending "$DIR/pending_uploads.json.gz" \
    --cors "$CORS_ORIGIN" \
    --contrib-mode "$CONTRIB_MODE" \
    >"$LOG_DIR/api.log" 2>&1 &
  echo $! >"$PID_DIR/api.pid"
  echo "🚀 api 启动中 (pid $(cat "$PID_DIR/api.pid")) → http://$BIND:$API_PORT"
fi

if running web; then
  echo "·  web 已在运行 (pid $(cat "$PID_DIR/web.pid"))，跳过"
else
  if port_busy "$WEB_PORT"; then
    echo "❌ 端口 $WEB_PORT 已被占用，换一个：WEB_PORT=9000 $0" >&2
    exit 3
  fi
  nohup "$PY" tools/serve.py --bind "$BIND" --port "$WEB_PORT" >"$LOG_DIR/web.log" 2>&1 &
  echo $! >"$PID_DIR/web.pid"
  echo "🌐 web 启动中 (pid $(cat "$PID_DIR/web.pid")) → http://$BIND:$WEB_PORT"
fi

# ------------------------------------------------------------------ 健康检查
i=0
while [ "$i" -lt 40 ]; do
  if "$PY" - "$API_PORT" "$WEB_PORT" <<'PYEOF'
import sys, urllib.request
api, web = (int(x) for x in sys.argv[1:3])
for url in (f"http://127.0.0.1:{api}/health", f"http://127.0.0.1:{web}/index.html"):
    try:
        urllib.request.urlopen(url, timeout=2).read(1)
    except Exception:
        sys.exit(1)
PYEOF
  then
    break
  fi
  sleep 0.25
  i=$((i + 1))
done

echo
echo "──────────────────────────────────────────────"
echo " 前端   http://127.0.0.1:$WEB_PORT/"
echo " 服务端 http://127.0.0.1:$API_PORT/health"
echo " 审核口令 $TOKEN   （文件 .local-token）"
echo " 日志   logs/web.log  logs/api.log"
echo " 停止   ./start-local.sh stop"
echo "──────────────────────────────────────────────"
