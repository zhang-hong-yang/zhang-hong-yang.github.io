---
title: Linux TCP 性能调优详解：半连接队列、滑动窗口、BDP、CUBIC/BBR 与内核参数
description: 从 Linux 服务端实战角度系统讲解 TCP 性能调优：SYN 半连接队列、Accept Queue、somaxconn、tcp_max_syn_backlog、滑动窗口、rwnd/cwnd、BDP、Socket Buffer、CUBIC/BBR、TIME_WAIT、临时端口、conntrack，以及如何先观测再调参。
date: 2026-08-18 14:39:00 +0800
categories: [教程, 网络]
tags: [Linux, TCP, 性能调优, BBR, CUBIC, BDP, sysctl, 高并发, 网络]
order: 14
---

上一篇介绍了 TCP 的基础原理：

```text
SYN / ACK / PSH / FIN / RST
Seq / Ack
三次握手
四次挥手
重传
Window
MSS / MTU
```

但真正到了服务器性能问题，还会遇到另外一批问题：

```text
为什么大量并发连接时 SYN_RECV 暴涨？

tcp_max_syn_backlog 和 somaxconn 有什么区别？

为什么三次握手已经完成，客户端仍然连不上？

滑动窗口是不是越大越好？

tcp_rmem / tcp_wmem 到底控制什么？

1Gbps 的线路为什么只能跑几十 Mbps？

rwnd 和 cwnd 为什么不是一个东西？

CUBIC 和 BBR 应该怎么选？

TIME_WAIT 很多是不是就应该马上优化？

高并发时为什么还会遇到临时端口耗尽？

NAT / Docker 主机为什么还要关注 conntrack？
```

这些已经不只是“TCP 协议原理”，而是：

```text
Linux TCP 性能调优
```

本文从实际服务器排障角度，把这些参数和背后的原理串起来。

> 这篇文章最重要的原则只有一句：**先找到瓶颈，再改参数。**
>
> 不要从网上复制一份所谓“百万并发 sysctl.conf”直接套到生产服务器。

---

## 你将学到什么

- SYN 半连接队列到底是什么
- Accept Queue 和半连接队列有什么区别
- `tcp_max_syn_backlog` 与 `somaxconn` 分别控制什么
- `listen(backlog)` 为什么还受应用程序影响
- `tcp_syncookies` 为什么是兜底，不是性能加速器
- TCP 滑动窗口如何影响吞吐
- `rwnd` 与 `cwnd` 的区别
- BDP 为什么是高带宽高延迟链路的核心指标
- `tcp_rmem` / `tcp_wmem` / `rmem_max` / `wmem_max` 如何理解
- CUBIC 与 BBR 分别解决什么问题
- 如何查看单连接的 RTT、cwnd、pacing rate 和 delivery rate
- TIME_WAIT 为什么不能看到多就乱改
- `tcp_tw_reuse` 为什么需要谨慎
- 临时端口范围如何限制客户端并发连接
- Docker / NAT / 防火墙为什么还可能受 conntrack 限制
- 如何用 `ss`、`nstat`、`iperf3` 判断真正的 TCP 瓶颈
- 如何针对 Web 服务、高并发 API、跨国传输和隧道服务分别调优

---

# 一、TCP 性能问题先分成几类

不要看到：

```text
TCP 慢
```

就直接修改：

```text
tcp_rmem
tcp_wmem
somaxconn
BBR
```

因为 TCP 性能问题至少可以分成：

```text
TCP 性能
│
├─ 连接建立能力
│   ├─ SYN 半连接队列
│   ├─ Accept Queue
│   └─ 应用 accept() 能力
│
├─ 单连接吞吐能力
│   ├─ RTT
│   ├─ BDP
│   ├─ rwnd
│   ├─ cwnd
│   └─ Socket Buffer
│
├─ 丢包 / 拥塞
│   ├─ CUBIC
│   ├─ BBR
│   ├─ SACK
│   └─ 重传
│
├─ 主机收包能力
│   ├─ 网卡
│   ├─ IRQ
│   ├─ NAPI
│   └─ netdev backlog
│
├─ 系统资源
│   ├─ 文件描述符
│   ├─ 内存
│   ├─ CPU
│   └─ 临时端口
│
└─ 中间设备
    ├─ NAT
    ├─ conntrack
    ├─ 防火墙
    ├─ TCP Proxy
    └─ 负载均衡
```

因此正确流程应该是：

```text
先判断是哪一层
      ↓
观察指标
      ↓
确认瓶颈
      ↓
只修改相关参数
      ↓
压测验证
```

---

# 二、TCP 服务端实际上有两类连接队列

很多文章会笼统地说：

```text
TCP backlog
```

但 Linux 服务端真正需要区分：

```text
1. SYN 半连接队列
2. Accept Queue
```

流程：

```text
客户端
   |
   | SYN
   v

服务端 SYN 半连接队列
SYN_RECV
   |
   | SYN + ACK
   v

客户端
   |
   | ACK
   v

三次握手完成
   |
   v

Accept Queue
   |
   | accept()
   v

应用程序真正拿到 socket
```

所以：

```text
收到 SYN
```

和：

```text
应用 accept 到连接
```

中间其实还隔着多个阶段。

---

# 三、什么是 SYN 半连接

客户端：

```text
Client
   |
   | SYN
   v
Server
```

服务器收到 SYN 后会创建连接请求状态。

此时三次握手还没有完成：

```text
Client                   Server

SYN -------------------->

    <---------------- SYN + ACK

ACK 还没回来
```

服务器侧一般处于：

```text
SYN_RECV
```

这类连接通常称为：

```text
半连接
```

因为：

```text
三次握手还没完全完成
```

---

# 四、tcp_max_syn_backlog 控制什么

Linux 参数：

```bash
sysctl net.ipv4.tcp_max_syn_backlog
```

它主要控制：

```text
每个监听 socket
可以记住多少个尚未完成三次握手的连接请求
```

也就是：

```text
SYN_RECV
```

这一阶段。

查看：

```bash
sysctl net.ipv4.tcp_max_syn_backlog
```

例如：

```text
net.ipv4.tcp_max_syn_backlog = 4096
```

可以粗略理解：

```text
某个 listener 最多允许积压约 4096 个
尚未完成握手的连接请求
```

实际行为还会受到：

```text
内核版本
内存
syncookies
hash table
连接状态
```

等因素影响。

---

# 五、什么时候 tcp_max_syn_backlog 可能成为瓶颈

例如服务端短时间出现：

```text
每秒几万次新连接
```

大量客户端同时：

```text
SYN
 ↓
SYN+ACK
```

但 ACK 返回需要一定时间。

服务器就会累积很多：

```text
SYN_RECV
```

如果半连接队列容量不够，就可能出现：

```text
新 SYN 无法正常排队
握手超时
重传 SYN
连接建立失败
```

此时才应该考虑：

```text
tcp_max_syn_backlog
```

---

# 六、怎么查看 SYN_RECV

最简单：

```bash
ss -ant state syn-recv
```

统计数量：

```bash
ss -ant state syn-recv | wc -l
```

查看指定端口，例如 443：

```bash
ss -ant state syn-recv | grep ':443'
```

持续观察：

```bash
watch -n 1 "ss -ant state syn-recv | wc -l"
```

如果：

```text
平时几十
突发几百
```

未必有问题。

如果长期：

```text
几千
几万
```

就应该继续分析：

```text
真实业务突发？
客户端 RTT 太高？
服务端过载？
SYN Flood？
网络丢包？
```

---

# 七、半连接队列不是越大越好

把：

```text
tcp_max_syn_backlog
```

从：

```text
4096
```

直接改成：

```text
1000000
```

不等于性能就会变好。

