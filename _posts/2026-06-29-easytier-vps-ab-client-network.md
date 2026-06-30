---
title: EasyTier 异地组网：VPS 服务端 + A/B 客户端互通部署
description: 使用 EasyTier 搭建 VPS 中继节点，让两台 NAT 后的设备互通，并通过 proxy-networks 发布 B 设备后方内网，实现远程访问家庭/机房服务。
date: 2026-06-29 10:00:00 +0800
categories: [教程, 网络]
tags: [EasyTier, 异地组网, VPS, P2P, UDP, 内网穿透, systemd]
order: 10
---

家里有一台 PVE 跑着 Portainer、Jellyfin 等服务，出门在外想用笔记本直接访问？两台设备都在 NAT 后面、没有公网 IP 时，可以用 **EasyTier** 搭一层虚拟专网：一台 VPS 做公网入口与中继，A、B 两台客户端加入同一网络后，既能互访虚拟 IP，也能通过 B 设备把后方内网整段「带」进组网。

## 你将完成什么

- VPS 作为固定入口、节点发现与中继节点
- A 设备（如 MacBook）与 B 设备（如 PVE）通过 EasyTier 虚拟 IP 互通
- B 设备发布 `192.168.55.0/24` 内网，让 A 设备和 VPS 直接访问 B 后方的服务
- 理解 P2P 与中继模式的差异，以及常见排障手段
- 在 TCP 中继偏慢时改用 UDP 协议优化体验
- PVE 同时连接多台 VPS，在 PVE 上用 `--rpc-portal` 分别管理各实例

## 示例架构

```text
VPS：38.A.B.C
EasyTier IP：10.66.0.1
监听端口：11010

A 设备：MacBook
EasyTier IP：10.66.0.2

B 设备：PVE
EasyTier IP：10.66.0.10
B 后方内网：192.168.55.0/24
```

最终效果：

```text
A 设备可以访问：
- 10.66.0.10
- 192.168.55.1
- 192.168.55.104:9000   （Portainer）
- 192.168.55.120:8096   （Jellyfin）
- 192.168.55.200:8006   （PVE Web UI）

B 设备可以访问：
- 10.66.0.2

VPS 可以访问：
- 10.66.0.2
- 10.66.0.10
- 192.168.55.0/24 内网设备
```

---

## VPS 在 EasyTier 中的三个作用

### 固定入口

A、B 两台设备可能都在 NAT 后面，没有公网 IP，需要先连上一个公网节点：

```text
A 设备 → VPS
B 设备 → VPS
```

VPS 有固定公网 IP，适合作为所有节点的入口。

### 节点发现

A 和 B 都连接 VPS 后，VPS 会帮助它们互相发现对方。例如 VPS 知道 A 的 EasyTier IP 是 `10.66.0.2`，B 的是 `10.66.0.10`。如果 P2P 能成功，A 和 B 后续可以尝试直接互联。

### 中继兜底

如果 A 和 B 因 NAT、运营商或防火墙无法 P2P，流量会经 VPS 转发：

```text
A 设备 → VPS → B 设备
```

此时延迟大约等于 `A ↔ VPS 延迟 + VPS ↔ B 延迟`。

---

## 网络规划

| 节点 | 角色 | EasyTier IP | 说明 |
|---|---|---:|---|
| VPS | 服务端 / 中继 / 节点发现 | 10.66.0.1 | 公网 IP：38.A.B.C |
| A 设备 | 客户端 | 10.66.0.2 | 例如 MacBook、Windows、Linux |
| B 设备 | 客户端 / 内网网关 | 10.66.0.10 | 例如 PVE |
| B 后方内网 | 被访问网段 | 192.168.55.0/24 | 由 B 设备发布 |

### 生成网络名与密钥

不要使用默认值，也不要外泄。可用以下命令随机生成：

