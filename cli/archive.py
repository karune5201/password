#!/usr/bin/env python3
"""archive —— 压缩包密码校验与解压（多后端自动降级，零硬依赖）。

后端优先级：
  .zip  → pyzipper（支持 AES-256）> 标准库 zipfile（ZipCrypto）> 7z 命令行
  .7z   → py7zr > 7z 命令行
  .rar  → rarfile + unrar/bsdtar > unrar 命令行

任何后端缺失都只会返回 MISSING_DEPS，不会崩、也不会偷偷 pip install。
"""

from __future__ import annotations

import os
import shutil
import subprocess
import zipfile
from dataclasses import dataclass

OK = "ok"
BAD_PASSWORD = "bad_password"
MISSING_DEPS = "missing_deps"
UNSUPPORTED = "unsupported"
ERROR = "error"


@dataclass
class Result:
    status: str
    tool: str = ""
    detail: str = ""
    out_dir: str = ""

    @property
    def ok(self) -> bool:
        return self.status == OK

    def message(self) -> str:
        if self.status == OK:
            base = f"解压成功（{self.tool}）"
            return f"{base} → {self.out_dir}" if self.out_dir else base
        if self.status == BAD_PASSWORD:
            return f"密码错误（{self.tool}）" if self.tool else "密码错误"
        if self.status == MISSING_DEPS:
            return f"缺少后端: {self.detail}"
        if self.status == UNSUPPORTED:
            return f"不支持的格式: {self.detail}"
        return f"解压失败: {self.detail}"


def detect_kind(path: str) -> str:
    """按扩展名（含分卷）判断格式。"""
    name = os.path.basename(path).lower()
    for suffix, kind in (
        (".7z", "7z"),
        (".rar", "rar"),
        (".zip", "zip"),
    ):
        if suffix in name:
            return kind
    return ""


def _has_module(name: str) -> bool:
    try:
        __import__(name)
        return True
    except Exception:  # noqa: BLE001
        return False


def has_cmd(name: str) -> bool:
    return shutil.which(name) is not None


def _run(cmd: "list[str]", timeout: int = 600) -> "tuple[int, str]":
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            timeout=timeout,
            check=False,
        )
        return proc.returncode, proc.stdout.decode("utf-8", "replace")
    except FileNotFoundError:
        return 127, "命令不存在"
    except subprocess.TimeoutExpired:
        return 124, "超时"


def _safe_targets(names: "list[str]") -> "list[str]":
    """挑出有路径穿越风险的条目名。"""
    bad = []
    for n in names:
        p = n.replace("\\", "/")
        if p.startswith("/") or ".." in p.split("/"):
            bad.append(n)
    return bad


# --------------------------------------------------------------------------
# ZIP
# --------------------------------------------------------------------------
def _zip_with_pyzipper(path: str, password: str, out_dir: str | None) -> Result:
    try:
        import pyzipper  # type: ignore
    except ImportError:
        return Result(MISSING_DEPS, "pyzipper", "pip install pyzipper")
    try:
        with pyzipper.AESZipFile(path) as zf:
            names = zf.namelist()
            unsafe = _safe_targets(names)
            if unsafe:
                return Result(ERROR, "pyzipper", f"含可疑路径: {unsafe[:3]}")
            if out_dir is None:
                return Result(OK, "pyzipper")
            zf.extractall(out_dir, pwd=password.encode("utf-8"))
        return Result(OK, "pyzipper", out_dir=out_dir)
    except RuntimeError as exc:
        if "password" in str(exc).lower():
            return Result(BAD_PASSWORD, "pyzipper")
        return Result(ERROR, "pyzipper", str(exc))
    except Exception as exc:  # noqa: BLE001
        if "password" in str(exc).lower() or "Bad" in str(exc):
            return Result(BAD_PASSWORD, "pyzipper")
        return Result(ERROR, "pyzipper", str(exc))


