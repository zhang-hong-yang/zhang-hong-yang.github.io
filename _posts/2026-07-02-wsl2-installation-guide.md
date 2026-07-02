---
title: WSL2 安装与配置：导入发行版与开机自启动
description: 在 Windows 上导入 WSL2 发行版，并通过任务计划程序或 VBS 脚本实现开机自启动，适合长期运行 Docker、SSH 等后台服务。
date: 2026-07-02 10:00:00 +0800
categories: [教程, WSL]
tags: [安装, WSL, Windows, Rocky Linux, Docker]
order: 10
---

本文记录在 **Windows** 上使用 WSL2 导入自定义 Linux 发行版，并配置开机自启动的完整流程。适用于需要在 Windows 宿主机上长期运行 Docker、SSH 等后台服务的场景。

## 你将完成什么

- 从 `.wsl` 文件导入自定义发行版
- 查看、设置默认、启停和导出发行版
- 通过任务计划程序实现系统启动时自动运行 WSL（推荐）
- 通过 VBS 脚本实现用户登录后静默启动 WSL

---

## 导入 WSL 发行版

若已有打包好的 `.wsl` 发行版文件，可直接导入，无需从 Microsoft Store 安装：

```shell
wsl --import Rocky-10 D:/data/wsl/Rocky-10 D:/downloads/iso/Rocky-10-WSL-Base.latest.x86_64.wsl
```

参数说明：

| 参数 | 含义 |
|------|------|
| `Rocky-10` | 发行版名称，后续命令中以此引用 |
| `D:/data/wsl/Rocky-10` | 发行版数据存放目录 |
| `D:/downloads/iso/...wsl` | `.wsl` 发行版文件路径 |

导入后查看已安装的发行版：

```shell
wsl -l -v
```

输出中 `VERSION` 为 `2` 表示运行在 WSL2 模式。若为 `1`，可用 `wsl --set-version <发行版名> 2` 升级。

---

## 开机自启动配置

WSL 默认不会随 Windows 启动，需要手动配置。以下两种方式按场景选择。

### 方法一：任务计划程序（推荐）

**适用场景：** 长期在后台运行 Docker 或 SSH 服务，最稳定且无黑框弹窗。

**配置步骤：**

1. 按 `Win + R`，输入 `taskschd.msc` 回车，打开任务计划程序
2. 点击右侧 **创建任务**（不要点"创建基本任务"）
3. **常规** 选项卡：
   - 名称：`WSL_AutoStart`
   - 勾选 **不管用户是否登录都要运行**（隐藏弹窗）
   - 勾选 **以最高权限运行**
4. **触发器** 选项卡：新建 → 开始任务选择 **系统启动时**
5. **操作** 选项卡：
   - 程序或脚本：`C:\Windows\System32\wsl.exe`
   - 添加参数：`-d <发行版名> -u root -- bash -c "nohup tail -f /dev/null >/dev/null 2>&1 &"`
   - 示例：`-d Rocky-10 -u root -- bash -c "nohup tail -f /dev/null >/dev/null 2>&1 &"`
6. **条件** 选项卡：取消勾选 **只有在计算机使用交流电源时才启动此任务**
7. 保存时输入 Windows 账户密码

> 使用 `tail -f /dev/null` 保持 WSL 实例存活，避免启动后立即退出。若需以普通用户运行，将 `-u root` 改为目标用户名。

### 方法二：VBS 脚本

**适用场景：** 用户登录后启动 WSL，启动即最小化，配置更简单。

1. 按 `Win + R`，输入 `shell:startup` 回车，打开启动文件夹
2. 新建文本文档，重命名为 `wsl-start.vbs`（确保后缀是 `.vbs`）
3. 编辑脚本内容：

   ```vbs
   Set ws = WScript.CreateObject("WScript.Shell")
   ws.run "wsl.exe -d Rocky-10", vbhide
   ```

   将 `Rocky-10` 替换为你的发行版名称。

---

## 常用命令

```shell
# 列出所有发行版
wsl -l -v

# 设置默认发行版
wsl --set-default <发行版名>

# 启动指定发行版
wsl -d <发行版名>

# 关闭指定发行版
wsl -t <发行版名>

# 关闭所有发行版
wsl --shutdown

# 导出发行版（备份）
wsl --export <发行版名> <导出路径.tar>

# 注销发行版（删除，数据不可恢复）
wsl --unregister <发行版名>
```

---

## 常见问题

**任务计划程序启动后 WSL 仍不可用**

确认任务已勾选"以最高权限运行"，且触发器为"系统启动时"而非"用户登录时"。系统启动阶段 WSL 服务可能尚未就绪，可在操作参数前加延迟，或改用"延迟任务"触发器（延迟 30 秒）。

**VBS 脚本启动后窗口一闪而过**

检查发行版名称是否与 `wsl -l -v` 输出一致，注意大小写。

**需要迁移发行版到其他磁盘**

先用 `wsl --export` 导出，再 `wsl --unregister` 注销旧实例，最后用 `wsl --import` 导入到新路径。
