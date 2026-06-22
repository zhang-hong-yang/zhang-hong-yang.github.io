---
title: Docker 容器出网限制：仅允许访问指定网段
description: 通过自定义 bridge 网络与 DOCKER-USER 链 iptables 规则，实现容器禁止访问外网、仅放行白名单网段的完整方案。
date: 2026-06-22 12:00:00 +0800
categories: [教程, Docker]
tags: [Docker, iptables, 网络安全, Docker Compose, 出网限制]
order: 30
---

在生产或内网环境中，有时需要让 Docker 容器**不能访问公网**，只能访问指定的内网网段（如局域网服务、内网 API）。本文给出一套可复用的完整方案：统一自定义 bridge 网络 + 宿主机 `DOCKER-USER` 链出站白名单。

## 核心思路

1. 所有需要限制出网的容器，统一加入一个自定义 bridge 网络
2. 给该网络固定容器源网段（如 `172.30.0.0/16`）
3. 在宿主机 `DOCKER-USER` 链中：
   - 源地址为该 Docker 网段的流量 → 进入自定义链
   - 目标是白名单网段 → **放行**
   - 目标是其它地址 → **拒绝**

> Docker 官方建议：用户自定义防火墙规则应放在 `DOCKER-USER` 链，因为它会在 Docker 自己的转发规则之前处理。

## 方案目标示例

| 类型 | 网段 / 范围 |
|------|-------------|
| Docker 受限容器网段 | `172.30.0.0/16` |
| 允许访问 | `192.168.0.0/24`、`10.10.0.0/16` |
| 禁止访问 | 公网及其它所有地址 |

下文中的允许网段可按你的实际环境修改。

---

## 第 1 步：创建统一 Docker 网络

只需执行一次：

```bash
docker network create \
  --driver bridge \
  --subnet 172.30.0.0/16 \
  --gateway 172.30.0.1 \
  docker_restricted
```

确认网络信息：

```bash
docker network inspect docker_restricted
```

自定义 bridge 网络比默认 bridge 隔离性更好，可指定 subnet、gateway 等参数。

---

## 第 2 步：修改 Docker Compose 文件

### 推荐改法：整个 compose 加入受限网络

在每个 compose 文件末尾添加：

```yaml
networks:
  default:
    external: true
    name: docker_restricted
```

### 完整示例

```yaml
services:
  kkfileView:
    image: wangbowen/kkfileview:5.1.0
    container_name: kkfileView
    restart: unless-stopped
    ports:
      - "8012:8012"
    volumes:
      - ./kkFileView-5.0.0:/opt/kkFileView-5.0.0
    environment:
      - KK_OFFICE_PREVIEW_TYPE=pdf
      - KK_OFFICE_PREVIEW_SWITCH_DISABLED=true
      - KK_PDF_DOWNLOAD_DISABLE=true
      - KK_CONTEXT_PATH=/preview
      - KK_BASE_URL=
      - KK_TRUST_HOST=*

networks:
  default:
    external: true
    name: docker_restricted
```

> `external` 网络必须提前创建，否则 `docker compose up` 会报 `network not found`。

### 不要使用 host 网络

```yaml
# ❌ 不要使用
network_mode: host
```

`host` 网络不走 Docker bridge 网段，Docker 也不会为 `host`、`macvlan`、`ipvlan` 网络创建同类防火墙规则，无法被本方案限制。

---

## 第 3 步：创建出站白名单脚本

新建脚本：

```bash
sudo vim /usr/local/sbin/docker-egress-whitelist.sh
```

写入以下内容：

