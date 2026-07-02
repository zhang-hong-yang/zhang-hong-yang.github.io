---
title: Rocky Linux 10 离线本地仓库：系统升级与 KVM 安装
description: 在 Rocky Linux 10 上制作离线 DNF 本地仓库，下载系统更新、EPEL 和 KVM 相关包，实现无网络环境下的系统升级与虚拟化组件安装。
date: 2026-07-02 11:00:00 +0800
categories: [教程, Linux]
tags: [Rocky Linux, DNF, 离线仓库, KVM, createrepo]
order: 20
---

本文介绍在 **Rocky Linux 10** 上制作离线 DNF 本地仓库的完整方案。仓库统一存放在 `/data/local_repo`，包含系统更新、EPEL、KVM 虚拟化工具等 RPM 包，可在无网络环境下完成系统升级和 KVM 安装。

## 你将完成什么

- 创建本地仓库目录并启用 AppStream、CRB 仓库
- 下载系统更新、EPEL 和 KVM 相关 RPM 包
- 使用 `createrepo` 生成仓库元数据
- 配置本地仓库并完成离线升级与 KVM 安装

---

## 前置条件

- 已安装 Rocky Linux 10，且当前机器**可以联网**（用于下载 RPM 包）
- 具有 `sudo` 权限
- 磁盘空间充足（下载全部可更新包会占用较多空间，建议预留 10 GB 以上）

> 本方案分两个阶段：**联网机器**下载并打包仓库，**离线机器**挂载仓库后安装。若同一台机器先联网下载、再断网安装，也可直接按本文操作。

---

## 1. 准备本地仓库目录

```bash
sudo mkdir -p /data/local_repo
sudo chown $USER:$USER /data/local_repo
```

---

## 2. 启用基础仓库

Rocky Linux 10 的部分虚拟化依赖来自 AppStream 和 CRB（CodeReady Builder），需先启用：

```bash
sudo dnf config-manager --set-enabled appstream
sudo dnf config-manager --set-enabled crb
sudo dnf makecache
```

---

## 3. 下载离线包

### 3.1 下载 epel-release

```bash
sudo dnf download --downloaddir=/data/local_repo epel-release
```

### 3.2 下载系统更新及依赖包

```bash
sudo dnf download --resolve --alldeps --downloaddir=/data/local_repo '*'
```

`*` 表示下载所有可更新的包及其依赖，确保离线环境下升级可以完整完成。下载时间较长，视更新量而定。

### 3.3 下载 KVM 和虚拟化工具

```bash
sudo dnf download --resolve --alldeps --downloaddir=/data/local_repo \
  qemu-kvm libvirt libvirt-daemon libvirt-client virt-install virt-manager \
  virt-viewer libguestfs-tools virt-top bridge-utils \
  cockpit cockpit-machines
```

若还需离线安装 Docker，可一并下载：

```bash
sudo dnf download --resolve --alldeps --downloaddir=/data/local_repo \
  dnf-plugins-core ca-certificates curl gnupg \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
```

---

## 4. 创建仓库元数据

```bash
sudo dnf install -y createrepo
sudo createrepo /data/local_repo
```

`createrepo` 会在 `/data/local_repo/repodata/` 下生成元数据，DNF/YUM 据此识别本地仓库。

---

## 5. 配置本地仓库

在 `/etc/yum.repos.d/` 创建 `local.repo`：

```bash
sudo tee /etc/yum.repos.d/local.repo <<'EOF'
[local-repo]
name=Local Repository
baseurl=file:///data/local_repo
enabled=1
gpgcheck=0
EOF
```

生成缓存并确认仓库已启用：

```bash
sudo dnf makecache
sudo dnf repolist enabled
```

输出中应能看到 `local-repo` 处于 enabled 状态。

---

## 6. 离线升级与安装

断网后（或禁用远程仓库），仅使用本地仓库操作：

### 6.1 升级系统

```bash
sudo dnf upgrade --disablerepo="*" --enablerepo=local-repo -y
```

### 6.2 安装 KVM 和虚拟化工具

```bash
sudo dnf install -y \
  qemu-kvm libvirt libvirt-daemon libvirt-client virt-install virt-manager \
  virt-viewer libguestfs-tools virt-top cockpit cockpit-machines \
  --disablerepo="*" --enablerepo=local-repo
```

安装完成后，可参考 [Rocky Linux 10 安装 KVM 与 NVIDIA 显卡直通](/posts/kvm-install-gpu-passthrough/) 继续配置虚拟化环境。

---

## 一键脚本

以下脚本将上述步骤合并，适合在联网环境下一次性执行：

```bash
#!/bin/bash
set -e

LOCAL_REPO="/data/local_repo"

echo "=== 1. 创建本地仓库目录 ==="
sudo mkdir -p "$LOCAL_REPO"
sudo chown $USER:$USER "$LOCAL_REPO"

echo "=== 2. 启用基础仓库 ==="
sudo dnf config-manager --set-enabled appstream
sudo dnf config-manager --set-enabled crb
sudo dnf makecache

echo "=== 3. 下载 epel-release ==="
sudo dnf download --downloaddir="$LOCAL_REPO" epel-release

echo "=== 4. 下载系统更新及依赖 ==="
sudo dnf download --resolve --alldeps --downloaddir="$LOCAL_REPO" '*'

echo "=== 5. 下载 KVM 及虚拟化工具 ==="
sudo dnf download --resolve --alldeps --downloaddir="$LOCAL_REPO" \
  qemu-kvm libvirt libvirt-daemon libvirt-client virt-install virt-manager \
  virt-viewer libguestfs-tools virt-top cockpit cockpit-machines \
  dnf-plugins-core ca-certificates curl gnupg \
  docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "=== 6. 生成仓库元数据 ==="
sudo dnf install -y createrepo
sudo createrepo "$LOCAL_REPO"

echo "=== 7. 配置本地仓库 ==="
sudo tee /etc/yum.repos.d/local.repo > /dev/null <<EOF
[local-repo]
name=Local Repository
baseurl=file://$LOCAL_REPO
enabled=1
gpgcheck=0
EOF

echo "=== 8. 生成缓存并确认仓库 ==="
sudo dnf makecache
sudo dnf repolist enabled

echo "=== 9. 离线升级系统 ==="
sudo dnf upgrade --disablerepo="*" --enablerepo=local-repo -y

echo "=== 10. 安装 KVM 和虚拟化工具 ==="
sudo dnf install -y \
  qemu-kvm libvirt libvirt-daemon libvirt-client virt-install virt-manager \
  virt-viewer libguestfs-tools virt-top cockpit cockpit-machines \
  --disablerepo="*" --enablerepo=local-repo

echo "=== 离线仓库准备完成，系统升级和 KVM 安装成功 ==="
```

---

## 迁移到离线机器

若需在另一台无网络的 Rocky Linux 10 机器上使用：

1. 将 `/data/local_repo` 整个目录复制到目标机器（U 盘、内网传输等）
2. 在目标机器上创建相同的 `local.repo` 配置
3. 执行 `sudo dnf makecache` 后，按第 6 节进行升级和安装

仓库内容有更新时，在联网机器重新执行下载步骤，再运行 `createrepo /data/local_repo` 刷新元数据即可。
