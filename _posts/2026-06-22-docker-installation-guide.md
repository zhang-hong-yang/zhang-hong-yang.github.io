---
title: Docker 安装与常用运维：GPU、Portainer 与镜像管理
description: 在 CentOS/RHEL 系 Linux 上安装 Docker Engine，配置 GPU 支持、部署 Portainer，以及镜像备份、恢复与重命名。
date: 2026-06-22 08:00:00 +0800
categories: [教程, Docker]
tags: [Docker, GPU, Portainer, 镜像备份, CentOS]
order: 10
---

本文记录在 **CentOS / RHEL / Rocky / AlmaLinux** 等使用 `dnf` 的 Linux 发行版上安装 Docker Engine 的完整流程，并补充 GPU 支持、Portainer 可视化管理，以及镜像备份与恢复等日常运维操作。

## 你将完成什么

- 安装官方 Docker CE 并验证运行
- 为容器启用 NVIDIA GPU
- 用 Portainer 图形化管理 Docker
- 备份、恢复、重命名本地镜像

---

## 安装 Docker Engine

### 1. 更新系统并安装依赖

```bash
sudo dnf update -y

# 安装 yum-utils 等，允许 dnf 使用 HTTPS 仓库
sudo dnf install -y yum-utils device-mapper-persistent-data lvm2
```

### 2. 添加 Docker 官方仓库并安装

```bash
sudo dnf config-manager --add-repo https://download.docker.com/linux/centos/docker-ce.repo
sudo dnf install -y docker-ce docker-ce-cli containerd.io
```

验证版本：

```bash
docker --version
```

### 3. 配置并启动服务

若宿主机已有统一管理的防火墙策略，可按需调整 `daemon.json`（详见另一篇 [daemon.json 参数说明](/posts/docker-daemon-json-guide/)）。此处仅示例关闭 Docker 自动管理 iptables 的场景：

```bash
echo '{ "iptables": false }' | sudo tee /etc/docker/daemon.json
```

> 一般服务器建议保持 `"iptables": true`，仅在明确需要手动管理防火墙时才关闭。

启动并设置开机自启：

```bash
sudo systemctl start docker
sudo systemctl enable docker
```

运行测试容器：

```bash
docker run hello-world
```

看到 `Hello from Docker!` 即表示安装成功。

---

## Docker 支持 GPU

若需要在容器中使用 NVIDIA 显卡，先确认驱动正常：

```bash
nvidia-smi
```

输出中 **CUDA Version ≥ 12.1** 即可继续。

### 1. 安装 NVIDIA Container Toolkit

```bash
curl -s -L https://nvidia.github.io/libnvidia-container/stable/rpm/nvidia-container-toolkit.repo | \
  sudo tee /etc/yum.repos.d/nvidia-container-toolkit.repo

sudo dnf install -y nvidia-container-toolkit
```

### 2. 配置 Docker 使用 NVIDIA Runtime

```bash
sudo nvidia-ctk runtime configure --runtime=docker
sudo systemctl restart docker
```

### 3. 验证

```bash
docker run --rm --gpus all nvidia/cuda:12.4.1-base-ubuntu22.04 nvidia-smi
```

若能正常显示显卡信息，说明 GPU 已在容器中可用。

---

## 安装 Portainer

[Portainer](https://www.portainer.io/) 是轻量级 Docker 可视化管理面板，适合本地或内网环境快速查看容器、镜像、卷和网络。

### 创建持久化卷

```bash
docker volume create portainer_data
```

### 方式一：docker run

```bash
docker run -d -p 9000:9000 \
  --name=portainer \
  --restart=always \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v portainer_data:/data \
  portainer/portainer-ce:latest
```

浏览器访问 `http://<服务器IP>:9000`，按向导创建管理员账号即可。

### 方式二：Docker Compose

```yaml
services:
  portainer:
    image: portainer/portainer-ce:latest
    container_name: portainer
    restart: always
    ports:
      - "9000:9000"
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - portainer_data:/data

volumes:
  portainer_data:
```

---

## 镜像备份

### 备份单个镜像

```bash
# 语法：docker save -o <备份文件名>.tar <镜像名>:<标签>
docker save -o nginx_backup.tar nginx:latest
```

`docker save` 会导出镜像的所有层和标签，适合离线迁移或灾备。

### 批量备份脚本

```bash
#!/bin/bash
BACKUP_DIR="./docker_backup"
mkdir -p "$BACKUP_DIR"

docker images --format "{% raw %}{{.Repository}}:{{.Tag}}{% endraw %}" | grep -v "<none>" | while read -r image; do
    filename=$(echo "$image" | sed 's/[\/:]/_/g').tar
    echo "导出镜像: $image -> $filename"
    docker save -o "$BACKUP_DIR/$filename" "$image"
done

echo "备份完成！备份目录: $BACKUP_DIR"
```

---

## 镜像恢复

```bash
# 若备份文件经过压缩，先解压
tar -xzf docker_images_backup_*.tar.gz

cd docker_backup

# 加载镜像
docker load -i <某个镜像备份文件>.tar

# 验证
docker images | grep nginx
docker run -it nginx:latest /bin/bash
```

`docker load` 会将 tar 包中的镜像层还原到本地镜像仓库。

---

## 镜像重命名

有时需要给镜像打上新的仓库名或标签（例如推送到私有 Registry 前）：

```bash
docker images

# 语法：docker tag [旧镜像名]:[旧标签] [新镜像名]:[新标签]
docker tag my-old-image:latest my-new-image:v1.0

# 删除旧名称（镜像层未变，仅移除标签）
docker rmi my-old-image:latest
```

`docker tag` 不会复制镜像数据，只是为同一镜像 ID 增加新标签。

---

## 小结

| 操作 | 命令 |
|------|------|
| 安装验证 | `docker run hello-world` |
| GPU 验证 | `docker run --rm --gpus all nvidia/cuda:... nvidia-smi` |
| 导出镜像 | `docker save -o file.tar image:tag` |
| 导入镜像 | `docker load -i file.tar` |
| 重命名标签 | `docker tag old:new` |

后续可继续阅读 [daemon.json 配置说明](/posts/docker-daemon-json-guide/) 和 [容器出网白名单限制](/posts/docker-container-egress-restriction/)，完善 Docker 网络与存储策略。