def _zip_with_stdlib(path: str, password: str, out_dir: str | None) -> Result:
    """标准库只支持 ZipCrypto；AES 加密会直接报 unsupported。"""
    try:
        with zipfile.ZipFile(path) as zf:
            infos = zf.infolist()
            unsafe = _safe_targets([i.filename for i in infos])
            if unsafe:
                return Result(ERROR, "zipfile", f"含可疑路径: {unsafe[:3]}")

            encrypted = [i for i in infos if i.flag_bits & 0x1]
            if any(i.compress_type == 99 for i in encrypted):
                return Result(
                    UNSUPPORTED, "zipfile", "AES 加密需要 pyzipper 或 7z 命令行"
                )
            if not encrypted:
                return Result(BAD_PASSWORD, "zipfile", "压缩包未加密，但填了密码")

            pwd = password.encode("utf-8")
            # 用最小的条目做校验，避免解整包才知道密码错
            probe = min(encrypted, key=lambda i: i.file_size)
            try:
                with zf.open(probe, pwd=pwd) as fh:
                    fh.read(1)
            except RuntimeError as exc:
                if "password" in str(exc).lower():
                    return Result(BAD_PASSWORD, "zipfile")
                return Result(ERROR, "zipfile", str(exc))

            if out_dir is None:
                return Result(OK, "zipfile")
            zf.extractall(out_dir, pwd=pwd)
        return Result(OK, "zipfile", out_dir=out_dir)
    except zipfile.BadZipFile as exc:
        return Result(ERROR, "zipfile", f"压缩包损坏或分卷未合并: {exc}")


def _zip_with_cmd(path: str, password: str, out_dir: str | None) -> Result:
    exe = shutil.which("7z") or shutil.which("7za") or shutil.which("7zz")
    if not exe:
        return Result(MISSING_DEPS, "7z", "缺少 pyzipper / 7z")
    args = [exe, "t" if out_dir is None else "x", path, f"-p{password}", "-y"]
    if out_dir is not None:
        args.append(f"-o{out_dir}")
    code, output = _run(args)
    if code == 0:
        return Result(OK, "7z", out_dir=out_dir or "")
    if code == 2 or "Wrong password" in output or "Data Error" in output:
        return Result(BAD_PASSWORD, "7z")
    return Result(ERROR, "7z", f"exit={code}: {output.strip()[:200]}")


# --------------------------------------------------------------------------
# 7Z
# --------------------------------------------------------------------------
def _7z_with_py7zr(path: str, password: str, out_dir: str | None) -> Result:
    try:
        import py7zr  # type: ignore
    except ImportError:
        return Result(MISSING_DEPS, "py7zr", "pip install py7zr")
    try:
        with py7zr.SevenZipFile(path, mode="r", password=password) as zf:
            names = zf.getnames()
            unsafe = _safe_targets(names)
            if unsafe:
                return Result(ERROR, "py7zr", f"含可疑路径: {unsafe[:3]}")
            if out_dir is None:
                return Result(OK, "py7zr")
            zf.extractall(path=out_dir)
        return Result(OK, "py7zr", out_dir=out_dir)
    except Exception as exc:  # noqa: BLE001
        text = str(exc)
        low = text.lower()
        if "password" in low or "bad" in low or "crc" in low:
            return Result(BAD_PASSWORD, "py7zr")
        return Result(ERROR, "py7zr", text)


def _7z_with_cmd(path: str, password: str, out_dir: str | None) -> Result:
    return _zip_with_cmd(path, password, out_dir)


