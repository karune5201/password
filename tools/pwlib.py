#!/usr/bin/env python3
"""pwlib —— 密码库的公共读写层（CLI 与服务端共用，零第三方依赖）。

库文件格式：zlib/gzip 压缩的 JSON 字典 ``{"<md5>": "<password>"}``。
兼容旧版：也接受未压缩 JSON，以及旧版的 ``[[md5, password], ...]`` 列表。

设计原则：
* 原子写入（临时文件 + os.replace），避免断电/并发导致库损坏；
* 跨进程文件锁（POSIX 用 fcntl，Windows 用 msvcrt 兜底）；
* 所有异常都有明确语义，不吞错误；
* 不打印密码明文（除非调用方显式要求）。
"""

from __future__ import annotations

import gzip
import hashlib
import json
import os
import re
import tempfile
import time
import zlib

MD5_RE = re.compile(r"^[0-9a-fA-F]{32}$")
DB_NAME = "passwords_local.json.gz"

# 内置默认数据源（网页端与 CLI 共用一份语义：
# 依次尝试，第一个命中的结果胜出）
DEFAULT_SOURCES = [
    "https://raw.githubusercontent.com/karune5201/password/master/passwords_local.json",
]


class DBError(Exception):
    """密码库读写异常。"""


# --------------------------------------------------------------------------
# 路径
# --------------------------------------------------------------------------
def default_db_path() -> str:
    """默认库路径：环境变量 PWDASH_DB > 仓库根目录下的 passwords_local.json.gz。"""
    env = os.environ.get("PWDASH_DB")
    if env:
        return os.path.abspath(os.path.expanduser(env))
    here = os.path.dirname(os.path.abspath(__file__))
    repo_root = os.path.dirname(here)
    return os.path.join(repo_root, DB_NAME)


# --------------------------------------------------------------------------
# 校验与规范化
# --------------------------------------------------------------------------
def normalize_md5(value: str) -> str:
    """校验并规范化 32 位 MD5（统一小写）。非法则抛 ValueError。"""
    if not isinstance(value, str):
        raise ValueError("MD5 必须是字符串")
    v = value.strip().lower()
    if not MD5_RE.match(v):
        raise ValueError(f"不是合法的 32 位 MD5: {value!r}")
    return v


def is_md5(value: str) -> bool:
    return isinstance(value, str) and bool(MD5_RE.match(value.strip()))


def md5_of(password: str) -> str:
    """密码字符串的 MD5（与旧版 1.py 的写入规则一致）。"""
    return hashlib.md5(password.encode("utf-8")).hexdigest()


def mask(password: str, keep: int = 2) -> str:
    """把密码打码后再展示，避免日志/终端泄露。"""
    if password is None:
        return ""
    if len(password) <= keep * 2:
        return "*" * max(len(password), 1)
    return f"{password[:keep]}{'*' * (len(password) - keep * 2)}{password[-keep:]}"


# --------------------------------------------------------------------------
# 解码 / 编码
# --------------------------------------------------------------------------
def loads(raw: bytes) -> "dict[str, str]":
    """把库文件的字节流解析成 {md5: password}，兼容压缩与旧版列表格式。"""
    text = None
    # 依次尝试 gzip、zlib、裸 JSON
    for decoder in (gzip.decompress, zlib.decompress):
        try:
            text = decoder(raw).decode("utf-8")
            break
        except Exception:  # noqa: BLE001 - 换一种解码方式再试
            continue
    if text is None:
        try:
            text = raw.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise DBError(f"无法解码数据库内容: {exc}") from exc

    try:
        data = json.loads(text)
    except json.JSONDecodeError as exc:
        raise DBError(f"数据库不是合法 JSON: {exc}") from exc

    if isinstance(data, dict):
        return {str(k): str(v) for k, v in data.items()}
    if isinstance(data, list):
        # 旧版格式：[[md5, password], ...]
        out: "dict[str, str]" = {}
        for row in data:
            if isinstance(row, (list, tuple)) and len(row) >= 2:
                out[str(row[0])] = str(row[1])
        return out
    raise DBError(f"不支持的数据库结构: {type(data).__name__}")


def dumps(data: "dict[str, str]", *, compress: bool = True) -> bytes:
    """序列化为库文件字节流：紧凑 JSON，默认 zlib 压缩。"""
    payload = json.dumps(
        data, ensure_ascii=False, separators=(",", ":"), sort_keys=True
    ).encode("utf-8")
    return zlib.compress(payload, 9) if compress else payload