因为真正的问题可能是：

```text
应用 accept 太慢
CPU 满
服务线程阻塞
SYN Flood
后端数据库卡死
防火墙连接跟踪满
```

如果瓶颈不是 SYN 队列：

```text
调大 tcp_max_syn_backlog 没有意义
```

---

# 八、三次握手完成后还有 Accept Queue

假设：

```text
Client                   Server

SYN -------------------->
    <---------------- SYN+ACK
ACK -------------------->
```

现在 TCP 三次握手完成。

但服务端应用程序还没有：

```c
accept()
```

这个连接就要先排队等待。

这就是：

```text
Accept Queue
```

或者常见叫法：

```text
全连接队列
```

流程：

```text
三次握手完成
      ↓
Accept Queue
      ↓
应用 accept()
      ↓
进入业务处理
```

---

# 九、somaxconn 控制什么

查看：

```bash
sysctl net.core.somaxconn
```

现代 Linux 官方文档中的默认值通常是：

```text
4096
```

它是：

```text
socket listen backlog 的内核上限
```

也就是说应用代码：

```c
listen(fd, backlog);
```

传入的 backlog 不能无限大。

可以简单理解：

```text
应用 listen(backlog)
        +
内核 somaxconn
        ↓
最终有效 Accept Queue 上限
```

---

# 十、应用 listen(backlog) 同样重要

假设：

```text
net.core.somaxconn = 8192
```

但应用只调用：

```c
listen(fd, 128);
```

那么你不能简单认为：

```text
服务器 Accept Queue = 8192
```

因为应用本身只申请：

```text
128
```

反过来：

```text
listen(fd, 65535)
```

但：

```text
somaxconn = 4096
```

内核仍然会限制。

因此调优时必须同时看：

```text
内核
+
应用
```

而不是只改 sysctl。

---

# 十一、Nginx、Java、Python 等应用也有自己的 backlog

例如不同服务器框架可能有：

```text
listen backlog
worker 数量
accept 策略
event loop
线程池
连接数限制
```

所以：

```text
somaxconn 很大
```

但：

```text
应用 accept 很慢
```

依然会出问题。

真正完整的连接链路是：

```text
网卡
 ↓
Linux TCP
 ↓
SYN Queue
 ↓
Accept Queue
 ↓
应用 accept()
 ↓
worker / event loop
 ↓
业务逻辑
```

任何一层都可能成为瓶颈。

---

# 十二、如何看监听队列

查看监听 socket：

```bash
ss -lntp
```

例如：

```text
State  Recv-Q Send-Q Local Address:Port
LISTEN 0      4096   0.0.0.0:443
```

对于监听 socket，现代 Linux 上可以重点关注：

```text
Recv-Q
```

当前等待应用 accept 的连接数量。

以及：

```text
Send-Q
```

监听 backlog 上限。

如果长期出现：

```text
Recv-Q 接近 Send-Q
```

就要重点怀疑：

```text
应用 accept 不够快
Accept Queue 接近满
```

---

# 十三、ListenOverflows 和 ListenDrops

仅看某一秒的 `ss` 可能看不到突发问题。

更有价值的是 TCP 统计计数器。

可以：

```bash
nstat -az | grep -E \
'ListenOverflows|ListenDrops|Syncookies|TCPReqQFull'
```

重点关注：

```text
TcpExtListenOverflows
TcpExtListenDrops
```

如果这些数字持续增加：

```text
Accept Queue / listen queue
```

很可能发生过压力或溢出。

判断时最好做：

```text
压测前记录
压测后记录
```

看增量，而不是只看绝对值。

---

# 十四、tcp_syncookies 是什么

查看：

```bash
sysctl net.ipv4.tcp_syncookies
```

SYN Cookie 的用途主要是：

```text
当 SYN 队列面临压力时
减少保存半连接状态的需求
```

正常流程：

```text
收到 SYN
 ↓
服务器保存部分连接状态
 ↓
回复 SYN+ACK
```

Syncookie 思路则是把部分状态编码到：

```text
SYN+ACK 的序列号
```

中。

客户端最终 ACK 回来后：

```text
服务器可以验证 Cookie
并恢复连接信息
```

---

# 十五、syncookies 不是性能优化开关

这一点非常重要。

不要理解成：

```text
打开 syncookies
=
服务器高并发能力提升
```

Linux 官方文档明确把它定位为：

```text
fallback facility
```

也就是：

```text
压力情况下的兜底机制
```

如果大量合法连接都频繁触发 Syncookies，更正确的做法是检查：

```text
tcp_max_syn_backlog
CPU
应用性能
连接建立速率
网络质量
```

而不是依赖 Cookie 长期扛正常业务流量。

---

# 十六、tcp_abort_on_overflow 不要乱开

查看：

```bash
sysctl net.ipv4.tcp_abort_on_overflow
```

默认通常为：

```text
0
```

如果打开：

```text
1
```

当监听服务无法及时 accept 新连接时，Linux 可以更激进地：

```text
RST 客户端
```

看起来好像：

```text
快速失败
```

但可能直接伤害客户端体验。

除非你非常确定：

```text
应用就是应该快速拒绝
```

否则不要把它当成普通性能优化项。

---

# 十七、连接队列参数先这样理解

| 参数 | 主要作用 | 对应阶段 |
|---|---|---|
| `tcp_max_syn_backlog` | 尚未完成三次握手的连接请求上限 | SYN_RECV |
| `somaxconn` | `listen()` backlog 的内核上限 | Accept Queue |
| 应用 `listen(backlog)` | 应用请求的监听 backlog | Accept Queue |
| `tcp_syncookies` | SYN 队列压力时的兜底机制 | 三次握手 |
| `tcp_abort_on_overflow` | listener 过载时是否主动 reset | Accept 压力 |

最容易记的方法：

```text
SYN 还没握完
→ tcp_max_syn_backlog

握手完成，等 accept
→ somaxconn + listen(backlog)
```

---

# 十八、netdev_max_backlog 不是 TCP 半连接队列

还有一个很容易被混淆的参数：

```bash
sysctl net.core.netdev_max_backlog
```

它不是：

```text
SYN Queue
```

也不是：

```text
Accept Queue
```

它解决的是更靠下的一层：

```text
网卡收到包太快
   ↓
内核来不及处理
   ↓
输入侧积压
```

可以理解：

```text
NIC
 ↓
netdev backlog
 ↓
IP/TCP stack
 ↓
SYN Queue
 ↓
Accept Queue
 ↓
Application
```

因此三种 backlog 完全不是同一个东西。

---

# 十九、接下来进入另一个问题：单连接为什么跑不满

假设现在：

```text
TCP 建连完全正常
```

但：

```text
1Gbps 线路
```

实际单连接只能：

```text
50Mbps
```

这时候：

```text
tcp_max_syn_backlog
somaxconn
```

基本没意义了。

应该看：

```text
RTT
丢包
rwnd
cwnd
BDP
Socket Buffer
拥塞控制
```

---

# 二十、TCP 为什么需要滑动窗口

最简单的可靠协议可以这样实现：

```text
发一个 Segment
 ↓
等待 ACK
 ↓
再发一个 Segment
```

这种方式叫类似：

```text
Stop-and-Wait
```

如果：

```text
RTT = 100ms
```

每次都等 100ms：

```text
吞吐会非常低
```

所以 TCP 使用：

```text
Sliding Window
```

也就是：

```text
滑动窗口
```

---

# 二十一、滑动窗口允许同时“在途”多批数据

假设允许：

```text
64KB
```

未确认数据存在。

发送方可以：

```text
Segment 1
Segment 2
Segment 3
Segment 4
...
```

连续发送。

而不是：

```text
Segment 1
等 ACK

Segment 2
等 ACK
```