```bash
#!/usr/bin/env bash
set -euo pipefail

# 受限 Docker 网络的容器源网段
DOCKER_RESTRICTED_SUBNET="172.30.0.0/16"

# 允许容器访问的目标网段（按实际情况修改）
ALLOW_CIDRS=(
  "172.30.0.0/16"      # 允许同一 Docker 网络内互访
  "192.168.0.0/24"     # 允许访问局域网
  "10.10.0.0/16"       # 允许访问指定内网
)

CHAIN="DOCKER-RESTRICTED-EGRESS"

# 创建自定义链，已存在则忽略
iptables -N "$CHAIN" 2>/dev/null || true

# 清空旧规则，避免重复
iptables -F "$CHAIN"

# 确保 DOCKER-USER 链跳转到自定义链
iptables -C DOCKER-USER -s "$DOCKER_RESTRICTED_SUBNET" -j "$CHAIN" 2>/dev/null \
  || iptables -I DOCKER-USER 1 -s "$DOCKER_RESTRICTED_SUBNET" -j "$CHAIN"

# 已建立连接放行
iptables -A "$CHAIN" -m conntrack --ctstate RELATED,ESTABLISHED -j RETURN

# 放行白名单目标网段
for cidr in "${ALLOW_CIDRS[@]}"; do
  iptables -A "$CHAIN" -d "$cidr" -j RETURN
done

# 其它目标全部拒绝
iptables -A "$CHAIN" -j REJECT --reject-with icmp-net-prohibited
```

赋权并执行：

```bash
sudo chmod +x /usr/local/sbin/docker-egress-whitelist.sh
sudo /usr/local/sbin/docker-egress-whitelist.sh
```

查看规则：

```bash
sudo iptables -L DOCKER-USER -n -v
sudo iptables -L DOCKER-RESTRICTED-EGRESS -n -v
```

---

## 第 4 步：设置开机自动生效

新建 systemd 服务：

```bash
sudo nano /etc/systemd/system/docker-egress-whitelist.service
```

写入：

```ini
[Unit]
Description=Docker restricted egress whitelist
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/sbin/docker-egress-whitelist.sh
RemainAfterExit=yes

[Install]
WantedBy=multi-user.target
```

启用服务：

```bash
sudo systemctl daemon-reload
sudo systemctl enable docker-egress-whitelist.service
sudo systemctl start docker-egress-whitelist.service
sudo systemctl status docker-egress-whitelist.service
```

---

## 第 5 步：重启 Compose 服务

进入各 compose 目录：

```bash
docker compose down
docker compose up -d
```

检查容器是否加入受限网络：

```bash
docker network inspect docker_restricted
# 或检查单个容器
docker inspect kkfileView --format '{{json .NetworkSettings.Networks}}'
```

---

## 第 6 步：测试

进入容器：

```bash
docker exec -it kkfileView sh
```

**允许访问的网段（应成功）：**

```bash
curl -I http://192.168.0.1
curl -I http://10.10.0.1
```

**公网（应失败）：**

```bash
curl -I https://www.baidu.com
curl -I https://1.1.1.1
curl -I https://8.8.8.8
```

查看防火墙命中计数：

```bash
sudo iptables -L DOCKER-RESTRICTED-EGRESS -n -v
```

---

## 第 7 步：DNS 处理

DNS 解析也属于网络访问。若容器需要解析域名，必须在白名单中允许其访问 DNS 服务器。

例如内网 DNS 为 `192.168.0.1`，在 `ALLOW_CIDRS` 中加入：

```bash
"192.168.0.1/32"
```

并在 compose 中指定 DNS：

```yaml
services:
  app:
    dns:
      - 192.168.0.1
```

不要给容器配置公网 DNS（如 `8.8.8.8`、`1.1.1.1`、`223.5.5.5`），除非你也允许访问这些地址。

---

## 你需要改的地方（速查）

| 位置 | 修改内容 |
|------|----------|
| 每个 compose 文件 | 添加 `networks.default.external.name: docker_restricted` |
| compose 文件 | 不要使用 `network_mode: host` |
| 白名单脚本 `ALLOW_CIDRS` | 换成你真正允许访问的网段 |

---

## 与 daemon.json 的关系

本方案依赖宿主机 `iptables` 和 Docker 的 `DOCKER-USER` 链。若你在 `daemon.json` 中设置了 `"iptables": false`，Docker 可能不会创建 `DOCKER-USER` 链，本方案将无法正常工作。一般建议保持 `"iptables": true`，详见 [daemon.json 配置详解](/posts/docker-daemon-json-guide/)。

---

## 小结

通过「固定网段的自定义 bridge 网络 + `DOCKER-USER` 出站白名单」，可以在不改动应用镜像的前提下，批量限制多个 Compose 项目的容器出网范围。方案可开机自启、规则可审计，适合内网部署与合规场景。