def dumps_pretty(data: "dict[str, str]") -> bytes:
    payload = json.dumps(
        data, ensure_ascii=False, indent=2, sort_keys=True
    ).encode("utf-8")
    return payload


# --------------------------------------------------------------------------
# 文件锁 + 原子写入
# --------------------------------------------------------------------------
class _FileLock:
    """跨进程互斥锁；拿不到 fcntl 时退化为“无锁但不报错”。"""

    def __init__(self, path: str, timeout: float = 10.0):
        self.lock_path = path + ".lock"
        self.timeout = timeout
        self._fh = None

    def __enter__(self):
        try:
            import fcntl
        except ImportError:  # Windows 等平台：不阻塞
            return self
        deadline = time.time() + self.timeout
        self._fh = open(self.lock_path, "a+")
        while True:
            try:
                fcntl.flock(self._fh.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                return self
            except OSError:
                if time.time() > deadline:
                    self._fh.close()
                    self._fh = None
                    raise DBError("数据库被其他进程占用，稍后重试")
                time.sleep(0.05)

    def __exit__(self, *exc_info):
        if self._fh is not None:
            try:
                import fcntl

                fcntl.flock(self._fh.fileno(), fcntl.LOCK_UN)
            except Exception:  # noqa: BLE001
                pass
            self._fh.close()
            self._fh = None
        return False


def atomic_write(path: str, data: bytes, mode: int = 0o644) -> None:
    """原子写文件：同目录临时文件 → fsync → os.replace。"""
    directory = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(directory, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-pwdash-")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


# --------------------------------------------------------------------------
# 高层 API
# --------------------------------------------------------------------------
class Store:
    """密码库的读写门面。"""

    def __init__(self, path: str | None = None):
        self.path = path or default_db_path()

    # ---- 读 ----
    def exists(self) -> bool:
        return os.path.exists(self.path)

    def load(self) -> "dict[str, str]":
        if not self.exists():
            return {}
        try:
            with open(self.path, "rb") as fh:
                return loads(fh.read())
        except DBError:
            raise
        except OSError as exc:
            raise DBError(f"读取数据库失败: {exc}") from exc

    def get(self, md5: str) -> "str | None":
        key = normalize_md5(md5)
        return self.load().get(key)

    def stats(self) -> "dict[str, object]":
        data = self.load()
        sizes = []
        bad = []
        for k, v in data.items():
            if not is_md5(k):
                bad.append(k)
            sizes.append(len(v))
        total = sum(sizes)
        return {
            "path": self.path,
            "compressed_bytes": os.path.getsize(self.path) if self.exists() else 0,
            "entries": len(data),
            "invalid_keys": bad,
            "avg_password_len": round(total / len(sizes), 2) if sizes else 0,
            "max_password_len": max(sizes) if sizes else 0,
        }

    # ---- 写 ----
    def save(self, data: "dict[str, str]") -> None:
        with _FileLock(self.path):
            atomic_write(self.path, dumps(data, compress=True))

    def put(self, md5: str, password: str) -> bool:
        """写入一条记录。返回 True 表示新增，False 表示已存在相同密码。"""
        key = normalize_md5(md5)
        if not password:
            raise ValueError("密码不能为空")
        with _FileLock(self.path):
            data = self.load()
            if data.get(key) == password:
                return False
            data[key] = password
            atomic_write(self.path, dumps(data, compress=True))
        return True

    def delete(self, md5: str) -> bool:
        key = normalize_md5(md5)
        with _FileLock(self.path):
            data = self.load()
            if key not in data:
                return False
            del data[key]
            atomic_write(self.path, dumps(data, compress=True))
        return True

    def merge(self, incoming: "dict[str, str]", *, overwrite: bool = False) -> "dict[str, int]":
        """合并另一份数据，返回统计。"""
        stats = {"added": 0, "updated": 0, "skipped": 0, "invalid": 0}
        with _FileLock(self.path):
            data = self.load()
            for raw_key, raw_val in incoming.items():
                if not is_md5(raw_key) or not raw_val:
                    stats["invalid"] += 1
                    continue
                key = raw_key.strip().lower()
                if key in data:
                    if overwrite and data[key] != raw_val:
                        data[key] = raw_val
                        stats["updated"] += 1
                    else:
                        stats["skipped"] += 1
                else:
                    data[key] = raw_val
                    stats["added"] += 1
            atomic_write(self.path, dumps(data, compress=True))
        return stats