窗口可以理解成：

```text
已经 ACK      已发送未 ACK       允许继续发送      暂时不能发
████████ | █████████████ | █████████████ | ░░░░░░
          ↑
       窗口不断向右滑动
```

当 ACK 到达：

```text
窗口向右移动
```

因此叫：

```text
滑动窗口
```

---

# 二十二、rwnd：接收窗口

`rwnd`：

```text
Receive Window
```

由：

```text
接收方
```

通告。

它表达：

```text
我现在还有多少接收缓存空间
```

假设接收端告诉发送端：

```text
rwnd = 1MB
```

意思大致是：

```text
你不要让我这里积压超过允许范围的数据
```

它属于：

```text
Flow Control
流量控制
```

目的是保护：

```text
接收方
```

---

# 二十三、cwnd：拥塞窗口

`cwnd`：

```text
Congestion Window
```

由：

```text
发送方
```

的拥塞控制算法维护。

它表达：

```text
根据当前网络状态
我认为网络里最多适合存在多少未确认数据
```

它属于：

```text
Congestion Control
拥塞控制
```

目的是保护：

```text
网络
```

---

# 二十四、rwnd 和 cwnd 完全不是一回事

可以这样记：

```text
rwnd
=
接收端说：
“我最多还能接这么多。”


cwnd
=
发送端根据网络判断：
“我最多应该在网络里放这么多。”
```

实际发送能力大致受到：

```text
min(rwnd, cwnd)
```

限制。

也就是：

```text
实际可用窗口
=
接收端允许量
和
网络拥塞允许量
中的较小值
```

---

# 二十五、一个简单例子

假设：

```text
rwnd = 16MB
cwnd = 2MB
```

虽然接收端能收：

```text
16MB
```

但网络拥塞控制只允许：

```text
2MB
```

实际仍然主要受：

```text
2MB
```

限制。

反过来：

```text
rwnd = 1MB
cwnd = 20MB
```

网络很空闲。

但接收端只能接：

```text
1MB
```

那实际又受：

```text
rwnd
```

限制。

---

# 二十六、TCP Window Scaling 为什么重要

TCP Header 原始 Window 字段只有：

```text
16 bit
```

最大：

```text
65535 bytes
≈ 64KB
```

对现代网络来说太小。

因此 TCP 有：

```text
Window Scaling
```

查看：

```bash
sysctl net.ipv4.tcp_window_scaling
```

Linux 通常默认：

```text
1
```

表示启用。

---

# 二十七、Window Scale 怎么理解

例如 SYN 中协商：

```text
wscale 8
```

那窗口字段可以按比例放大：

```text
2^8 = 256
```

例如：

```text
65535 × 256
≈ 16MB
```

这样 TCP 才能适应：

```text
高带宽
+
高 RTT
```

网络。

---

# 二十八、为什么 64KB 窗口会限制高延迟链路

假设：

```text
Window = 64KB
RTT = 100ms
```

粗略最大吞吐：

```text
吞吐 ≈ Window / RTT
```

所以：

```text
64KB / 0.1s
≈ 640KB/s
≈ 5.2Mbps
```

即使物理链路是：

```text
1Gbps
```

也很难利用起来。

---

# 二十九、BDP 是什么

BDP：

```text
Bandwidth-Delay Product
```

中文：

```text
带宽时延积
```

公式：

```text
BDP = Bandwidth × RTT
```

它回答一个非常重要的问题：

```text
为了让链路始终保持“装满”
网络中大约需要同时存在多少未确认数据？
```

---

# 三十、1Gbps + 100ms 的 BDP

假设：

```text
Bandwidth = 1Gbps
RTT = 100ms = 0.1s
```

那么：

```text
BDP
=
1Gbps × 0.1s
=
100Mbit
≈
12.5MB
```

也就是说：

```text
想让单 TCP 流尽可能跑满 1Gbps / 100ms 链路
窗口和 buffer 至少要有约十几 MB 的量级
```

还要考虑：

```text
协议开销
拥塞控制
丢包
实际 RTT 波动
```

---

# 三十一、再看 10Gbps + 80ms

```text
10Gbps × 0.08s
=
800Mbit
≈
100MB
```

这就是为什么：

```text
高带宽
+
跨国高 RTT
```

场景里经常需要明显更大的：

```text
TCP Window
Socket Buffer
```

否则：

```text
网卡很快
CPU也够
线路也够
```

但单流吞吐仍然上不去。

---

# 三十二、先算 BDP，再考虑 buffer

这是非常重要的调优原则。

错误方法：

```text
听说 128MB 很快
↓
所有服务器 tcp_rmem/tcp_wmem 都设 128MB
```

正确方法：

```text
实际带宽
×
实际 RTT
=
BDP
```

然后再判断：

```text
现有 Window / Buffer
是否真的不足
```

---

# 三十三、tcp_rmem 是什么

查看：

```bash
sysctl net.ipv4.tcp_rmem
```

它有三个值：

```text
min default max
```

例如：

```text
4096 131072 6291456
```

分别可以理解为：

```text
min
最低接收 buffer 保证

default
初始接收 buffer

max
TCP 自动调优接收 buffer 时允许达到的最大值
```

Linux 默认启用了：

```text
receive buffer autotuning
```

所以不要理解成：

```text
每个 TCP socket 一创建就占 max
```

---

# 三十四、tcp_moderate_rcvbuf

查看：

```bash
sysctl net.ipv4.tcp_moderate_rcvbuf
```

Linux 官方默认：

```text
1
```

开启后 TCP 会尝试根据：

```text
实际路径
吞吐
RTT
应用读取情况
```

自动增长接收 buffer。

上限主要受：

```text
tcp_rmem[2]
```

影响。

所以现代 Linux 通常不需要手工把每个 socket 固定成巨大 buffer。

---

# 三十五、tcp_wmem 是什么

查看：

```bash
sysctl net.ipv4.tcp_wmem
```

也是：

```text
min default max
```

例如：

```text
4096 16384 4194304
```

主要控制：

```text
TCP 发送 buffer
```

其中最大值影响：

```text
自动调节后的发送缓存上限
```

---

# 三十六、net.core.rmem_max / wmem_max

还有：

```bash
sysctl net.core.rmem_max
sysctl net.core.wmem_max
```

它们属于更通用的：

```text
socket buffer 上限
```

现代 Linux 官方文档当前给出的默认值通常为：

```text
4194304
```

也就是：

```text
4MB
```

但实际发行版可能有不同默认值。

所以永远应该：

```bash
sysctl net.core.rmem_max
sysctl net.core.wmem_max
```

以本机结果为准。

---

# 三十七、tcp_rmem/wmem 和 core rmem/wmem 不要混淆

可以粗略理解：

```text
net.ipv4.tcp_rmem
net.ipv4.tcp_wmem

→ TCP 自动 buffer 调优相关


net.core.rmem_max
net.core.wmem_max

→ socket 层允许的最大 buffer 范围之一
```

应用如果自己：

```c
setsockopt(SO_RCVBUF)
setsockopt(SO_SNDBUF)
```

还会改变 Linux 自动调优行为。

因此：

```text
应用主动设置 socket buffer
```

和：

```text
完全依赖 Linux autotuning
```

可能得到不同结果。

---

# 三十八、怎么查看当前 buffer 参数

一次看完：

```bash
sysctl \
  net.ipv4.tcp_window_scaling \
  net.ipv4.tcp_moderate_rcvbuf \
  net.ipv4.tcp_rmem \
  net.ipv4.tcp_wmem \
  net.core.rmem_max \
  net.core.wmem_max
```

还可以：

```bash
ss -m
```

观察 socket 内存。

---

# 三十九、什么时候才值得调大 TCP Buffer

