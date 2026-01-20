#!/usr/bin/env python3
import os, sys, subprocess, hashlib, json, zlib, requests, platform, uuid, shlex, re

SERVER = "http://127.0.0.1:5000"  # 替换为你的服务器地址
LOCAL_DB = os.path.join(os.getcwd(), "passwords_local.json.gz")

# ---------------------------
# 用户 ID
def get_user_id():
    uid_file = os.path.join(os.path.expanduser("~"), ".decompress_user_id")
    if os.path.exists(uid_file):
        with open(uid_file, "r") as f:
            return f.read().strip()
    user_id = str(uuid.uuid4())
    with open(uid_file, "w") as f:
        f.write(user_id)
    return user_id

USER_ID = get_user_id()
print(f"🔑 当前用户 ID: {USER_ID}")

# ---------------------------
# 环境检测
def detect_environment():
    is_termux = os.path.exists("/data/data/com.termux/files/usr/bin")
    is_linux = platform.system().lower() == "linux" and not is_termux
    return is_termux, is_linux

# ---------------------------
# 系统工具检测
def check_system_tools():
    is_termux, is_linux = detect_environment()
    tools = ["7z", "unrar"]
    for tool in tools:
        if subprocess.call(f"command -v {tool}", shell=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL) != 0:
            print(f"⚠️ 系统工具 {tool} 未安装")
            if is_termux:
                subprocess.call(f"pkg install -y {tool}", shell=True)
            elif is_linux:
                subprocess.call(f"sudo apt install -y {tool}", shell=True)

# ---------------------------
# Python 库检查（Linux）
def check_python_packages():
    is_termux, is_linux = detect_environment()
    if is_linux:
        packages = ["py7zr", "rarfile", "pyzipper", "requests"]
        for pkg in packages:
            try:
                __import__(pkg)
            except ImportError:
                subprocess.call(f"{sys.executable} -m pip install {pkg}", shell=True)

# ---------------------------
# 本地 MD5 存储
def load_local():
    if os.path.exists(LOCAL_DB):
        try:
            with open(LOCAL_DB, "rb") as f:
                data = json.loads(zlib.decompress(f.read()).decode())
                if isinstance(data, list):  # 兼容旧版列表
                    return {r[0].lower(): r[1] for r in data}
                return data
        except:
            return {}
    return {}

def save_local_record(md5_input, password):
    data = load_local()
    data[md5_input.lower()] = password
    with open(LOCAL_DB, "wb") as f:
        f.write(zlib.compress(json.dumps(data, separators=(",", ":")).encode()))
    print(f"💾 本地保存完成: MD5={md5_input} 密码={password}")

def md5_hash(password):
    return hashlib.md5(password.encode()).hexdigest()

# ---------------------------
# 上传密码
def upload_password(password):
    if not password.strip():  # 空密码不上传
        return
    h = md5_hash(password)
    payload = {"password": password, "user_id": USER_ID}
    try:
        r = requests.post(f"{SERVER}/upload", json=payload, timeout=5)
        if r.status_code == 200:
            print(f"📤 密码已上传: {password} (MD5: {h})")
        else:
            save_local_record(h, password)
    except:
        save_local_record(h, password)

# ---------------------------
# 查询密码
def is_valid_md5(h):
    return bool(re.fullmatch(r"[a-fA-F0-9]{32}", h))

def query_password(h):
    if not is_valid_md5(h):
        print("❌ 输入的 MD5 无效")
        return
    # 服务器查询
    try:
        r = requests.get(f"{SERVER}/query/{h}?user_id={USER_ID}", timeout=5)
        if r.status_code == 200:
            data = r.json()
            print(f"🔑 服务器查询结果: {data['password']}")
            return
    except:
        pass
    # 本地查询
    data = load_local()
    pwd = data.get(h.lower())
    if pwd:
        print(f"🔑 本地查询结果: {pwd}")
        return
    print("❌ 未找到该 MD5 的密码")

