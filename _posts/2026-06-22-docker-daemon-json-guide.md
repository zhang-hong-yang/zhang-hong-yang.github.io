---
title: Docker daemon.json 配置详解：iptables、镜像加速与数据目录
description: 说明 /etc/docker/daemon.json 中 iptables、registry-mirrors、data-root 三个常用参数的作用、推荐值与迁移步骤。
date: 2026-06-22 10:00:00 +0800
categories: [教程, Docker]
tags: [Docker, daemon.json, iptables, 镜像加速, data-root]
order: 20
---

Docker Engine 的全局配置写在 `/etc/docker/daemon.json`。本文聚焦三个最常用的参数：`iptables`、`registry-mirrors`、`data-root`——分别控制防火墙规则、镜像拉取加速和数据存储位置。

> 常见拼写错误：`mirros` 应写作 **`registry-mirrors`**，写错后 Docker 不会识别该配置项。

## 常见配置示例

```json
{
  "iptables": true,
  "registry-mirrors": [
    "https://mirror.example.com"
  ],
  "data-root": "/data/docker"
}
```

配置文件路径（Linux）：

```bash
/etc/docker/daemon.json
```

修改后重启 Docker：

```bash
sudo systemctl restart docker
```

验证是否生效：

```bash
docker info | grep -E "Docker Root Dir|Registry Mirrors"
```

---

## 参数总览

| 参数 | 类型 | 默认值 | 作用 |
|------|------|--------|------|
| `iptables` | boolean | `true` | 是否允许 Docker 自动管理容器网络相关的 iptables / NAT 规则 |
| `registry-mirrors` | array | `[]` | 配置 Docker Hub 镜像加速器 |
| `data-root` | string | `/var/lib/docker` | 修改 Docker 持久化数据目录 |

---

## iptables

### 作用

`iptables` 控制 Docker daemon 是否自动创建和维护防火墙规则。设为 `true` 时，Docker 会自动处理：

- 容器端口映射（如 `-p 8080:80`）
- 容器访问外网所需的 NAT / masquerade
- bridge 网络相关规则
- 部分容器间通信规则

### 推荐值

一般保持默认即可：

```json
{
  "iptables": true
}
```

### 设置为 false 的影响

```json
{
  "iptables": false
}
```

关闭后 Docker **不会**自动添加大部分网络防火墙规则，可能导致：

- 端口映射不生效
- 容器无法访问外网
- bridge 网络通信异常
- 需要手动维护防火墙、NAT、转发规则

### 适用场景

仅在以下情况才考虑关闭：

- 服务器防火墙由运维系统统一管理
- 你清楚 Docker 需要哪些 NAT / FORWARD 规则
- 需要避免 Docker 自动修改已有防火墙策略

> 若需对容器出网做精细白名单控制，可参考 [容器禁止访问外网](/posts/docker-container-egress-restriction/) 一文，在 `DOCKER-USER` 链中自定义规则。

---

## registry-mirrors

### 作用

配置 Docker Hub 镜像加速器。执行 `docker pull nginx` 等拉取 Docker Hub 镜像的命令时，Docker 会优先通过配置的 mirror 下载，提高国内或内网环境的拉取速度。

### 正确写法

```json
{
  "registry-mirrors": [
    "https://mirror.example.com"
  ]
}
```

### 错误写法

```json
{
  "mirros": [
    "https://mirror.example.com"
  ]
}
```

`mirros` 拼写错误，配置将被忽略。

### 注意事项

- 值必须是**数组**，即使只有一个 mirror 也要写成 `[]`
- 地址通常以 `https://` 开头
- 修改后需重启 Docker 才生效
- 只影响**拉取**镜像，不改变本地存储位置

---

## data-root

### 作用

`data-root` 指定 Docker 的数据目录，其中通常包含：

- 镜像层数据
- 容器可写层
- volume 数据
- 网络状态
- build cache
- 元数据等

Linux 默认路径：

```bash
/var/lib/docker
```

### 常见用途

系统盘空间不足时，将数据迁移到大容量磁盘：

```json
{
  "data-root": "/mnt/docker-data"
}
```

### 迁移已有数据的步骤

> 操作前建议备份重要数据。

**1. 停止 Docker**

```bash
sudo systemctl stop docker
```

**2. 复制旧数据到新目录**

```bash
sudo rsync -aHAX /var/lib/docker/ /data/docker/
```

**3. 修改配置**

```bash
sudo mkdir -p /etc/docker
sudo vi /etc/docker/daemon.json
```

写入：

```json
{
  "data-root": "/data/docker"
}
```

**4. 启动并确认**

```bash
sudo systemctl start docker
docker info | grep "Docker Root Dir"
```

**5. 确认无误后清理旧目录**

```bash
sudo mv /var/lib/docker /var/lib/docker.bak
```

运行一段时间确认正常后，再删除备份目录。

---

## 配置文件校验

修改 `daemon.json` 后，建议先校验 JSON 语法和 daemon 配置：

```bash
sudo dockerd --validate --config-file=/etc/docker/daemon.json
```

校验通过后再重启：

```bash
sudo systemctl restart docker
```

---

## 推荐配置模板

普通服务器可按需组合：

```json
{
  "iptables": true,
  "registry-mirrors": [
    "https://mirror.example.com"
  ],
  "data-root": "/data/docker"
}
```

建议：

- `iptables` 保持 `true`，除非有明确的防火墙统一管理需求
- `registry-mirrors` 填写实际可用的加速器地址
- `data-root` 仅在系统盘不足或需要指定数据盘时修改

---

## 参考资料

- [Docker daemon 配置概览](https://docs.docker.com/engine/daemon/)
- [dockerd 参数参考](https://docs.docker.com/reference/cli/dockerd/)
- [Docker Hub mirror 配置](https://docs.docker.com/docker-hub/image-library/mirror/)
- [Docker 防火墙与 iptables](https://docs.docker.com/engine/network/packet-filtering-firewalls/)
