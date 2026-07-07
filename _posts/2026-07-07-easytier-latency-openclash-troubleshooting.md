---
title: EasyTier 虚拟 IP 延迟异常排查：OpenClash 透明代理的锅
description: ping VPS 公网 IP 很快，但 EasyTier 虚拟 IP 延迟 400ms+？本文记录一次真实排障，根因是 OpenClash 把 EasyTier 底层 TCP/UDP 流量代理到了境外节点，以及如何用 iperf3 定位并修复。
date: 2026-07-07 11:00:00 +0800
categories: [教程, 网络]
tags: [EasyTier, OpenClash, 异地组网, 排障, iperf3, 透明代理]
order: 11
---

在 PVE 上跑 EasyTier 连 VPS 做异地组网时，遇到过这种诡异现象吗？

```bash
ping <VPS_PUBLIC_IP>    # 大约 41ms，很正常
ping 10.77.0.1          # 大约 420ms，慢得离谱
```

公网 IP 延迟正常，虚拟 IP 却高出一个数量级——很容易让人怀疑 EasyTier 隧道、MTU、P2P 选路或 UDP 端口出了问题。本文记录一次完整排查过程：折腾了一圈参数之后，真正的原因其实是 **OpenClash 把 EasyTier 底层流量透明代理出去了**。

> 如果你也读过 [EasyTier 异地组网部署教程](/posts/easytier-vps-ab-client-network/)，文中示例里 `relay` 延迟 400ms+、以及「改用 UDP 降低延迟」那段，后来复盘发现同样是走了代理节点，而非 EasyTier 本身的中继或 TCP 协议问题。修复 OpenClash 直连规则后，延迟会回到正常水平。

## 你将学到什么

- 为什么 `ping` 公网 IP 正常，不代表 EasyTier 隧道正常
- 如何用 `ip route` 和 `easytier-cli peer` 缩小问题范围
- 哪些 EasyTier 参数调整通常无效（避免走弯路）
- 用 **iperf3 在服务端查看真实连接来源 IP** 定位透明代理
- OpenClash 直连规则该怎么写

---

## 一、问题现象

PVE 访问 EasyTier VPS 公网 IP，延迟正常：

```bash
ping <VPS_PUBLIC_IP>
```

结果大约：

```text
time=41ms
```

但访问 EasyTier 虚拟 IP 延迟异常：

```bash
ping 10.77.0.1
```

结果大约：

```text
time=420ms
```

表面看起来是：

```text
公网 IP 延迟正常
EasyTier 虚拟 IP 延迟很高
```

---

## 二、初步判断：两条路径不一样

先查看路由：

```bash
ip route get <VPS_PUBLIC_IP>
ip route get 10.77.0.1
```

结果类似：

```text
<VPS_PUBLIC_IP> via 192.168.55.1 dev vmbr0 src 192.168.55.200
10.77.0.1 dev tun0 src 10.77.0.10
```

说明两种访问走的是完全不同的路径：

```text
访问 VPS 公网 IP：
PVE → vmbr0 → 网关 → 公网 → VPS

访问 EasyTier 虚拟 IP：
PVE → tun0 → EasyTier 隧道 → VPS
```

因此，`ping <VPS_PUBLIC_IP>` 正常，**不代表** EasyTier 隧道一定正常。

---

## 三、查看 EasyTier peer 状态

在 PVE 上查看（多实例场景需指定 `--rpc-portal`）：

```bash
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15889 peer
/opt/easytier/easytier-cli --rpc-portal 127.0.0.1:15889 route
```

在 VPS 服务端查看：

```bash
/opt/easytier/easytier-cli peer
```

异常时服务端看到类似：

```text
10.77.0.2   187zhanghongyang  p2p  40ms   udp
10.77.0.10  pve               p2p  420ms  udp
```

说明：

```text
公司机器 → VPS：正常（约 40ms）
PVE → VPS：异常（约 420ms）
问题集中在 PVE ↔ VPS 这一段 EasyTier 链路
```

---

## 四、已排除的方向

排查过程中尝试过：

```text
调整 --mtu
添加 --latency-first
添加 --disable-p2p
更换 EasyTier UDP 端口
同时启用 TCP / UDP
停掉另一个 EasyTier 实例
```

这些操作都**没有**解决问题，因此基本排除：

```text
MTU 问题
单个 UDP 端口异常
EasyTier 多实例冲突
EasyTier P2P 选路参数问题
```

> 事后复盘：当时看到 400ms+ 延迟、同时 `ping` 公网 IP 只有几十毫秒，很容易联想到「改用 UDP 降低延迟」——但这恰恰是透明代理的典型症状，而不是协议选型问题。

---

## 五、关键一步：用 iperf3 看真实链路

在 VPS 服务端启动 iperf3：

```bash
iperf3 -s -p 55201
```

在 PVE 上测试：

```bash
iperf3 -c <VPS_PUBLIC_IP> -p 55201 -t 10
```

异常时，VPS 服务端看到连接来源是：

```text
Accepted connection from <PROXY_NODE_PUBLIC_IP>
iperf3: error - idle timeout for receiving data
```

其中 `<PROXY_NODE_PUBLIC_IP>` 是 **OpenClash 当前使用的代理节点 IP**，而不是家宽公网 IP。

这说明：