# ---------------------------
# 智能解压
def extract_file(filepath, password, out_dir):
    is_termux, is_linux = detect_environment()
    if not out_dir:
        out_dir = os.getcwd()
    if not os.path.exists(out_dir):
        os.makedirs(out_dir)
    filename = os.path.basename(filepath)
    name_without_ext = os.path.splitext(filename)[0]
    final_dir = os.path.join(out_dir, name_without_ext)
    if not os.path.exists(final_dir):
        os.makedirs(final_dir)

    success = False
    tried_tools = []

    # Termux 环境
    if is_termux:
        if filepath.lower().endswith((".7z", ".7z1", ".7z.001", ".zip")):
            cmd = f"7z x {shlex.quote(filepath)} -o{shlex.quote(final_dir)} -p{shlex.quote(password)} -y"
            result = subprocess.getoutput(cmd)
            tried_tools.append("7z")
            if "Wrong password" in result or "密码错误" in result:
                print("❌ 解压失败：密码错误")
                return
            elif "Everything is Ok" in result:
                success = True
        elif filepath.lower().endswith(".rar"):
            cmd = f"unrar x {shlex.quote(filepath)} {shlex.quote(final_dir)} -p{shlex.quote(password)}"
            result = subprocess.getoutput(cmd)
            tried_tools.append("unrar")
            if "Wrong password" in result or "密码错误" in result:
                print("❌ 解压失败：密码错误")
                return
            elif "All OK" in result:
                success = True

    # Linux 环境
    elif is_linux:
        import py7zr, pyzipper, rarfile
        ext = filepath.lower()
        try:
            if ext.endswith((".7z", ".7z1", ".7z.001")):
                with py7zr.SevenZipFile(filepath, mode="r", password=password) as sz:
                    sz.extractall(final_dir)
                success = True
                tried_tools.append("py7zr")
            elif ext.endswith((".zip", ".zip.001")):
                with pyzipper.AESZipFile(filepath) as zf:
                    try:
                        zf.extractall(final_dir, pwd=password.encode())
                        success = True
                        tried_tools.append("pyzipper")
                    except RuntimeError as e:
                        if "Bad password" in str(e):
                            print("❌ 解压失败：密码错误")
                            return
            elif ext.endswith(".rar"):
                with rarfile.RarFile(filepath) as rf:
                    try:
                        rf.extractall(final_dir, pwd=password)
                        success = True
                        tried_tools.append("rarfile")
                    except rarfile.BadRarFile:
                        print("❌ 解压失败：密码错误")
                        return
        except Exception as e:
            tried_tools.append("failed")

    if success:
        print(f"✅ 解压成功 ({', '.join(tried_tools)})")
        print(f"📂 文件已解压到: {final_dir}")
        if password.strip():
            upload_password(password)
    else:
        print(f"❌ 解压失败，尝试的工具: {', '.join(tried_tools)}")

# ---------------------------
# 导出JSON
def export_pretty_json():
    data = load_local()
    if not data:
        print("⚠️ 本地数据库为空，无法导出")
        return
    pretty_file = LOCAL_DB.replace(".json.gz", "_pretty.json")
    with open(pretty_file, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=4, ensure_ascii=False)
    print(f"📤 已导出JSON: {pretty_file}")

# ---------------------------
# 主菜单
def main_menu():
    while True:
        print("\n==== 📂 智能解压工具菜单 ====")
        print("1. 解压文件 (自动上传密码/本地备份)")
        print("2. 查询密码 (仅支持正确 MD5)")
        print("3. 手动添加 MD5 + 密码 (只适用于有密码的文件)")
        print("4. 导出本地数据库为JSON")
        print("5. 删除本地密码记录（MD5）")
        print("0. 退出")
        choice = input("请选择操作: ").strip()

        if choice == "1":
            filepath = input("请输入压缩文件路径: ").strip()
            if not os.path.exists(filepath):
                print("❌ 文件不存在")
            else:
                password = input("请输入解压密码(如无密码直接回车): ").strip()
                out_dir = input("请输入解压到的目录（回车使用当前目录）: ").strip()
                extract_file(filepath, password, out_dir)

        elif choice == "2":
            h = input("请输入要查询的 MD5: ").strip()
            query_password(h)

        elif choice == "3":
            while True:
                md5_input = input("请输入 MD5 (输入 0 返回主菜单): ").strip()
                if md5_input == "0":
                    break
                password = input("请输入密码: ").strip()
                if password.strip():
                    save_local_record(md5_input, password)
                    print(f"✅ 手动添加完成，你可以通过 MD5 查询: {md5_input}")
                else:
                    print("⚠️ 密码为空，不保存 MD5")

        elif choice == "4":
            export_pretty_json()

        elif choice == "5":
            md5_input = input("请输入要删除的 MD5 (输入 0 返回主菜单): ").strip()
            if md5_input != "0":
                delete_local_record(md5_input)

        elif choice == "0":
            print("👋 再见！")
            exit()

        else:
            print("⚠️ 无效选择，请重试。")
# ---------------------------
if __name__ == "__main__":
    check_system_tools()
    check_python_packages()
    main_menu()