典型场景：

```text
高带宽
+
高 RTT
```

例如：

```text
跨国专线
跨洲公网
卫星链路
远程大文件传输
高速异地备份
高带宽 VPN / Tunnel
```

如果：

```text
BDP = 20MB
```

而系统能够使用的 TCP buffer 明显只有：

```text
几 MB
```

就值得进一步验证。

---

# 四十、局域网通常不要乱加大

例如：

```text
10Gbps LAN
RTT = 0.2ms
```

BDP：

```text
10Gbps × 0.0002
=
2Mbit
≈
250KB
```

这种情况下：

```text
直接把每个 socket buffer 设成 128MB
```

通常没有什么必要。

而且大量并发连接时还可能增加：

```text
内存压力
cache 压力
```

---

# 四十一、一个“高 BDP”测试配置示例

假设经过计算和压测，确认：

```text
当前 buffer 确实限制吞吐
```

才可以尝试类似：

```conf
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432

net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 16384 33554432

net.ipv4.tcp_window_scaling = 1
```

也就是最大：

```text
32MB
```

注意：

> 这里只是“测试配置示例”，不是所有 Linux 服务器的推荐值。

如果 BDP 是：

```text
100MB
```

32MB 甚至仍然可能不够。

如果 BDP 只有：

```text
200KB
```

32MB 又可能毫无意义。

---

# 四十二、cwnd 与拥塞控制算法

前面说：

```text
rwnd
```

保护接收端。

而：

```text
cwnd
```

由拥塞控制算法维护。

Linux 可以查看：

```bash
sysctl net.ipv4.tcp_congestion_control
```

例如：

```text
cubic
```

查看系统当前可用算法：

```bash
sysctl net.ipv4.tcp_available_congestion_control
```

例如：

```text
reno cubic bbr
```

具体有哪些，以当前：

```text
内核
发行版
已加载模块
```

为准。

---

# 四十三、CUBIC 是什么

CUBIC 是 Linux 中非常常见的 TCP 拥塞控制算法。

它主要通过：

```text
拥塞窗口 cwnd
```

随时间变化来探索可用带宽。

可以粗略理解：

```text
发送越来越快
 ↓
观察 ACK / 丢包
 ↓
发生拥塞
 ↓
降低窗口
 ↓
再次增长
```

CUBIC 在：

```text
普通互联网
数据中心以外的大量 Linux 场景
```

中都非常成熟。

所以：

```text
BBR 存在
```

并不意味着：

```text
CUBIC 就应该全部换掉
```

---

# 四十四、BBR 是什么

BBR：

```text
Bottleneck Bandwidth and RTT
```

核心思路与传统单纯依赖丢包信号的算法不同。

它尝试估计：

```text
Bottleneck Bandwidth
+
Round-trip propagation time
```

也就是：

```text
瓶颈带宽
+
往返传播时延
```

然后根据模型决定：

```text
发送速率
pacing
在途数据量
```

---

# 四十五、BBR 适合哪些场景

经常值得测试的场景：

```text
长 RTT
高带宽
存在随机丢包
跨国网络
公网大文件传输
远程备份
部分 VPN / Tunnel
```

尤其是：

```text
丢包并不完全等于真实拥塞
```

的链路。

但是仍然应该：

```text
A/B 压测
```

而不是：

```text
看到 BBR 就默认更快
```

---

# 四十六、如何检查 BBR 是否真的可用

先：

```bash
sysctl net.ipv4.tcp_available_congestion_control
```

如果没有：

```text
bbr
```

可以检查模块：

```bash
modprobe tcp_bbr
```

然后重新查看：

```bash
sysctl net.ipv4.tcp_available_congestion_control
```

如果内核根本没有对应实现：

```text
modprobe
```

也不会凭空变出来。

---

# 四十七、临时切换拥塞控制算法

例如测试 BBR：

```bash
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

测试 CUBIC：

```bash
sysctl -w net.ipv4.tcp_congestion_control=cubic
```

然后使用同样环境：

```text
同一时间段
同一服务器
同一客户端
同样线程数
同样测试时长
```

通过：

```bash
iperf3
```

对比。

---

# 四十八、不要只看平均 Mbps

比较拥塞算法至少应该关注：

```text
吞吐
RTT
重传
抖动
P95 / P99 延迟
公平性
多流竞争
```

因为可能出现：

```text
算法 A：
吞吐更高
但排队延迟更大

算法 B：
吞吐略低
但交互延迟更稳定
```

所以：

```text
更高 Mbps
```

不一定等于：

```text
业务更好
```

---

# 四十九、查看当前 qdisc

Linux：

```bash
tc qdisc show
```

指定网卡：

```bash
tc qdisc show dev eth0
```

BBR 经常与：

```text
pacing
```

一起讨论。

Google 的 BBR 部署资料长期推荐使用：

```text
fq
```

等能够良好支持 pacing 的队列规则。

不过具体是否需要修改：

```text
default_qdisc
```

应以：

```text
当前内核
网卡
业务
测试结果
```

为准。

---

# 五十、查看单条 TCP 连接的 cwnd 和 RTT

非常实用：

```bash
ss -tin
```

可能看到：

```text
rtt:42.1/3.2
cwnd:10
pacing_rate ...
delivery_rate ...
```

这些比单纯：

```text
ping
```

更接近实际 TCP 行为。

---

# 五十一、ss -tin 常见字段

重点关注：

```text
rtt
```

TCP 测得的 RTT。

```text
cwnd
```

当前拥塞窗口。

```text
ssthresh
```

慢启动阈值。

```text
retrans
```

重传信息。

```text
pacing_rate
```

发送 pacing 速率。

```text
delivery_rate
```

实际估计交付速率。

不同内核显示字段略有不同。

---

# 五十二、为什么 RTT 一高，窗口问题就更明显

假设：

```text
RTT = 1ms
```

ACK 很快回来。

窗口很快可以继续向前滑动。

而：

```text
RTT = 200ms
```

ACK 很久才回来。

如果窗口又很小：

```text
发送方很快把窗口用完
 ↓
只能等待 ACK
 ↓
线路出现空闲
 ↓