# --------------------------------------------------------------------------
# RAR
# --------------------------------------------------------------------------
def _rar_with_rarfile(path: str, password: str, out_dir: str | None) -> Result:
    try:
        import rarfile  # type: ignore
    except ImportError:
        return Result(MISSING_DEPS, "rarfile", "pip install rarfile（并安装 unrar）")
    try:
        with rarfile.RarFile(path) as rf:
            unsafe = _safe_targets(rf.namelist())
            if unsafe:
                return Result(ERROR, "rarfile", f"含可疑路径: {unsafe[:3]}")
            if out_dir is None:
                return Result(OK, "rarfile")
            rf.extractall(out_dir, pwd=password)
        return Result(OK, "rarfile", out_dir=out_dir)
    except rarfile.BadRarFile as exc:
        low = str(exc).lower()
        if "password" in low or "bad" in low:
            return Result(BAD_PASSWORD, "rarfile")
        return Result(ERROR, "rarfile", str(exc))
    except Exception as exc:  # noqa: BLE001
        low = str(exc).lower()
        if "password" in low or "bad" in low:
            return Result(BAD_PASSWORD, "rarfile")
        return Result(ERROR, "rarfile", str(exc))


def _rar_with_cmd(path: str, password: str, out_dir: str | None) -> Result:
    exe = shutil.which("unrar") or shutil.which("bsdtar")
    if not exe:
        return Result(MISSING_DEPS, "unrar", "缺少 rarfile / unrar")
    if out_dir is None:
        args = [exe, "t", "-p" + password, path]
        code, output = _run(args)
    else:
        args = [exe, "x", "-p" + password, "-y", path, out_dir + os.sep]
        code, output = _run(args)
    if code == 0:
        return Result(OK, "unrar", out_dir=out_dir or "")
    if code in (3, 11) or "password" in output.lower():
        return Result(BAD_PASSWORD, "unrar")
    return Result(ERROR, "unrar", f"exit={code}: {output.strip()[:200]}")


# --------------------------------------------------------------------------
# 对外入口
# --------------------------------------------------------------------------
def extract(
    path: str,
    password: str,
    out_dir: str | None,
    *,
    prefer: str = "",
) -> Result:
    """依次尝试各后端；out_dir=None 时只校验密码对不对。"""
    if not os.path.exists(path):
        return Result(ERROR, "", f"文件不存在: {path}")

    kind = detect_kind(path)
    if not kind:
        return Result(UNSUPPORTED, "", os.path.basename(path))

    if out_dir is not None:
        os.makedirs(out_dir, exist_ok=True)

    chains = {
        "zip": [
            ("pyzipper", _zip_with_pyzipper),
            ("zipfile", _zip_with_stdlib),
            ("7z", _zip_with_cmd),
        ],
        "7z": [("py7zr", _7z_with_py7zr), ("7z", _7z_with_cmd)],
        "rar": [("rarfile", _rar_with_rarfile), ("unrar", _rar_with_cmd)],
    }[kind]

    if prefer:
        chains.sort(key=lambda item: item[0] != prefer)

    last = Result(MISSING_DEPS, "", "无可用后端")
    tried = []
    for name, fn in chains:
        result = fn(path, password, out_dir)
        tried.append(f"{name}:{result.status}")
        if result.status in (OK, BAD_PASSWORD):
            return result
        if result.status == ERROR and "可疑路径" in result.detail:
            return result
        last = result

    last.detail = f"{last.detail}（已尝试 {', '.join(tried)}）"
    return last


def backend_status() -> "dict[str, str]":
    """给 doctor 用的后端可用性报告。"""
    return {
        "pyzipper(AES zip)": "✅" if _has_module("pyzipper") else "❌ 未安装",
        "zipfile(ZipCrypto)": "✅ 内置",
        "py7zr(7z)": "✅" if _has_module("py7zr") else "❌ 未安装",
        "rarfile(rar)": "✅" if _has_module("rarfile") else "❌ 未安装",
        "7z 命令": f"✅ {shutil.which('7z') or shutil.which('7za') or shutil.which('7zz')}"
        if has_cmd("7z") or has_cmd("7za") or has_cmd("7zz")
        else "❌ 未安装",
        "unrar 命令": f"✅ {shutil.which('unrar') or shutil.which('bsdtar')}"
        if has_cmd("unrar") or has_cmd("bsdtar")
        else "❌ 未安装",
    }
