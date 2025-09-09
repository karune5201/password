#!/bin/sh
# Git 项目管理脚本 - 开源自由使用，请保留出处
# 作者：ChatGPT 改写

# 设置终端颜色
GREEN="\033[1;32m"
RED="\033[1;31m"
BLUE="\033[1;34m"
YELLOW="\033[1;33m"
RESET="\033[0m"

# 获取当前脚本所在目录
SCRIPT_DIR=$(cd "$(dirname "$0")" && pwd)
cd "$SCRIPT_DIR" || exit 1

# 打印欢迎信息
echo "==========================================="
echo "      欢迎使用 Git 项目管理脚本！"
echo "==========================================="
echo -e "${GREEN}当前目录：$SCRIPT_DIR${RESET}"
echo ""

# 检测是否是 Git 仓库
if [ ! -d ".git" ]; then
  echo -e "${RED}错误：当前目录不是一个 Git 仓库！${RESET}"
  exit 1
fi

# 获取远程仓库信息
REMOTE_URL=$(git config --get remote.origin.url)
if [ -n "$REMOTE_URL" ]; then
  echo -e "${BLUE}远程仓库：$REMOTE_URL${RESET}"
else
  echo -e "${YELLOW}警告：未配置远程仓库${RESET}"
fi

# 获取当前分支
CURRENT_BRANCH=$(git rev-parse --abbrev-ref HEAD)
echo -e "${BLUE}当前分支：$CURRENT_BRANCH${RESET}"
echo ""

# 展示菜单
echo "功能菜单："
echo "  [1] 从远程拉取最新版本"
echo "  [2] 提交本地修改到远程"
echo "  [3] 查看当前仓库状态"
echo "  [4] 查看提交历史"
echo "  [5] 切换分支"
echo "  [6] 创建新分支"
echo "  [7] 合并分支"
echo "  [8] 解决冲突"
echo "  [9] 标签管理"
echo "  [0] 退出脚本"
echo ""

# 读取用户输入
printf "请输入选项 [0-9]: "
read -r choice

# 处理用户选择
case "$choice" in
  1)
    echo -e "${GREEN}>> 开始从远程拉取最新代码...${RESET}"
    git pull origin "$CURRENT_BRANCH"
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}>> 拉取完成，仓库已更新为最新版本。${RESET}"
    else
      echo -e "${RED}>> 拉取失败，请检查网络连接或分支名称。${RESET}"
    fi
    ;;
  2)
    echo -e "${GREEN}>> 开始提交修改到远程...${RESET}"
    git add .
    printf "请输入提交信息: "
    read -r commit_message
    if [ -z "$commit_message" ]; then
      commit_message="Update by script"
    fi
    git commit -m "$commit_message"
    if [ $? -eq 0 ]; then
      git push origin "$CURRENT_BRANCH"
      if [ $? -eq 0 ]; then
        echo -e "${GREEN}>> 提交完成，修改已上传至远程。${RESET}"
      else
        echo -e "${RED}>> 推送失败，请检查远程仓库配置。${RESET}"
      fi
    else
      echo -e "${RED}>> 没有可提交的修改。${RESET}"
    fi
    ;;
  3)
    echo -e "${GREEN}>> 查看当前仓库状态...${RESET}"
    git status
    ;;
  4)
    echo -e "${GREEN}>> 查看提交历史...${RESET}"
    git log --pretty=format:"%C(yellow)%h %C(reset)%s %C(blue)(%an, %cr)%C(reset)" --graph
    ;;
  5)
    echo -e "${GREEN}>> 切换分支...${RESET}"
    printf "请输入目标分支名称: "
    read -r target_branch
    git checkout "$target_branch"
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}>> 已切换到分支: $target_branch${RESET}"
    else
      echo -e "${RED}>> 切换失败，分支 $target_branch 不存在或有未提交的修改。${RESET}"
    fi
    ;;
  6)
    echo -e "${GREEN}>> 创建新分支...${RESET}"
    printf "请输入新分支名称: "
    read -r new_branch
    git checkout -b "$new_branch"
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}>> 已创建并切换到新分支: $new_branch${RESET}"
    else
      echo -e "${RED}>> 创建失败，分支 $new_branch 已存在或有未提交的修改。${RESET}"
    fi
    ;;
  7)
    echo -e "${GREEN}>> 合并分支...${RESET}"
    printf "请输入要合并的分支名称: "
    read -r merge_branch
    git merge "$merge_branch"
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}>> 合并完成，分支 $merge_branch 已合并到当前分支。${RESET}"
    else
      echo -e "${RED}>> 合并失败，可能存在冲突或分支 $merge_branch 不存在。${RESET}"
    fi
    ;;
  8)
    echo -e "${GREEN}>> 解决冲突...${RESET}"
    git status
    echo ""
    printf "请输入已解决冲突的文件名（多个文件用空格分隔）: "
    read -r conflict_files
    for file in $conflict_files; do
      git add "$file"
    done
    git commit -m "Resolve merge conflicts"
    if [ $? -eq 0 ]; then
      echo -e "${GREEN}>> 冲突已解决并提交。${RESET}"
    else
      echo -e "${RED}>> 解决冲突失败，请检查文件状态。${RESET}"
    fi
    ;;
  9)
    echo -e "${GREEN}>> 标签管理...${RESET}"
    echo "标签子菜单："
    echo "  [1] 查看所有标签"
    echo "  [2] 创建新标签"
    echo "  [3] 删除标签"
    echo "  [4] 推送标签到远程"
    echo "  [5] 返回主菜单"
    printf "请输入标签操作选项 [1-5]: "
    read -r tag_choice
    case "$tag_choice" in
      1)
        echo -e "${GREEN}>> 查看所有标签...${RESET}"
        git tag
        ;;
      2)
        echo -e "${GREEN}>> 创建新标签...${RESET}"
        printf "请输入标签名称: "
        read -r tag_name
        git tag "$tag_name"
        if [ $? -eq 0 ]; then
          echo -e "${GREEN}>> 标签 $tag_name 创建成功。${RESET}"
        else
          echo -e "${RED}>> 创建标签失败，请检查标签名称。${RESET}"
        fi
        ;;
      3)
        echo -e "${GREEN}>> 删除标签...${RESET}"
        printf "请输入要删除的标签名称: "
        read -r tag_name
        git tag -d "$tag_name"
        if [ $? -eq 0 ]; then
          echo -e "${GREEN}>> 标签 $tag_name 已删除。${RESET}"
        else
          echo -e "${RED}>> 删除标签失败，标签 $tag_name 不存在。${RESET}"
        fi
        ;;
      4)
        echo -e "${GREEN}>> 推送标签到远程...${RESET}"
        printf "请输入要推送的标签名称（留空推送所有标签）: "
        read -r tag_name
        if [ -z "$tag_name" ]; then
          git push origin --tags
          echo -e "${GREEN}>> 所有标签已推送至远程。${RESET}"
        else
          git push origin "$tag_name"
          if [ $? -eq 0 ]; then
            echo -e "${GREEN}>> 标签 $tag_name 已推送至远程。${RESET}"
          else
            echo -e "${RED}>> 推送标签失败，请检查标签是否存在。${RESET}"
          fi
        fi
        ;;
      5)
        echo -e "${YELLOW}>> 返回主菜单${RESET}"
        ;;
      *)
        echo -e "${RED}>> 输入无效，请输入 1-5。${RESET}"
        ;;
    esac
    ;;
  0)
    echo -e "${GREEN}感谢使用，再见！${RESET}"
    exit 0
    ;;
  *)
    echo -e "${RED}输入无效，请输入 0-9。${RESET}"
    ;;
esac