吞吐下降
```

所以：

```text
高 RTT
```

场景才特别关注：

```text
BDP
Window
Buffer
Congestion Control
```

---

# 五十三、丢包为什么对 TCP 吞吐影响很大

TCP 看到丢包可能需要：

```text
重传
降低 cwnd
等待 ACK
```

高 RTT 场景中：

```text
一次恢复
```

需要付出的时间成本更高。

所以：

```text
100ms RTT + 1% loss
```

和：

```text
1ms RTT + 1% loss
```

的业务体验可能完全不同。

---

# 五十四、SACK 一般应该保持开启

查看：

```bash
sysctl net.ipv4.tcp_sack
```

通常：

```text
1
```

SACK：

```text
Selective Acknowledgment
```

可以让接收端告诉发送端：

```text
哪些区间已经收到
哪些区间缺失
```

有助于丢包后的高效恢复。

一般不应该为了所谓：

```text
性能优化
```

随意关闭。

---

# 五十五、TIME_WAIT 是不是越少越好

不是。

TIME_WAIT 是 TCP 正常状态之一。

查看：

```bash
ss -ant state time-wait
```

统计：

```bash
ss -ant state time-wait | wc -l
```

大量短连接服务出现：

```text
很多 TIME_WAIT
```

本身并不代表故障。

---

# 五十六、TIME_WAIT 有什么作用

主要包括：

```text
保证最后 ACK 仍有机会重发
```

以及：

```text
避免旧连接的延迟 Segment
污染后续复用相同四元组的新连接
```

所以不能简单认为：

```text
TIME_WAIT = 垃圾连接
```

---

# 五十七、tcp_tw_reuse 不要乱改

查看：

```bash
sysctl net.ipv4.tcp_tw_reuse
```

现代 Linux 官方文档定义：

```text
0 = 禁用
1 = 全局启用
2 = 仅 loopback 流量启用
```

当前官方默认：

```text
2
```

并且明确提示：

```text
没有专业依据不要随意修改
```

所以不要照搬旧文章：

```conf
net.ipv4.tcp_tw_reuse = 1
```

然后认为：

```text
TIME_WAIT 优化完成
```

---

# 五十八、tcp_fin_timeout 不是 TIME_WAIT 清理参数

这是一个非常常见的误解。

很多所谓优化文章写：

```conf
net.ipv4.tcp_fin_timeout = 10
```

然后说：

```text
减少 TIME_WAIT
```

这是不严谨的。

`tcp_fin_timeout` 主要涉及：

```text
本地已关闭、成为 orphan 的连接
在 FIN-WAIT-2 等阶段的等待行为
```

它不是简单的：

```text
TIME_WAIT 生存时间
```

所以不要把：

```text
tcp_fin_timeout
```

当作：

```text
清 TIME_WAIT
```

按钮。

---

# 五十九、tcp_max_tw_buckets 也不是性能加速器

它限制：

```text
系统允许维护的 TIME_WAIT socket 数量
```

如果为了“减少 TIME_WAIT”故意设得很小：

```text
可能只是更早丢掉正常 TCP 状态
```

并不等于：

```text
性能更高
```

正确做法是先问：

```text
TIME_WAIT 到底造成了什么实际资源问题？
```

如果没有：

```text
端口耗尽
内存压力
连接建立失败
```

通常没有必要仅仅因为：

```text
数字看起来很大
```

就处理它。

---

# 六十、真正经常导致客户端并发瓶颈的是临时端口

客户端主动连接服务器时：

```text
Source IP
+
Source Port
+
Destination IP
+
Destination Port
```

构成 TCP 四元组。

其中客户端 Source Port 通常来自：

```text
ephemeral port
临时端口
```

查看：

```bash
sysctl net.ipv4.ip_local_port_range
```

Linux 官方默认通常是：

```text
32768 60999
```

大约只有：

```text
28232
```

个端口。

---

# 六十一、为什么临时端口可能耗尽

假设单机代理不断连接：

```text
同一个目标 IP
同一个目标端口
```

而源 IP 又只有一个。

每条 TCP 连接都要占：

```text
不同源端口
```

大量连接再加上：

```text
TIME_WAIT
```

就可能出现：

```text
Cannot assign requested address
```

或者新连接建立困难。

这种场景常见于：

```text
反向代理
爬虫
API Gateway
压测客户端
NAT 网关
数据库客户端
```

---

# 六十二、查看临时端口范围

```bash
sysctl net.ipv4.ip_local_port_range
```

同时查看保留端口：

```bash
sysctl net.ipv4.ip_local_reserved_ports
```

因为如果扩大范围：

```text
不能只考虑数字大不大
```

还需要避免和：

```text
本机服务端口
保留端口
业务绑定端口
```

冲突。

---

# 六十三、扩大临时端口范围只是其中一个办法

例如：

```conf
net.ipv4.ip_local_port_range = 10000 65535
```

只能作为：

```text
根据业务验证后的示例
```

不是通用推荐。

真正高规模场景还可以考虑：

```text
增加源 IP
连接池复用
HTTP Keep-Alive
HTTP/2 多路复用
减少短连接
合理复用 upstream
```

通常这些架构优化比：

```text
无限调大端口范围
```

更重要。

---

# 六十四、文件描述符同样会卡住高并发 TCP

每个 TCP socket 本质上都会消耗：

```text
File Descriptor
```

查看：

```bash
ulimit -n
```

例如：

```text
1024
```

那你即使：

```text
somaxconn = 65535
```

也不代表应用就能维持：

```text
65535 个 socket
```

还要看：

```text
进程 NOFILE
systemd LimitNOFILE
全局 file table
应用自身限制
```

---

# 六十五、systemd 服务要看 LimitNOFILE

例如：

```bash
systemctl show nginx -p LimitNOFILE
```

或者：

```bash
systemctl show <SERVICE> -p LimitNOFILE
```

如果需要调整，通常应该在：

```text
systemd service override
```

里设置。

不要只：

```bash
ulimit -n 1000000
```

然后以为 systemd 启动的服务也自动继承。

---

# 六十六、Docker / NAT 主机还要看 conntrack

如果 Linux 主机同时承担：

```text
Docker NAT
iptables/nftables stateful firewall
NAT Gateway
Kubernetes Node
```

TCP 连接还可能进入：

```text
Netfilter conntrack
```

查看：

```bash
sysctl net.netfilter.nf_conntrack_count
sysctl net.netfilter.nf_conntrack_max
```

其中：

```text
nf_conntrack_count
```

是当前连接跟踪条目数量。

```text
nf_conntrack_max
```

是允许的最大条目数量。

---

# 六十七、conntrack 满了是什么表现

可能看到日志：

```text
nf_conntrack: table full, dropping packet
```

这时即使：

```text
somaxconn
tcp_max_syn_backlog
```

都足够大，也没用。

因为包可能在更前面：

```text
Netfilter
```

层就被丢了。

路径：

```text
NIC
 ↓
Netfilter / conntrack
 ↓
TCP
 ↓
listen queue
 ↓
Application
```

---

# 六十八、观察 conntrack 使用率

```bash
watch -n 1 '
cat /proc/sys/net/netfilter/nf_conntrack_count
cat /proc/sys/net/netfilter/nf_conntrack_max
'
```

如果长期：

```text
count 接近 max
```

就应该进一步分析：

```text
为什么连接这么多
timeout 是否合理
是否存在攻击
是否短连接过多
机器内存是否足够
```

而不是只机械地：

```text
把 max 翻十倍
```

---

# 六十九、conntrack 本身也消耗内存

连接跟踪条目不是免费的。

扩大：

```text
nf_conntrack_max
```

意味着系统允许保存更多连接状态。

所以必须同时考虑：

```text
RAM
hash table
CPU lookup 成本
业务连接模型
```

特别是：

```text
数十万
数百万
```

连接场景。

---

# 七十、一个高并发服务的完整瓶颈链

可以把整个过程画成：

```text
互联网客户端
     ↓
NIC
     ↓
netdev backlog
     ↓
Netfilter / conntrack
     ↓
TCP SYN Queue
     ↓
Accept Queue
     ↓
accept()
     ↓
FD
     ↓
worker / event loop
     ↓
应用逻辑
     ↓
数据库 / Redis / 下游服务
```

任何一层达到上限：

```text
客户端最终都可能表现为“TCP 慢”
```

但原因完全不同。

---

# 七十一、所以不要一上来就 sysctl -p

正确第一步应该是：

```text
建立基线
```

先采集：

```bash
uname -r

sysctl net.ipv4.tcp_max_syn_backlog
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_syncookies

sysctl net.ipv4.tcp_rmem
sysctl net.ipv4.tcp_wmem
sysctl net.ipv4.tcp_window_scaling

sysctl net.ipv4.tcp_congestion_control
sysctl net.ipv4.tcp_available_congestion_control

sysctl net.ipv4.ip_local_port_range