```text
PVE 到 VPS 的 TCP/UDP 流量被 OpenClash 透明代理出去了
```

这一步是整次排查的转折点。如果只看 `easytier-cli peer` 里的延迟数字，很容易误判为中继或协议问题；**在服务端看连接来源 IP** 才能确认流量实际走了哪条路。

---

## 六、为什么 ping 公网 IP 正常，虚拟 IP 却很慢

原因在于两种流量被不同方式处理：

| 流量类型 | 示例 | 是否被 Clash 代理 |
|---|---|---|
| ICMP | `ping <VPS_PUBLIC_IP>` | 通常**不**代理 → 直连，延迟正常 |
| TCP/UDP | EasyTier 连 `<VPS_PUBLIC_IP>:端口` | 被 TUN / 透明代理接管 → 走代理节点 |

EasyTier 底层使用的是：

```text
UDP/TCP → <VPS_PUBLIC_IP>:端口
```

实际异常路径变成：

```text
PVE → OpenClash → 代理节点 → VPS
```

而不是：

```text
PVE → 家宽公网 → VPS
```

因此就出现了：

```text
公网 IP ping 很快（ICMP 直连）
EasyTier 虚拟 IP 延迟 400ms+（UDP/TCP 隧道走了代理）
```

---

## 七、解决方法：OpenClash 添加直连规则

在 OpenClash 规则中添加 EasyTier VPS 公网 IP 和虚拟网段直连：

```yaml
# ========================
# EasyTier / VPS / 虚拟局域网优先直连
# ========================
- "IP-CIDR,<VPS_PUBLIC_IP>/32,DIRECT,no-resolve" # EasyTier VPS 公网 IP
- "IP-CIDR,10.77.0.0/24,DIRECT,no-resolve"      # EasyTier 虚拟局域网
- "IP-CIDR,10.66.0.0/24,DIRECT,no-resolve"      # 另一个 EasyTier 虚拟局域网，可选
```

其中**最关键**的是：

```yaml
- "IP-CIDR,<VPS_PUBLIC_IP>/32,DIRECT,no-resolve"
```

因为 EasyTier 底层连接的是 VPS 的**公网 IP**，而不是直接连接 `10.77.0.1`。只加虚拟网段 `10.77.0.0/24` 而不加 VPS 公网 IP，隧道流量仍可能被代理。

---

## 八、重新加载 OpenClash 并重启 EasyTier

OpenClash 规则更新后，重新加载配置。

然后在 PVE 上重启 EasyTier：

```bash
systemctl restart easytier-tw-client.service
```

如需，也可在 VPS 服务端重启：

```bash
rc-service easytier-server restart
```

---

## 九、验证修复

### 1. iperf3 来源 IP

重新测试：

```bash
iperf3 -c <VPS_PUBLIC_IP> -p 55201 -t 10
```

修复后，VPS 服务端看到来源变成：

```text
Accepted connection from <HOME_PUBLIC_IP>
```

不再是 OpenClash 代理节点 IP。同时 iperf3 吞吐恢复正常，例如：

```text
0.00-10.04 sec  83.6 MBytes  69.9 Mbits/sec
```

说明 PVE 到 VPS 的真实 TCP 流量已经直连。

### 2. EasyTier 延迟

在 VPS 服务端查看：

```bash
/opt/easytier/easytier-cli peer
```

修复后结果类似：

```text
10.77.0.2   187zhanghongyang  p2p  42ms  udp
10.77.0.10  pve               p2p  42ms  udp
```

PVE 到 VPS 的 EasyTier 隧道延迟已恢复正常。

---

## 十、最终结论

本次问题的根因**不是**：

```text
LXC NAT
EasyTier MTU
EasyTier 端口
PVE 路由表
VPS 服务端性能
```

真正原因是：

```text
OpenClash 把 PVE 到 EasyTier VPS 公网 IP 的 TCP/UDP 流量代理到了代理节点
```

表现就是：

```text
ping VPS 公网 IP 很快（ICMP 直连）
EasyTier 虚拟 IP 很慢（UDP/TCP 隧道走了代理）
```

本次排查的关键步骤：

```text
使用 iperf3 在 VPS 服务端查看真实连接来源 IP
```

如果服务端看到的来源 IP 不是家宽公网 IP，而是代理节点 IP，就说明流量被 OpenClash 或其他透明代理接管了——这比盲目调 MTU、换协议、关 P2P 有效得多。

---

## 十一、后续建议

建议将以下地址长期加入 OpenClash 直连规则：

```yaml
- "IP-CIDR,<VPS_PUBLIC_IP>/32,DIRECT,no-resolve"
- "IP-CIDR,10.77.0.0/24,DIRECT,no-resolve"
- "IP-CIDR,10.66.0.0/24,DIRECT,no-resolve"
```

尤其要确保 **VPS 公网 IP 直连**，否则 EasyTier 底层隧道仍可能被代理，虚拟局域网延迟会持续异常。

若 PVE 上还跑着 Clash Meta、sing-box 等同类透明代理，排查思路相同：先在目标服务端确认 TCP/UDP 连接的真实来源 IP，再补直连规则。

---

## 相关阅读

- [EasyTier 异地组网：VPS 服务端 + A/B 客户端互通部署](/posts/easytier-vps-ab-client-network/) — 组网部署主教程（文中部分高延迟案例已复盘为 OpenClash 代理所致）