```bash
ET_NAME="mylan-$(openssl rand -hex 4)"
ET_SECRET="$(openssl rand -hex 32)"

cat > /root/easytier-join-info.txt <<EOF
ET_NAME=${ET_NAME}
ET_SECRET=${ET_SECRET}
VPS EasyTier IP:
10.66.0.1
VPS EasyTier listener:
tcp://0.0.0.0:11010
EOF
cat /root/easytier-join-info.txt
```

后续所有节点的 `--network-name` 和 `--network-secret` 必须与这里一致。

---

## VPS 服务端部署

### 1. 准备目录与二进制

```bash
mkdir -p /opt/easytier
cd /opt/easytier
```

将 `easytier-core` 和 `easytier-cli` 放入该目录，并赋予执行权限：

```bash
chmod +x /opt/easytier/easytier-core /opt/easytier/easytier-cli
/opt/easytier/easytier-core --version
```

> 二进制可从 [EasyTier 官方仓库](https://github.com/EasyTier/EasyTier) 的 Release 页面下载，选择与系统架构匹配的版本。

### 2. 启动命令

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.1 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --listeners tcp://0.0.0.0:11010 \
  --private-mode true \
  --relay-network-whitelist "你的ET_NAME" \
  --mtu 1280 \
  --console-log-level info
```

| 参数 | 说明 |
|---|---|
| `--ipv4 10.66.0.1` | VPS 在 EasyTier 网络中的虚拟 IP |
| `--listeners tcp://0.0.0.0:11010` | VPS 对外监听 TCP 11010 |
| `--private-mode true` | 开启私有网络模式 |
| `--relay-network-whitelist` | 只允许指定网络使用该 VPS 中继 |
| `--mtu 1280` | 降低 MTU，减少跨网络环境下的分片问题 |

### 3. 防火墙放行

直连模式下需放行 TCP 11010：

```bash
iptables -I INPUT -p tcp --dport 11010 -j ACCEPT
```

云厂商安全组中同样需要放行 `TCP 11010`。

### 4. systemd 服务

```bash
cat > /etc/systemd/system/easytier-server.service <<'EOF'
[Unit]
Description=EasyTier Server Relay
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/easytier
ExecStart=/opt/easytier/easytier-core \
  --ipv4 10.66.0.1 \
  --network-name 你的ET_NAME \
  --network-secret 你的ET_SECRET \
  --listeners tcp://0.0.0.0:11010 \
  --private-mode true \
  --relay-network-whitelist 你的ET_NAME \
  --mtu 1280 \
  --console-log-level info
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
```

启动并设置开机自启：

```bash
systemctl daemon-reload
systemctl enable --now easytier-server
systemctl status easytier-server --no-pager
```

查看日志：

```bash
journalctl -u easytier-server -f
```

---

## A 设备客户端部署

A 设备可以是 Mac、Windows、Linux 等普通远程客户端。

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.2 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --peers tcp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --mtu 1280 \
  --console-log-level info
```

| 参数 | 说明 |
|---|---|
| `--ipv4 10.66.0.2` | A 设备的 EasyTier 虚拟 IP |
| `--peers tcp://38.A.B.C:11010` | 连接 VPS 节点 |
| `--no-listener` | 客户端不监听端口，只主动连接 VPS |
| `--private-mode true` | 必须和 VPS 保持一致 |

---

## B 设备客户端部署

B 设备以 PVE 为例，承担两个角色：

1. 自己作为 EasyTier 节点，IP 为 `10.66.0.10`
2. 发布本地内网 `192.168.55.0/24`，让 A 设备和 VPS 可以访问该内网

### 启动命令

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.10 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --peers tcp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --proxy-networks 192.168.55.0/24 \
  --mtu 1280 \
  --console-log-level info
```

关键参数 `--proxy-networks 192.168.55.0/24` 表示 B 设备将自己的内网网段发布到 EasyTier 网络中。配置后，A 设备即可访问 `192.168.55.104:9000` 等内网服务。

### systemd 服务

```bash
cat > /etc/systemd/system/easytier-client.service <<'EOF'
[Unit]
Description=EasyTier Client Gateway
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=/opt/easytier
ExecStart=/opt/easytier/easytier-core \
  --ipv4 10.66.0.10 \
  --network-name 你的ET_NAME \
  --network-secret 你的ET_SECRET \
  --peers tcp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --proxy-networks 192.168.55.0/24 \
  --mtu 1280 \
  --console-log-level info
Restart=always
RestartSec=3
LimitNOFILE=1048576

[Install]
WantedBy=multi-user.target
EOF
```

```bash
systemctl daemon-reload
systemctl enable --now easytier-client
systemctl status easytier-client --no-pager
```

---

## 节点互通验证

### 查看节点列表

在 VPS、A、B 任意节点上执行：

```bash
/opt/easytier/easytier-cli peer
```

示例输出：

```text
| ipv4          | hostname               | cost     | lat(ms) | tunnel |
|---------------|------------------------|----------|---------|--------|
| 10.66.0.1/24  | vps                    | Local    | -       | -      |
| 10.66.0.2/24  | macbook                | relay(2) | 405.00  |        |
| 10.66.0.10/24 | pve                    | p2p      | 176.00  | tcp    |
```

| 字段 | 说明 |
|---|---|
| `Local` | 当前本机节点 |
| `p2p` | 与对方是点对点连接 |
| `relay(n)` | 通过中继转发 |
| `tunnel tcp` | 当前承载协议是 TCP |

### 查看路由

在 VPS 或 A 设备上执行：

```bash
/opt/easytier/easytier-cli route
```

如果 B 设备发布内网成功，应能看到类似：

```text
192.168.55.0/24 via 10.66.0.10
```

### 连通性测试

在 A 设备上：

```bash
ping 10.66.0.1
ping 10.66.0.10
ping 192.168.55.1
ping 192.168.55.104
curl http://192.168.55.104:9000/
```

在 B 设备上：

```bash
ping 10.66.0.1
ping 10.66.0.2
```

若能返回 Portainer 页面，说明 B 设备发布内网成功。

---

## P2P 与 VPS 中继

EasyTier 默认会尝试 P2P。

### P2P 成功时

路径为 `A 设备 ↔ B 设备 ↔ B 后方内网`，延迟更低、速度更快，也减少 VPS 流量。

### P2P 失败时

路径为 `A 设备 ↔ VPS ↔ B 设备 ↔ B 后方内网`。例如：

```text
B ↔ VPS：175 ms
VPS ↔ A：236 ms
A ↔ B relay 延迟约：405 ms
```

这就是 relay 模式下延迟偏高的原因。

### 如何确认连接模式

在 B 设备上执行 `easytier-cli peer`，若 A 设备那一行 `cost = p2p` 说明已建立点对点；若为 `cost = relay(2)` 则走 VPS 中继。

### 强制关闭 P2P

若希望所有流量固定走 VPS，可在 A、B 客户端启动参数中加入：

```bash
--disable-p2p \
--disable-tcp-hole-punching \
--disable-udp-hole-punching \
--stun-servers ""
```

---

## 改用 UDP 降低延迟

如果 `easytier-cli peer` 里显示 TCP 中继延迟很高（例如 400 ms 以上），但本机 `ping` VPS 公网 IP 的 ICMP 延迟其实没那么夸张，可以改用 **UDP** 作为 EasyTier 的传输协议。UDP 在跨运营商、高丢包或 TCP 拥塞控制过于保守的场景下，往往能获得更低的感知延迟。

> 同一网络内的所有节点必须使用相同协议。服务端从 TCP 切到 UDP 后，所有客户端的 `--peers` 也要同步改为 `udp://...`。

### VPS 服务端

将 `--listeners` 从 TCP 改为 UDP：

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.1 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --listeners udp://0.0.0.0:11010 \
  --private-mode true \
  --relay-network-whitelist "你的ET_NAME" \
  --mtu 1280 \
  --console-log-level info
```

防火墙同步放行 UDP 11010：

```bash
iptables -I INPUT -p udp --dport 11010 -j ACCEPT
```

云厂商安全组中放行 `UDP 11010`。

### 客户端

`--peers` 改为 UDP 地址：

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.2 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --peers udp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --mtu 1280 \
  --console-log-level info
```

切换后重新执行 `easytier-cli peer`，`tunnel` 列应显示 `udp`，`lat(ms)` 通常会有明显下降。

---

## PVE 同时连接多台 VPS

有时需要在**同一台 PVE** 上同时接入多个 EasyTier 网络——例如 PVE 既连 VPS1 给家里人用，又连 VPS2 给另一拨远程客户端用，或一条 TCP、一条 UDP 做备用入口。做法是在 PVE 上运行**多个 `easytier-core` 进程**，每个进程 `--peers` 指向不同的 VPS，各自加入独立的 EasyTier 网络。

`--rpc-portal` 是 **PVE 本机管理端口**，与 VPS 无关。每个实例绑定不同的 RPC 地址后，在 PVE 上就能用 `easytier-cli --rpc-portal` 分别查看各实例的节点和路由，互不干扰。

```text
                    ┌─ VPS1（38.A.B.C:11010）─ 网络 mylan-home
PVE 实例 1 ─────────┤   虚拟 IP：10.66.0.10
(rpc-portal :15888) └─ 发布 192.168.55.0/24

                    ┌─ VPS2（38.B.B.B:51010）─ 网络 mylan
PVE 实例 2 ─────────┤   虚拟 IP：10.77.0.10
(rpc-portal :15889) └─ 发布 192.168.55.0/24
```

关键点：

- 每个进程使用不同的 `--ipv4` 和 `--network-name` / `--network-secret`
- 每个进程 `--peers` 指向各自的 VPS
- 每个进程在 PVE 上指定独立的 `--rpc-portal`（如 `15888`、`15889`）
- 多实例时建议加 `--bind-device true`

### 示例：PVE 上的两个实例

**实例 1**——PVE 连接 VPS1（TCP，对应前文 B 设备主网络）：

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.10 \
  --network-name "mylan-home" \
  --network-secret "密钥1" \
  --peers tcp://38.A.B.C:11010 \
  --bind-device true \
  --no-listener \
  --private-mode true \
  --proxy-networks 192.168.55.0/24 \
  --mtu 1280 \
  --rpc-portal 127.0.0.1:15888 \
  --console-log-level info
```

**实例 2**——PVE 连接 VPS2（UDP，独立网络）：

```bash
/opt/easytier/easytier-core \
  --ipv4 10.77.0.10 \
  --network-name "mylan" \
  --network-secret "密钥2" \
  --peers udp://38.B.B.B:51010 \
  --bind-device true \
  --no-listener \
  --private-mode true \
  --proxy-networks 192.168.55.0/24 \
  --mtu 1280 \
  --rpc-portal 127.0.0.1:15889 \
  --console-log-level info
```

| 参数 | 说明 |
|---|---|
| `--rpc-portal` | 在 PVE 本机为每个实例绑定独立管理端口 |
| `--bind-device true` | 多实例时绑定独立 TUN 设备，避免网卡冲突 |
| `--proxy-networks` | 两个实例可各自向对应 VPS 所在网络发布同一内网段 |

远程 A 设备只需 `--peers` 连其中一台 VPS，即可经对应网络访问 PVE 后方的 `192.168.55.0/24`。两套网络相互独立，密钥、虚拟 IP 段、VPS 地址均可不同。

### 在 PVE 上分别查看各实例

```bash
# 查看连 VPS1 的实例
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15888 peer
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15888 route

# 查看连 VPS2 的实例
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15889 peer
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15889 route
```

不设 `--rpc-portal` 时，`easytier-cli` 默认连 PVE 上第一个实例；多实例场景下务必通过 `--rpc-portal` 指定要查哪一个。

> 若远程客户端（如 MacBook）**同时**加入这两个网络，且两边都发布了相同的 `192.168.55.0/24`，客户端侧可能发生路由冲突。通常远程端只连其中一台 VPS 即可；PVE 侧双实例并存没有问题。

---

## 是否需要 NAT 或静态路由

如果 B 设备直接运行 EasyTier 且 `--proxy-networks 192.168.55.0/24` 已生效，通常**不需要**额外 NAT。实际验证中，VPS 已能直接访问 `192.168.55.104:9000`，说明 EasyTier 已完成内网段代理。

仅在以下情况才考虑在 B 设备上做 NAT：

```text
A 能 ping 通 B 的 10.66.0.10
但是访问不了 192.168.55.x
内网设备不知道如何回包到 10.66.0.0/24
不方便在网关上添加静态回程路由
```

NAT 示例：

```bash
sysctl -w net.ipv4.ip_forward=1

iptables -t nat -A POSTROUTING \
  -s 10.66.0.0/24 \
  -d 192.168.55.0/24 \
  -j MASQUERADE
```

如果现在已经能直接访问内网，就不要额外加 NAT，避免规则复杂化。

---

## 隐藏 11010 端口的可选方案

如果不希望 VPS 的 EasyTier 11010 端口直接暴露到公网，可以用 V2Ray/Xray/Clash Tunnel 包装。

**VPS 侧**：EasyTier 只监听本机：

```bash
--listeners tcp://127.0.0.1:11010
```

**客户端侧**：不直接连 VPS 公网地址，而是连本地 tunnel：

```bash
--peers tcp://127.0.0.1:31010
```

本地 tunnel 将 `127.0.0.1:31010` 转发到 VPS 内部的 `127.0.0.1:11010`。这样公网只看到 V2Ray/Xray 的入口端口，看不到 EasyTier 的 `11010`。

---

## 常用排障命令

```bash
# 查看节点
/opt/easytier/easytier-cli peer

# 查看路由
/opt/easytier/easytier-cli route

# 查看监听端口
ss -lntp | grep 11010

# 测试端口连通
telnet 38.A.B.C 11010

# 查看 systemd 日志
journalctl -u easytier-server -f
journalctl -u easytier-client -f
journalctl -u easytier-client -n 100 --no-pager
```

---

## 最终推荐配置速查

### VPS

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.1 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --listeners tcp://0.0.0.0:11010 \
  --private-mode true \
  --relay-network-whitelist "你的ET_NAME" \
  --mtu 1280 \
  --console-log-level info
```

### A 设备

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.2 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --peers tcp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --mtu 1280 \
  --console-log-level info
```

### B 设备

```bash
/opt/easytier/easytier-core \
  --ipv4 10.66.0.10 \
  --network-name "你的ET_NAME" \
  --network-secret "你的ET_SECRET" \
  --peers tcp://38.A.B.C:11010 \
  --no-listener \
  --private-mode true \
  --proxy-networks 192.168.55.0/24 \
  --mtu 1280 \
  --console-log-level info
```

---

## 注意事项

1. **网段冲突**：A 设备本地网络不要和 B 后方内网重叠。例如 B 后方是 `192.168.55.0/24`，而 A 本地也在同一网段时会发生路由冲突。
2. **密钥一致**：所有节点的 `network-name` 和 `network-secret` 必须相同。
3. **私有模式**：建议所有节点都开启 `--private-mode true`。
4. **公网暴露**：若直接暴露 `11010`，至少配置 `--private-mode true` 和 `--relay-network-whitelist`。
5. **隐藏端口**：若不想暴露 `11010`，让 VPS EasyTier 监听 `127.0.0.1:11010`，再通过 V2Ray/Xray tunnel 转发。
6. **连接模式**：`peer` 中 `relay(2)` 表示走 VPS 中继，`p2p` 表示点对点连接。
7. **协议一致**：TCP 与 UDP 不能混用；切换协议后服务端、客户端和防火墙规则需同步修改。
8. **PVE 多实例**：PVE 连多台 VPS 时，每个 `easytier-core` 进程的 `--ipv4` 和 `--rpc-portal` 必须唯一；`rpc-portal` 仅用于 PVE 本机管理，远程客户端无需配置。