sysctl net.netfilter.nf_conntrack_count 2>/dev/null
sysctl net.netfilter.nf_conntrack_max 2>/dev/null
```

保存结果。

---

# 七十二、再看系统当前连接情况

```bash
ss -s
```

可以快速看到：

```text
TCP 总量
established
closed
orphaned
timewait
```

继续：

```bash
ss -ant state syn-recv
ss -ant state established
ss -ant state time-wait
```

---

# 七十三、看监听队列

```bash
ss -lntp
```

重点：

```text
Recv-Q
Send-Q
```

如果某个高流量服务：

```text
Recv-Q 长期接近 Send-Q
```

优先考虑：

```text
应用 accept
worker
listen backlog
somaxconn
```

而不是：

```text
tcp_rmem
```

---

# 七十四、看 TCP 统计增量

```bash
nstat -az
```

建议重点过滤：

```bash
nstat -az | grep -E \
'Listen|Syncookies|Retrans|Timeout|TCPSynRetrans|TCPAbort'
```

可以做：

```text
压测前记录
压测 60 秒
压测后记录
```

比较增量。

---

# 七十五、看重传

例如：

```bash
nstat -az | grep -E 'TcpRetransSegs|TCPFastRetrans|TCPSynRetrans'
```

如果吞吐差时：

```text
重传大量增加
```

那你首先应该查：

```text
丢包
链路质量
拥塞
MTU
中间设备
```

而不是继续扩大：

```text
socket buffer
```

---

# 七十六、iperf3 是 TCP 调优最实用的基准工具之一

服务端：

```bash
iperf3 -s
```

客户端：

```bash
iperf3 -c <SERVER_IP> -t 30
```

反向：

```bash
iperf3 -c <SERVER_IP> -R -t 30
```

多流：

```bash
iperf3 -c <SERVER_IP> -P 4 -t 30
```

---

# 七十七、单流和多流结果差异非常重要

如果：

```text
单流 = 100Mbps
4 流 = 390Mbps
```

这说明：

```text
物理链路可能远不止 100Mbps
```

单流更可能受：

```text
cwnd
RTT
丢包
Window
单核处理
```

限制。

如果：

```text
单流 = 390Mbps
4 流 = 400Mbps
```

说明：

```text
链路总容量大约就在 400Mbps 附近
```

继续调 TCP Window 可能不会有明显收益。

---

# 七十八、如何验证是不是 BDP / Window 限制

先测：

```text
RTT
```

例如：

```bash
ping <SERVER_IP>
```

再测：

```text
实际链路最大带宽
```

然后计算：

```text
BDP
```

最后观察：

```bash
ss -tin
```

看：

```text
cwnd
rtt
delivery_rate
```

结合：

```text
socket buffer
```

判断。

---

# 七十九、一个典型跨国链路例子

假设：

```text
带宽 = 500Mbps
RTT = 180ms
```

BDP：

```text
500Mbps × 0.18
=
90Mbit
≈
11.25MB
```

如果系统有效窗口只有：

```text
2MB
```

单流就很可能跑不满。

此时：

```text
适当提升 buffer 上限
+
保持 window scaling
+
测试 BBR/CUBIC
```

才是有逻辑的调优。

---

# 八十、一个典型高并发 Web 服务例子

表现：

```text
CPU 60%
带宽很低
但新连接大量 timeout
```

查看：

```bash
ss -ant state syn-recv | wc -l
ss -lntp
nstat -az | grep -E 'ListenOverflows|ListenDrops|Syncookies'
```

发现：

```text
Accept Queue 经常满
ListenOverflows 持续增加
```

这时应该：

```text
检查应用 accept 速度
worker 数
listen backlog
somaxconn
```

而不是：

```text
切 BBR
```

因为：

```text
BBR 解决的不是 accept queue
```

---

# 八十一、一个典型 NAT 网关例子

表现：

```text
业务连接随机失败
CPU不高
listen queue也正常
```

查看：

```bash
dmesg | grep -i conntrack
```

出现：

```text
nf_conntrack: table full
```

再看：

```bash
sysctl net.netfilter.nf_conntrack_count
sysctl net.netfilter.nf_conntrack_max
```

发现：

```text
count ≈ max
```

那么问题在：

```text
conntrack
```

而不是：

```text
TCP backlog
```

---

# 八十二、一个典型客户端端口耗尽例子

压测机器不断创建短连接：

```text
Client → 同一 Server:443
```

最终出现：

```text
Cannot assign requested address
```

检查：

```bash
sysctl net.ipv4.ip_local_port_range
ss -ant state time-wait | wc -l
```

发现：

```text
大量 TIME_WAIT
+
临时端口范围有限
```

这时优先：

```text
Keep-Alive
连接池
HTTP/2
增加源 IP
适当调整端口范围
```

而不是看到 TIME_WAIT 就粗暴删除状态。

---

# 八十三、EasyTier / VPN / Tunnel 调优应该关注什么

对于：

```text
EasyTier
WireGuard
OpenVPN
隧道代理
```

要分清：

```text
隧道外层
```

和：

```text
隧道内层
```

例如：

```text
TCP 应用
   ↓
EasyTier
   ↓
UDP / TCP / WebSocket
   ↓
公网
```

此时可能同时存在：

```text
内层 TCP 拥塞控制
外层 TCP 拥塞控制
```

如果是：

```text
TCP over TCP
```

还可能产生复杂的重传和拥塞交互。

所以隧道性能问题不能只看：

```text
宿主机 tcp_rmem
```

还要看：

```text
底层协议
MTU/MSS
RTT
丢包
隧道实现
加密 CPU
平台 Proxy
```

---

# 八十四、不要把所有隧道性能问题都归因于 BBR

如果实际是：

```text
CPU 加密满
```

换 BBR 没用。

如果：

```text
MTU 黑洞
```

换 BBR 没用。

如果：

```text
公网映射吞掉二进制 Payload
```

换 BBR 更没用。

如果：

```text
平台限速 100Mbps
```

把 buffer 调到 128MB 也不会变成 1Gbps。

---

# 八十五、参数调优应该一次只改一类

例如：

```text
第一轮：
只调 backlog

第二轮：
只调 buffer

第三轮：
只切 congestion control
```

而不要一次：

```text
改 30 个 sysctl
```

否则结果变好了，你都不知道：

```text
到底是哪一个参数起作用
```

结果变差，也不知道：

```text
哪个参数需要回滚
```

---

# 八十六、推荐建立 before / after 表格

例如：

| 指标 | 修改前 | 修改后 |
|---|---:|---:|
| 单流吞吐 | 120 Mbps | 430 Mbps |
| 4 流吞吐 | 450 Mbps | 470 Mbps |
| RTT | 85 ms | 86 ms |
| Retrans | 1200 | 180 |
| ListenDrops | 0 | 0 |
| CPU | 30% | 34% |
| tcp_rmem max | 6 MB | 32 MB |
| 拥塞算法 | cubic | bbr |

这样才能判断：

```text
优化是否真实有效
```

---

# 八十七、一个安全的“查看脚本”

可以先只读取，不修改任何参数：

```bash
echo '=== kernel ==='
uname -r

echo
echo '=== listen queues ==='
sysctl net.ipv4.tcp_max_syn_backlog
sysctl net.core.somaxconn
sysctl net.ipv4.tcp_syncookies
sysctl net.ipv4.tcp_abort_on_overflow

echo
echo '=== tcp buffer ==='
sysctl net.ipv4.tcp_window_scaling
sysctl net.ipv4.tcp_moderate_rcvbuf
sysctl net.ipv4.tcp_rmem
sysctl net.ipv4.tcp_wmem
sysctl net.core.rmem_max
sysctl net.core.wmem_max

echo
echo '=== congestion control ==='
sysctl net.ipv4.tcp_congestion_control
sysctl net.ipv4.tcp_available_congestion_control

echo
echo '=== ephemeral ports ==='
sysctl net.ipv4.ip_local_port_range
sysctl net.ipv4.ip_local_reserved_ports

echo
echo '=== TIME_WAIT ==='
sysctl net.ipv4.tcp_tw_reuse

echo
echo '=== socket summary ==='
ss -s

echo
echo '=== SYN_RECV count ==='
ss -ant state syn-recv | wc -l

echo
echo '=== TIME_WAIT count ==='
ss -ant state time-wait | wc -l

echo
echo '=== conntrack ==='
sysctl net.netfilter.nf_conntrack_count 2>/dev/null || true
sysctl net.netfilter.nf_conntrack_max 2>/dev/null || true
```

这套命令非常适合作为：

```text
调优前基线
```

---

# 八十八、一个“连接队列压力”观察脚本

```bash
watch -n 1 '
echo "=== SYN_RECV ==="
ss -ant state syn-recv | wc -l

echo
echo "=== LISTEN ==="
ss -lnt

echo
echo "=== TCP LISTEN COUNTERS ==="
nstat -az 2>/dev/null | grep -E "ListenOverflows|ListenDrops|Syncookies|TCPReqQFull"
'
```

如果业务连接失败时：

```text
ListenOverflows
ListenDrops
```

不断增长，就非常有价值。

---

# 八十九、一个“单连接吞吐”观察方法

测试时客户端：

```bash
iperf3 -c <SERVER_IP> -t 60
```

另一终端：

```bash
watch -n 1 "ss -tin dst <SERVER_IP>"
```

重点看：

```text
rtt
cwnd
retrans
pacing_rate
delivery_rate
```

如果：

```text
cwnd 很小
重传很多
```

和：

```text
rwnd / buffer 太小
```

是完全不同的方向。

---

# 九十、什么时候适合提高 tcp_max_syn_backlog

满足这些证据时：

```text
合法新连接速率很高
SYN_RECV 明显积压
出现 SYN queue 压力
CPU / 内存仍有余量
不是 SYN Flood
```

才考虑提高。

例如测试：

```conf
net.ipv4.tcp_max_syn_backlog = 8192
```

或者：

```conf
net.ipv4.tcp_max_syn_backlog = 16384
```

然后重新压测。

不要没有数据就直接：

```text
262144
```

---

# 九十一、什么时候适合提高 somaxconn

满足：

```text
Accept Queue 经常接近上限
ListenOverflows / ListenDrops 增长
应用 backlog 配置也足够
应用确实会出现瞬时连接突发
```

可以考虑：

```conf
net.core.somaxconn = 8192
```

或更高。

但同时应该解决：

```text
为什么应用 accept 不够快
```

---

# 九十二、什么时候适合调大 rmem/wmem

满足：

```text
高 BDP 链路
单流跑不满
多流明显更快
系统 buffer 上限明显低于 BDP
丢包不严重
CPU也不满
```

才值得调整。

例如：

```conf
net.core.rmem_max = 33554432
net.core.wmem_max = 33554432
net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 16384 33554432
```

然后：

```text
重新测试单流
```

---

# 九十三、什么时候适合测试 BBR

例如：

```text
公网
高 RTT
存在随机丢包
长肥管道
跨洲链路
```

可以：

```bash
sysctl net.ipv4.tcp_available_congestion_control
```

确认后，分别测试：

```bash
sysctl -w net.ipv4.tcp_congestion_control=cubic
```

和：

```bash
sysctl -w net.ipv4.tcp_congestion_control=bbr
```

不要凭感觉判断。

---

# 九十四、什么时候不要动 tcp_tw_reuse

如果你只是：

```bash
ss -s
```

看到：

```text
timewait 20000
```

但：

```text
连接正常
没有端口耗尽
内存正常
CPU正常
```

那很可能：

```text
什么都不用改
```

TIME_WAIT 多只是：

```text
业务短连接多
```

的表现。

---

# 九十五、什么时候应该优化应用而不是内核

例如：

```text
Nginx → 后端 API
```

每次请求都创建：

```text
一个新 TCP 连接
```

与其疯狂调：

```text
TIME_WAIT
临时端口
```

更合理的可能是：

```text
upstream keepalive
```

同理：

```text
数据库
Redis
HTTP API
```

优先使用：

```text
连接池
长连接
多路复用
```

往往比内核参数收益更大。

---

# 九十六、不要盲目相信“万能 sysctl.conf”

网上常见：

```conf
net.ipv4.tcp_tw_reuse = 1
net.ipv4.tcp_fin_timeout = 10
net.core.somaxconn = 65535
net.ipv4.tcp_max_syn_backlog = 262144
net.core.rmem_max = 134217728
net.core.wmem_max = 134217728
...
```

看起来非常“专业”。

但真正的问题是：

```text
你的服务器为什么需要这些值？
```

如果回答不出来：

```text
就不应该直接部署
```

---

# 九十七、Linux 默认值本身也在变化

这一点特别重要。

例如 Linux 官方文档当前说明：

```text
somaxconn
```

默认：

```text
4096
```

而 Linux 5.4 以前长期是：

```text
128
```

所以十年前的调优文章可能会说：

```text
必须把 somaxconn 从 128 调大
```

在现代系统上：

```text
默认值可能早就不同了
```

同样：

```text
tcp_tw_reuse
rmem_max
wmem_max
```

等参数在不同内核版本也可能变化。

所以：

```text
永远以本机 sysctl
+
当前内核官方文档
```

为准。

---

# 九十八、哪些参数属于“谨慎区”

以下参数不要为了所谓性能随便修改：

```text
tcp_tw_reuse
tcp_fin_timeout
tcp_max_tw_buckets
tcp_abort_on_overflow
tcp_synack_retries
tcp_retries2
```

因为它们很多影响的是：

```text
协议正确性
失败恢复
超时行为
兼容性
```

不是简单的：

```text
数值越小越快
```

---

# 九十九、哪些参数相对适合基于数据调优

相对常见：

```text
tcp_max_syn_backlog
somaxconn

tcp_rmem
tcp_wmem
rmem_max
wmem_max

ip_local_port_range

nf_conntrack_max

tcp_congestion_control
```

但前提依然是：

```text
对应瓶颈已经被观察到
```

---

# 一百、推荐的调优流程

完整流程：

```text
1. 明确业务问题

连接失败？
单流慢？
高并发慢？
跨国慢？


2. 建立基线

sysctl
ss
nstat
iperf3


3. 判断瓶颈层

SYN Queue？
Accept Queue？
Buffer？
cwnd？
丢包？
conntrack？
FD？
临时端口？


4. 一次修改一类参数


5. 重复同样压测


6. 记录 Before / After


7. 无收益就回滚
```

---

# 一百零一、场景一：普通 Web / API 服务

普通低延迟 Web 服务优先关注：

```text
应用 worker
Keep-Alive
listen backlog
somaxconn
FD
数据库连接池
```

而不是第一时间：

```text
把 tcp_rmem 调到 128MB
```

因为它通常不是：

```text
高 BDP 长连接吞吐
```

场景。

---

# 一百零二、场景二：高新建连接率 API

重点：

```text
tcp_max_syn_backlog
somaxconn
listen(backlog)
accept() 速度
syncookies 是否频繁触发
FD
CPU
```

检查：

```bash
ss -ant state syn-recv
ss -lntp
nstat -az | grep -E 'Listen|Syncookies'
```

---

# 一百零三、场景三：跨国大文件传输

重点：

```text
RTT
BDP
tcp_rmem
tcp_wmem
Window Scaling
cwnd
CUBIC / BBR
丢包
```

测试：

```bash
iperf3 -c <SERVER> -t 60
iperf3 -c <SERVER> -P 4 -t 60
```

单流和多流对比尤其重要。

---

# 一百零四、场景四：Docker / NAT 网关

重点：

```text
conntrack
临时端口
CPU
PPS
netdev backlog
NAT 规则
```

检查：

```bash
sysctl net.netfilter.nf_conntrack_count
sysctl net.netfilter.nf_conntrack_max

sysctl net.ipv4.ip_local_port_range

ip -s link
```

---

# 一百零五、场景五：VPN / EasyTier

重点：

```text
公网 RTT
实际底层协议
MTU / MSS
丢包
加密 CPU
中间 TCP Proxy
单流 / 多流
外层拥塞控制
```

如果 EasyTier 使用：

```text
ws://
```

本质仍然是：

```text
WebSocket
 ↓
TCP
```

所以底层 TCP 的：

```text
RTT
重传
拥塞控制
```

仍然会影响组网性能。

---

# 一百零六、一个推荐的 sysctl 文件写法

不要直接修改：

```text
/etc/sysctl.conf
```

里堆一大坨无说明参数。

更推荐单独：

```text
/etc/sysctl.d/90-tcp-tuning.conf
```

例如：

```conf
# ==========================================
# TCP tuning
#
# 修改原因：
# - 500Mbps 跨国链路
# - RTT ~180ms
# - 计算 BDP ~11.25MB
# - 原 buffer 上限导致单流吞吐不足
#
# 修改日期：YYYY-MM-DD
# ==========================================

net.core.rmem_max = 33554432
net.core.wmem_max = 33554432

net.ipv4.tcp_rmem = 4096 131072 33554432
net.ipv4.tcp_wmem = 4096 16384 33554432
```

关键不是文件名。

而是把：

```text
为什么改
```

写清楚。

---

# 一百零七、加载并验证

加载：

```bash
sysctl --system
```

再验证：

```bash
sysctl net.core.rmem_max
sysctl net.core.wmem_max
sysctl net.ipv4.tcp_rmem
sysctl net.ipv4.tcp_wmem
```

不要：

```text
配置写完
```

却不确认：

```text
实际是否生效
```

---

# 一百零八、修改前一定保存原始值

例如：

```bash
sysctl -a 2>/dev/null > /root/sysctl-before-tcp-tuning.txt
```

或者至少保存相关参数：

```bash
{
  sysctl net.ipv4.tcp_max_syn_backlog
  sysctl net.core.somaxconn
  sysctl net.ipv4.tcp_rmem
  sysctl net.ipv4.tcp_wmem
  sysctl net.core.rmem_max
  sysctl net.core.wmem_max
  sysctl net.ipv4.tcp_congestion_control
  sysctl net.ipv4.ip_local_port_range
  sysctl net.ipv4.tcp_tw_reuse
} > /root/tcp-before.txt
```

这样才能：

```text
随时回滚
```

---

# 一百零九、最终参数速查表

| 参数 | 主要作用 | 什么时候关注 |
|---|---|---|
| `net.ipv4.tcp_max_syn_backlog` | SYN_RECV 半连接请求上限 | 高新建连接率 |
| `net.core.somaxconn` | `listen()` backlog 内核上限 | Accept Queue 压力 |
| `net.ipv4.tcp_syncookies` | SYN 队列压力兜底 | SYN Flood / SYN 压力 |
| `net.ipv4.tcp_abort_on_overflow` | listener 过载时是否 RST | 特殊快速失败策略 |
| `net.core.netdev_max_backlog` | 内核输入侧包积压队列 | 高 PPS / 内核收包不及 |
| `net.ipv4.tcp_window_scaling` | 支持大于 64KB 的 TCP Window | 高 BDP 链路 |
| `net.ipv4.tcp_moderate_rcvbuf` | 自动调节 TCP 接收 buffer | 通常保持开启 |
| `net.ipv4.tcp_rmem` | TCP 接收 buffer min/default/max | 高 BDP |
| `net.ipv4.tcp_wmem` | TCP 发送 buffer min/default/max | 高 BDP |
| `net.core.rmem_max` | socket receive buffer 上限 | 大 buffer |
| `net.core.wmem_max` | socket send buffer 上限 | 大 buffer |
| `net.ipv4.tcp_congestion_control` | TCP 拥塞控制算法 | CUBIC / BBR 测试 |
| `net.ipv4.ip_local_port_range` | 自动分配临时端口范围 | 大量主动连接 |
| `net.ipv4.tcp_tw_reuse` | 安全条件下复用 TIME_WAIT | 谨慎，通常不要乱改 |
| `net.netfilter.nf_conntrack_max` | conntrack 最大条目 | NAT / Docker / 防火墙 |

---

# 一百一十、最容易混淆的概念总结

### 1. SYN Queue 和 Accept Queue

```text
SYN Queue
=
三次握手还没完成


Accept Queue
=
三次握手完成
但应用还没 accept
```

### 2. somaxconn 和 tcp_max_syn_backlog

```text
tcp_max_syn_backlog
→ 半连接


somaxconn
→ listen backlog / Accept Queue 上限
```

### 3. rwnd 和 cwnd

```text
rwnd
→ 接收方能力


cwnd
→ 网络拥塞能力
```

### 4. rmem/wmem 和 BDP

```text
BDP
→ 链路需要多少在途数据


rmem/wmem
→ 主机是否有足够 buffer 支撑
```

### 5. TIME_WAIT 和 tcp_fin_timeout

```text
tcp_fin_timeout
≠
TIME_WAIT 清理时间按钮
```

### 6. netdev backlog 和 TCP backlog

```text
netdev_max_backlog
→ TCP 之前的内核收包层


tcp_max_syn_backlog
→ TCP 半连接


somaxconn
→ listener Accept Queue
```

---

# 一百一十一、最终结论

Linux TCP 调优并不是：

```text
把所有参数调大
+
打开 BBR
=
网络变快
```

真正的 TCP 性能调优应该是：

```text
连接建立慢
→ 看 SYN Queue / Accept Queue


高并发连接失败
→ 看 backlog / accept / FD / conntrack


单 TCP 流跑不满
→ 看 RTT / BDP / rwnd / cwnd / buffer


高 RTT + 丢包
→ 再比较 CUBIC / BBR


大量短连接
→ 看连接池 / Keep-Alive / 临时端口 / TIME_WAIT


Docker / NAT 随机丢连接
→ 看 conntrack
```

最重要的是始终建立这种思维：

```text
参数只是解决具体瓶颈的工具
```

而不是：

```text
参数本身就是优化
```

如果：

```text
不知道瓶颈在哪里
```

那么最正确的动作不是：

```bash
sysctl -w ...
```

而是：

```bash
ss
nstat
iperf3
tcpdump
```

先把问题测出来。

---

## 相关阅读

- [TCP 协议详解：从三次握手到 SYN、ACK、PSH、FIN、RST 与重传](/posts/tcp-protocol-handshake-flags-troubleshooting/) — TCP 基础原理与抓包排障。
- [EasyTier 原生 TCP 握手失败排查：TCP 映射能连通，却吞掉二进制 Payload](/posts/easytier-tcp-mapping-binary-filter-troubleshooting/) — TCP 三次握手正常但 Payload 无法透传的真实案例。
- [EasyTier 虚拟 IP 延迟异常排查：OpenClash 透明代理的锅](/posts/easytier-latency-openclash-troubleshooting/) — 从真实网络路径定位 EasyTier 高延迟问题。

---

## 参考资料

本文涉及的 Linux 内核参数语义，以当前 Linux Kernel 官方文档为主要依据：

```text
Linux Kernel Documentation
- IP Sysctl
- /proc/sys/net
- Netfilter Conntrack Sysctl
```

BBR 部分同时参考：

```text
Google BBR 官方开源项目及文档
```

不同发行版、内核版本和厂商内核可能修改默认值，因此文章中的默认值只用于帮助理解，实际调优时始终以：

```bash
uname -r
sysctl <PARAMETER>
```

的本机结果为准。
