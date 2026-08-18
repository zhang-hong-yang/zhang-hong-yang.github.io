---
title: TCP 协议详解：从三次握手到 SYN、ACK、PSH、FIN、RST 与重传
description: 从抓包和网络排障角度系统理解 TCP：三次握手、四次挥手、SYN/ACK/PSH/FIN/RST 标志位、Seq/Ack 序列号、窗口、MSS、重传、TIME_WAIT，以及如何通过 tcpdump 判断连接究竟卡在哪一步。
date: 2026-08-18 14:21:00 +0800
categories: [教程, 网络]
tags: [TCP, 网络协议, tcpdump, Wireshark, SYN, ACK, PSH, RST, MSS, MTU, 排障]
order: 13
---

平时排查网络问题，经常会看到这样的抓包：

```text
Flags [S]
Flags [S.]
Flags [.]
Flags [P.]
Flags [F.]
Flags [R.]
```

如果只知道：

```text
SYN = 建连接
ACK = 确认
FIN = 断连接
```

其实还不够。

真正进行 TCP 排障时，更重要的是理解：

```text
为什么 SYN 成功不代表业务一定通
Seq 和 Ack 到底在确认什么
为什么同一个 PSH 包会反复出现
为什么 connect 成功但应用仍然 timeout
为什么 RST 和 FIN 完全不是一回事
为什么 MSS 和 MTU 会影响 TCP
TCP Proxy 和 DNAT 为什么会产生不同抓包现象
```

本文从抓包和实际排障角度，完整介绍 TCP 协议。

---

## 你将学到什么

- TCP 为什么是可靠传输协议
- TCP 三次握手到底做了什么
- SYN、ACK、PSH、FIN、RST 分别代表什么
- `tcpdump` 中 `[S.]`、`[P.]`、`[F.]` 的点号是什么意思
- Seq 和 Ack 序列号如何工作
- TCP 为什么需要重传
- 窗口、MSS、MTU 分别解决什么问题
- 为什么 TCP 建连成功后业务仍然可能失败
- FIN 与 RST 的区别
- TIME_WAIT 为什么存在
- 如何用 tcpdump 快速判断 TCP 故障点
- DNAT、TCP Proxy 对 TCP 行为有什么影响

---

# 一、TCP 是什么

TCP 全称：

```text
Transmission Control Protocol
```

中文通常叫：

```text
传输控制协议
```

TCP 位于：

```text
应用层
  ↓
TCP
  ↓
IP
  ↓
以太网 / Wi-Fi
```

例如：

```text
HTTP
SSH
MySQL
Redis
WebSocket
EasyTier TCP
```

很多应用协议都可以运行在 TCP 之上。

TCP 最大的特点是：

```text
面向连接
可靠传输
有序传输
流量控制
拥塞控制
```

它和 UDP 最大的区别之一，就是 TCP 会维护连接状态，并且会确认数据是否真正到达。

---

# 二、TCP 并不是“发一个包就完事”

假设客户端要发送：

```text
HELLO
```

TCP 并不是简单：

```text
客户端 → HELLO → 服务端
```

而是需要：

```text
建立连接
   ↓
发送数据
   ↓
确认数据
   ↓
必要时重传
   ↓
关闭连接
```

可以粗略理解成：

```text
客户端                           服务端
   |                                |
   | -------- 建立连接 -----------> |
   |                                |
   | -------- 发送数据 -----------> |
   |                                |
   | <-------- 确认收到 ----------- |
   |                                |
   | -------- 关闭连接 -----------> |
```

---

# 三、TCP Header 中最重要的字段

TCP 报文头中有很多字段，排障时最重要的通常有：

```text
Source Port
Destination Port

Sequence Number
Acknowledgment Number

Flags

Window Size

Checksum

Options
```

其中最常看的就是：

```text
Seq
Ack
Flags
Win
MSS
```

---

# 四、TCP Flags 是什么

TCP Header 中有多个控制标志位。

常见的有：

```text
SYN
ACK
PSH
FIN
RST
URG
ECE
CWR
```

平时排障最重要的是：

```text
SYN
ACK
PSH
FIN
RST
```

---

## TCP Header 控制标志位完整说明

TCP Header 中常见的控制标志位共有 8 个：

```text
CWR
ECE
URG
ACK
PSH
RST
SYN
FIN
```

它们本质上都是：

```text
1 bit 开关
```

也就是说每个标志位只有两种状态：

```text
0 = 未设置
1 = 已设置
```

一个 TCP Segment 可以同时设置多个标志位，例如：

```text
SYN + ACK

PSH + ACK

FIN + ACK

RST + ACK
```

下面是常见 TCP Flags 的完整含义。

| 标志位 | 英文全称                  | 主要含义                                                        | 常见使用场景                                     | tcpdump 常见显示       |
| ------ | ------------------------- | --------------------------------------------------------------- | ------------------------------------------------ | ---------------------- |
| `CWR`  | Congestion Window Reduced | 通知对端：发送方已经响应拥塞通知并降低拥塞窗口                  | ECN 拥塞控制                                     | `[W]` 或与其他标志组合 |
| `ECE`  | ECN-Echo                  | 告诉发送方网络出现了拥塞，或在 SYN 阶段协商 ECN 能力            | ECN 拥塞通知                                     | `[E]` 或与其他标志组合 |
| `URG`  | Urgent                    | 表示 Urgent Pointer 有效，当前 Segment 中包含“紧急数据”         | 老式 Telnet 等场景，现代应用较少使用             | `[U]`                  |
| `ACK`  | Acknowledgment            | 表示 Acknowledgment Number 有效，用于确认已经收到的数据         | 三次握手第三步、数据确认、FIN 确认等             | `[.]`                  |
| `PSH`  | Push                      | 提示接收端尽快把当前收到的数据交给上层应用                      | HTTP、SSH、数据库、EasyTier 等发送应用数据时常见 | `[P.]`                 |
| `RST`  | Reset                     | 立即重置 TCP 连接，不进行正常的关闭流程                         | 端口未监听、连接异常、主动拒绝                   | `[R]`、`[R.]`          |
| `SYN`  | Synchronize               | 同步初始序列号，用于建立 TCP 连接                               | TCP 三次握手                                     | `[S]`、`[S.]`          |
| `FIN`  | Finish                    | 表示发送方已经没有数据要发送，用于正常关闭一个方向的 TCP 字节流 | TCP 四次挥手                                     | `[F.]`                 |

其中日常网络排障最常见的是：

```text
SYN
ACK
PSH
FIN
RST
```

而：

```text
CWR
ECE
```

主要与：

```text
ECN（Explicit Congestion Notification，显式拥塞通知）
```

有关。

`URG` 在现代常规互联网应用中已经比较少见。

### 1. SYN：建立连接

```text
SYN = 1
```

表示：

```text
我要建立 TCP 连接，
并同步我的初始 Sequence Number。
```

典型：

```text
Flags [S]
```

### 2. ACK：确认

```text
ACK = 1
```

表示：

```text
TCP Header 中的 Acknowledgment Number 有效。
```

也就是：

```text
我已经收到你之前的数据，
下一次希望你从 Ack Number 指定的位置继续发送。
```

`tcpdump` 中：

```text
.
```

就是 ACK。

所以：

```text
Flags [.]
```

代表：

```text
ACK
```

而：

```text
Flags [P.]
```

代表：

```text
PSH + ACK
```

### 3. PSH：尽快交给应用

```text
PSH = 1
```

表示：

```text
当前 Segment 中通常包含应用层数据，
接收端 TCP 栈应尽快把已收到的数据交给应用程序。
```

例如：

```text
Flags [P.]
length 81
```

说明：

```text
PSH = 1
ACK = 1
TCP Payload = 81 bytes
```

### 4. FIN：正常结束发送

```text
FIN = 1
```

表示：

```text
我这一方向已经没有更多数据需要发送。
```

它属于：

```text
正常关闭 TCP
```

而不是异常断开。

常见：

```text
Flags [F.]
```

也就是：

```text
FIN + ACK
```

### 5. RST：立即重置连接

```text
RST = 1
```

表示：

```text
立即终止这个 TCP 连接。
```

例如：

```text
目标端口没有程序监听
防火墙主动 REJECT
应用程序异常 abort
连接状态已经不存在
```

都可能产生：

```text
RST
```

常见：

```text
Flags [R.]
```

### 6. URG：紧急数据

```text
URG = 1
```

表示：

```text
Urgent Pointer 字段有效。
```

TCP Header 中还有一个：

```text
Urgent Pointer
```

用于指出紧急数据的位置。

这个机制过去在：

```text
Telnet
rlogin
```

等协议中比较常见。

现代应用协议通常很少依赖 TCP URG。

### 7. ECE：显式拥塞通知

ECE：

```text
ECN-Echo
```

属于 TCP 的：

```text
ECN
```

机制。

传统 TCP 判断拥塞通常依赖：

```text
丢包
```

例如：

```text
网络拥塞
  ↓
路由器丢包
  ↓
TCP 发现 ACK 没回来
  ↓
降低发送速度
```

ECN 则允许网络设备在不直接丢包的情况下：

```text
给 IP 包打上“拥塞”标记
```

接收方再通过：

```text
ECE
```

告诉发送方：

```text
网络已经出现拥塞，
请降低发送速率。
```

### 8. CWR：已经降低拥塞窗口

CWR：

```text
Congestion Window Reduced
```

表示发送方收到 ECE 后，已经执行了拥塞控制：

```text
降低 Congestion Window
```

然后通过：

```text
CWR = 1
```

告诉对方：

```text
你的拥塞通知我收到了，
我已经降低发送速率。
```

ECN 流程可以简单理解为：

```text
网络出现拥塞
      ↓
IP 层标记 CE
      ↓
接收方发送 ECE
      ↓
发送方降低 Congestion Window
      ↓
发送 CWR
```

### Flags 可以组合使用

这些位并不是互斥的。

例如：

```text
SYN + ACK
```

表示：

```text
我同意建立连接
+
我确认收到了你的 SYN
```

`tcpdump`：

```text
[S.]
```

又例如：

```text
PSH + ACK
```

表示：

```text
这里有应用层数据
+
我也顺便确认你之前的数据
```

`tcpdump`：

```text
[P.]
```

再例如：

```text
FIN + ACK
```

表示：

```text
我要正常关闭我这一方向的连接
+
我也确认了你之前的数据
```

`tcpdump`：

```text
[F.]
```

因此看 TCP Flags 时不要只看单个字母，而应该把：

```text
Flags [...]
```

中的所有标志位一起理解。

---

# 五、tcpdump 中的 Flags 怎么看

`tcpdump` 通常会把 TCP Flags 简写成：

| tcpdump | 实际含义  |
| ------- | --------- |
| `[S]`   | SYN       |
| `[S.]`  | SYN + ACK |
| `[.]`   | ACK       |
| `[P.]`  | PSH + ACK |
| `[F.]`  | FIN + ACK |
| `[R]`   | RST       |
| `[R.]`  | RST + ACK |

这里最容易误解的是：

```text
.
```

在 tcpdump 中：

```text
. = ACK
```

因此：

```text
[P.]
```

不是单独 PSH。

而是：

```text
PSH + ACK
```

---

# 六、SYN：请求建立 TCP 连接

SYN 全称：

```text
Synchronize
```

它的主要作用之一是：

```text
同步 TCP 初始序列号
```

客户端第一次连接服务器：

```text
客户端 → 服务端
SYN
```

tcpdump 中：

```text
Flags [S]
```

例如：

```text
192.168.1.10.50000 > 10.0.0.1.443:
Flags [S],
seq 123456789,
win 65535
```

可以理解为客户端说：

```text
我要建立 TCP 连接。

我的初始序列号从：
123456789

开始。
```

---

# 七、为什么 TCP 需要 Sequence Number

TCP 是：

```text
字节流协议
```

不是简单按照“第几个包”确认。

TCP 更关心：

```text
第几个字节
```

例如：

```text
Seq = 1000
Length = 100
```

表示：

```text
这次发送从序列号 1000 开始的 100 字节
```

覆盖：

```text
1000 ~ 1099
```

下一段数据通常从：

```text
1100
```

开始。

---

# 八、ACK：确认已经收到数据

ACK 全称：

```text
Acknowledgment
```

它的意义是：

```text
我已经收到之前的数据，
下一次请从这个序列号继续发。
```

例如客户端发送：

```text
seq 1000:1081
length 81
```

说明发送：

```text
81 字节
```

服务端如果完整收到，通常回复：

```text
ack 1081
```

注意：

```text
Ack Number
```

表示的是：

```text
下一次期望收到的序列号
```

而不是：

```text
最后收到的那个序列号
```

---

# 九、一个简单的 Seq / Ack 示例

假设客户端：

```text
初始序列号 = 1000
```

发送 81 字节：

```text
seq 1000:1081
length 81
```

服务端完整收到后：

```text
ACK 1081
```

可以理解为：

```text
服务端：

1000 到 1080 我都收到了。

下一次请从：
1081

继续发。
```

这就是 TCP 可靠传输的基础之一。

---

# 十、为什么 SYN 本身也会占用一个序列号

TCP 中：

```text
SYN
FIN
```

虽然通常不携带普通应用数据，但它们会消耗一个 Sequence Number。

例如：

```text
SYN seq 1000
```

服务端回复：

```text
ACK 1001
```

而不是：

```text
ACK 1000
```

因为 SYN 自己占用了一个序列号。

FIN 也类似。

---

# 十一、TCP 三次握手

TCP 建立连接需要经典的：

```text
三次握手
```

过程：

```text
客户端                           服务端
   |                                |
   | -------- SYN ----------------> |
   |                                |
   | <----- SYN + ACK ------------- |
   |                                |
   | -------- ACK ----------------> |
   |                                |
   |       TCP 连接建立完成          |
```

---

# 十二、第一次握手：客户端发送 SYN

客户端：

```text
Flags [S]
```

例如：

```text
Client → Server

SYN
Seq = 1000
```

意思：

```text
我要建立连接。
我的初始序列号是 1000。
```

---

# 十三、第二次握手：服务端发送 SYN + ACK

服务器回复：

```text
Flags [S.]
```

也就是：

```text
SYN + ACK
```

例如：

```text
Server → Client

SYN
ACK

Seq = 5000
Ack = 1001
```

意思：

```text
你刚才的 SYN 我收到了。

我希望你下一次从 1001 开始。

同时我的初始序列号是 5000。
```

---

# 十四、第三次握手：客户端发送 ACK

客户端回复：

```text
Flags [.]
```

也就是：

```text
ACK
```

例如：

```text
Client → Server

Ack = 5001
```

意思：

```text
你的 SYN 我也收到了。

下一次你从 5001 开始发送。
```

至此：

```text
TCP Established
```

---

# 十五、为什么是三次握手，不是两次

如果只有：

```text
客户端 → SYN
服务端 → SYN+ACK
```

服务端并不知道：

```text
自己的 SYN 是否真的被客户端收到
```

第三次 ACK 可以确认：

```text
客户端 → 服务端方向可达
服务端 → 客户端方向也可达
双方初始序列号都已经确认
```

因此最终形成一个可靠的双向连接。

---

# 十六、三次握手成功意味着什么

三次握手成功只能证明：

```text
TCP 连接建立成功
```

它并不能百分之百证明：

```text
应用层协议一定正常
```

例如：

```text
SYN          ✅
SYN+ACK      ✅
ACK          ✅
```

但之后：

```text
HTTP 数据    ❌
MySQL 数据   ❌
EasyTier 数据 ❌
```

仍然可能发生。

这也是很多网络排障最容易误判的地方。

---

# 十七、为什么端口测试成功，业务还是可能失败

例如：

```powershell
Test-NetConnection 1.2.3.4 -Port 443
```

返回：

```text
TcpTestSucceeded : True
```

只能说明：

```text
TCP 三次握手基本成功
```

却不能证明：

```text
TLS 一定成功
HTTP 一定正常
后端应用一定正常
任意二进制 Payload 一定能透传
```

因此：

```text
端口通
```

和：

```text
业务通
```

是两个概念。

---

# 十八、PSH 是什么

PSH 全称：

```text
Push
```

tcpdump 中通常看到：

```text
[P.]
```

实际：

```text
PSH + ACK
```

它通常表示：

```text
这个 TCP Segment 中携带应用数据
并提示接收端尽快将数据交给上层应用
```

例如：

```text
Flags [P.]
length 81
```

可以理解为：

```text
TCP Header
+
81 字节应用 Payload
```

---

# 十九、PSH 不等于“这是一个独立消息”

这一点很重要。

TCP 是：

```text
Stream Protocol
```

也就是：

```text
字节流协议
```

应用写入：

```text
HELLO
WORLD
```

并不意味着对方一定按：

```text
HELLO

WORLD
```

两个独立 TCP 包收到。

可能是：

```text
HELLOWORLD
```

一次收到。

也可能被拆成：

```text
HE
LLOW
ORLD
```

多次收到。

因此应用协议必须自己定义：

```text
消息边界
```

例如：

```text
固定长度
长度字段
换行符
特殊分隔符
TLV
Protobuf
HTTP Content-Length
```

---

# 二十、TCP 为什么会重传

TCP 的目标之一是：

```text
可靠传输
```

如果发送端发出：

```text
Seq 1000:1081
Length 81
```

但是一直没有收到：

```text
ACK 1081
```

TCP 会认为：

```text
这段数据可能丢失了
```

于是重新发送：

```text
Seq 1000:1081
Length 81
```

---

# 二十一、怎么看 TCP 重传

抓包里如果不断看到：

```text
seq 1000:1081
length 81
```

重复出现：

```text
第一次
第二次
第三次
第四次
```

而 Sequence Number 完全一样：

```text
1000:1081
```

就高度说明：

```text
同一段数据正在重传
```

例如：

```text
13:00:00.000  P. seq 1000:1081 length 81
13:00:00.280  P. seq 1000:1081 length 81
13:00:00.600  P. seq 1000:1081 length 81
13:00:01.200  P. seq 1000:1081 length 81
```

这通常意味着：

```text
发送端没有收到对这 81 字节的有效 ACK
```

---

# 二十二、为什么 ACK 没回来

可能原因很多：

```text
数据本身在路上丢了
服务端没有收到
服务端回复 ACK 丢了
防火墙丢弃
NAT 状态异常
TCP Proxy 丢弃 Payload
DPI / 安全网关不转发
路由不对称
严重丢包
```

所以：

```text
看到重传
```

不代表：

```text
一定是发送端的问题
```

反而经常说明：

```text
发送端已经在尽力发送，
但对面没有确认。
```

---

# 二十三、FIN：正常关闭连接

FIN 全称：

```text
Finish
```

tcpdump 常见：

```text
[F.]
```

也就是：

```text
FIN + ACK
```

FIN 的含义：

```text
我这一方向已经没有数据要发送了。
```

注意：

TCP 是：

```text
全双工
```

因此：

```text
A 不再发送
```

不代表：

```text
B 也必须立即停止发送
```

所以 TCP 关闭通常需要四个步骤。

---

# 二十四、TCP 四次挥手

经典流程：

```text
客户端                           服务端
   |                                |
   | -------- FIN ----------------> |
   |                                |
   | <------- ACK ----------------- |
   |                                |
   | <------- FIN ----------------- |
   |                                |
   | -------- ACK ----------------> |
   |                                |
   |        连接彻底关闭             |
```

这就是：

```text
四次挥手
```

---

# 二十五、为什么关闭需要四次

因为 TCP 是：

```text
双向独立字节流
```

例如：

```text
客户端 → 服务端
```

这个方向关闭，并不代表：

```text
服务端 → 客户端
```

已经没有数据。

因此：

```text
FIN
```

实际上是关闭：

```text
一个方向
```

所以两边都需要各发一次 FIN。

---

# 二十六、RST：强制重置连接

RST 全称：

```text
Reset
```

表示：

```text
这个 TCP 连接立即终止
```

tcpdump：

```text
[R]
```

或者：

```text
[R.]
```

RST 比 FIN 更强硬。

FIN 类似：

```text
我正常结束了。
```

RST 更像：

```text
这个连接有问题，立即作废。
```

---

# 二十七、常见 RST 场景

### 1. 目标端口没人监听

例如：

```text
客户端 → SYN → Server:11010
```

如果服务器：

```text
11010 没有监听
```

可能直接回复：

```text
RST
```

表示：

```text
这个端口没有服务。
```

### 2. 防火墙主动 REJECT

有些防火墙不是：

```text
DROP
```

而是：

```text
REJECT
```

它可能主动发送：

```text
RST
```

### 3. 应用主动 abort

应用程序异常关闭 socket，也可能触发 RST。

### 4. TCP 状态已经不存在

例如收到一个属于旧连接的 TCP Segment，但本机已经没有这个连接状态，可能回复 RST。

---

# 二十八、DROP 和 RST 的区别

假设目标端口不允许访问。

### DROP

```text
客户端 → SYN

没有任何回复
```

客户端只能等：

```text
timeout
```

### REJECT / RST

```text
客户端 → SYN
客户端 ← RST
```

客户端很快得到：

```text
Connection refused
```

所以：

```text
timeout
```

与：

```text
connection refused
```

通常代表的网络现象并不一样。

---

# 二十九、ACK 为什么几乎到处都有

连接建立之后，大多数 TCP Segment 都会带：

```text
ACK
```

例如：

```text
[P.]
[F.]
[R.]
```

中的：

```text
.
```

就是 ACK。

因为 TCP 双向通信时：

```text
一边发送数据
同时也可以顺便确认另一边之前的数据
```

这种方式称为：

```text
Piggyback ACK
```

也就是把确认信息“顺便带上”。

---

# 三十、Window Size 是什么

TCP 还有一个非常重要的机制：

```text
接收窗口
```

抓包中经常看到：

```text
win 65535
```

它用于：

```text
流量控制
```

本质是接收方告诉发送方：

```text
我当前还能接收多少数据，
你不要一下给我塞太多。
```

---

# 三十一、为什么需要流量控制

假设：

```text
发送端网络 10Gbps
接收端应用处理能力 10Mbps
```

如果发送端无限发送：

```text
接收端 buffer 很快就会爆
```

所以接收端通过：

```text
TCP Window
```

告诉发送端：

```text
你最多先发这么多，
等我处理完再继续。
```

---

# 三十二、Window Scaling

早期 TCP Window 字段只有：

```text
16 bit
```

最大：

```text
65535 bytes
```

对于现代高速网络太小。

因此 TCP Options 中有：

```text
Window Scale
```

例如：

```text
wscale 8
```

表示窗口值还需要：

```text
左移 8 位
```

也就是乘：

```text
2^8 = 256
```

所以真实窗口可以远大于 65535。

---

# 三十三、MSS 是什么

MSS 全称：

```text
Maximum Segment Size
```

表示：

```text
TCP 单个 Segment 中，
最大可以携带多少 TCP Payload
```

典型 Ethernet：

```text
MTU = 1500
```

IPv4 Header：

```text
20 bytes
```

TCP Header：

```text
20 bytes
```

所以典型 MSS：

```text
1500 - 20 - 20
= 1460 bytes
```

因此经常在 SYN 中看到：

```text
mss 1460
```

---

# 三十四、MTU 和 MSS 的区别

MTU：

```text
Maximum Transmission Unit
```

针对的是：

```text
IP 层整个报文
```

MSS：

```text
Maximum Segment Size
```

针对的是：

```text
TCP Payload
```

可以简单理解：

```text
MTU
=
IP Header
+
TCP Header
+
TCP Payload
```

例如：

```text
1500
=
20 IP
+
20 TCP
+
1460 MSS
```

---

# 三十五、为什么 VPN、隧道环境 MSS 经常变小

如果外面还要封装：

```text
WireGuard
GRE
VXLAN
PPPoE
EasyTier
IPSec
```

原始数据外面还要再套一层 Header。

例如：

```text
原始 TCP 包
   ↓
VPN Header
   ↓
UDP
   ↓
IP
```

如果仍然硬塞 1500：

```text
就可能超过底层 MTU
```

所以经常需要：

```text
降低 MTU
调整 MSS
MSS Clamping
```

---

# 三十六、为什么 81B 小包失败通常不像 MTU 问题

如果一个 TCP Payload 只有：

```text
81 bytes
```

整个 IPv4 TCP 包可能也就：

```text
121 bytes 左右
```

远远小于：

```text
MTU 1500
```

所以：

```text
81B 数据完全丢失
```

通常很难用传统：

```text
MTU 太大
```

解释。

MTU 问题更常表现为：

```text
小包正常
大包失败

连接能建立
传大文件卡死

TLS ClientHello 之后异常

某些网站能开
某些网站卡住
```

---

# 三十七、TCP Checksum 是什么

TCP Header 中还有：

```text
Checksum
```

它用于检测：

```text
TCP Header
+
TCP Payload
```

是否在传输中出现错误。

如果 checksum 不正确，接收端可能直接丢弃。

---

# 三十八、为什么 tcpdump 经常显示 checksum incorrect

在 Linux 本机抓：

```bash
tcpdump
```

经常看到：

```text
cksum incorrect
```

但实际网络完全正常。

这通常是：

```text
Checksum Offload
```

导致的。

操作系统把包交给网卡时：

```text
TCP checksum 还没有最终计算
```

网卡在真正发出去之前才补上。

而 tcpdump 抓包发生在：

```text
网卡补 checksum 之前
```

因此看到：

```text
incorrect
```

这是很多场景下的正常现象。

---

# 三十九、TCP Keepalive 是什么

TCP Keepalive 用来检测：

```text
长时间空闲的连接是否还活着
```

例如：

```text
SSH
数据库连接池
长连接
```

长时间没有业务数据后，操作系统可能发送：

```text
Keepalive Probe
```

如果对方长期没有回复：

```text
认为连接失效
```

---

# 四十、TCP Timeout 不止一种

看到：

```text
timeout
```

时，要先搞清楚是哪一种。

可能是：

```text
SYN timeout
连接建立 timeout

Read timeout
已经连接，但读不到数据

Write timeout
发送受阻

Application handshake timeout
TCP 已经通，但上层协议握手失败
```

例如：

```text
EasyTier handshake timeout
```

并不等于：

```text
TCP 三次握手一定失败
```

完全可能是：

```text
TCP Established
   ↓
EasyTier Payload 发出
   ↓
对方没收到 / 没回复
   ↓
应用层 handshake timeout
```

---

# 四十一、TIME_WAIT 是什么

TCP 主动关闭连接的一方，关闭后通常会进入：

```text
TIME_WAIT
```

很多人第一次看到：

```bash
ss -ant
```

里面大量：

```text
TIME-WAIT
```

会以为系统出故障了。

其实 TIME_WAIT 本身是 TCP 正常设计。

---

# 四十二、为什么需要 TIME_WAIT

TIME_WAIT 主要有两个重要目的。

### 1. 确保最后一个 ACK 有机会重传

如果最后一个：

```text
ACK
```

丢失了，对方可能重新发送：

```text
FIN
```

TIME_WAIT 状态仍然存在，就可以再次回复 ACK。

### 2. 避免旧连接报文污染新连接

TCP 连接由：

```text
源 IP
源端口
目标 IP
目标端口
```

共同标识。

如果旧连接的延迟包还在网络中，而立刻复用相同四元组建立新连接，就可能产生混乱。

TIME_WAIT 给旧数据包足够时间自然消失。

---

# 四十三、TCP 四元组是什么

一个 TCP 连接通常由：

```text
Source IP
Source Port
Destination IP
Destination Port
```

唯一标识。

例如：

```text
192.168.1.100:52341
        ↓
1.2.3.4:443
```

这四个值就是：

```text
TCP 4-tuple
```

同一个客户端可以同时创建很多连接，是因为：

```text
源端口不同
```

---

# 四十四、为什么客户端源端口一直变化

例如：

```text
192.168.0.187:60378
192.168.0.187:60768
192.168.0.187:61628
```

这些通常属于：

```text
Ephemeral Port
```

也就是：

```text
临时源端口
```

操作系统每建立一个新的 TCP 连接，会自动分配一个临时源端口。

因此不同连接：

```text
源 IP 一样
目标 IP 一样
目标端口一样

但源端口不同
```

是完全正常的。

---

# 四十五、DNAT 对 TCP 做什么

DNAT：

```text
Destination Network Address Translation
```

也就是：

```text
目标地址转换
```

例如：

```text
公网：

1.2.3.4:55010

        ↓ DNAT

内网：

10.10.2.194:11010
```

传统 DNAT 主要修改：

```text
目标 IP
目标端口
```

同时维护 NAT 连接状态。

它通常不会关心：

```text
HTTP
SSH
EasyTier
随机二进制
```

里面具体是什么应用数据。

---

# 四十六、透明 DNAT 下的数据流

理想情况：

```text
客户端
   |
   | SYN
   v
DNAT
   |
   v
服务端
```

后续：

```text
ACK
PSH
Payload
FIN
```

也是透明转发。

因此正常 DNAT 理论上：

```text
ASCII           ✅
二进制          ✅
WebSocket       ✅
私有协议        ✅
```

只要 TCP 本身合法即可。

---

# 四十七、TCP Proxy 又是什么

TCP Proxy 和 DNAT 完全不同。

它可能实际上创建两条 TCP 连接：

```text
客户端
   |
   | TCP 连接 A
   v
TCP Proxy
   |
   | TCP 连接 B
   v
后端服务器
```

也就是说 Proxy 可以：

```text
自己回复 SYN/ACK
终止客户端 TCP
重新连接后端
读取 Payload
分析应用协议
执行安全规则
再决定是否转发
```

---

# 四十八、为什么 TCP Proxy 下 connect 成功但数据可能失败

例如：

```text
客户端 → Proxy
```

三次握手：

```text
SYN      ✅
SYN+ACK  ✅
ACK      ✅
```

客户端认为：

```text
TCP connected
```

然后发送：

```text
未知 binary protocol
```

Proxy 可能：

```text
读取
识别
判断
丢弃
```

于是：

```text
客户端 connect 成功
但后端没有收到 Payload
```

这在单纯 DNAT 下就不太常见。

---

# 四十九、PSH 被丢和 SYN 被丢有什么区别

### SYN 都过不去

抓包：

```text
SYN
SYN
SYN
...
```

没有 SYN+ACK。

优先排查：

```text
端口没开放
防火墙
路由
公网映射
服务没监听
```

### SYN 成功，PSH 不通

抓包：

```text
SYN       ✅
SYN+ACK   ✅
ACK       ✅
PSH       ✅
PSH 重传
PSH 重传
```

优先考虑：

```text
应用层问题
中间设备过滤
TCP Proxy
DPI
服务端应用没响应
后端链路问题
```

这两个故障层级完全不同。

---

# 五十、如何看一次典型成功连接

假设：

```text
Client → Server
```

抓包：

```text
[S]
[S.]
[.]
[P.]
[.]
[P.]
[.]
[F.]
[.]
[F.]
[.]
```

可以解释为：

```text
SYN
   ↓
SYN + ACK
   ↓
ACK
   ↓
连接建立

PSH + ACK
   ↓
发送应用数据

ACK
   ↓
确认收到

PSH + ACK
   ↓
另一批数据

ACK
   ↓
确认

FIN
   ↓
开始正常关闭

ACK
FIN
ACK
   ↓
连接结束
```

---

# 五十一、如何看一次“端口没开”

抓包：

```text
Client → Server
Flags [S]

Server → Client
Flags [R.]
```

通常表示：

```text
目标主机可达
但这个 TCP 端口没人监听
```

常见客户端错误：

```text
Connection refused
```

---

# 五十二、如何看一次“防火墙 DROP”

抓包：

```text
Client → Server
SYN

Client → Server
SYN 重传

Client → Server
SYN 重传
```

始终没有：

```text
SYN+ACK
RST
```

最终：

```text
timeout
```

这种情况很像：

```text
中间防火墙 DROP
路由黑洞
目标完全不可达
```

---

# 五十三、如何看一次“应用数据被丢”

抓包：

```text
SYN
SYN+ACK
ACK

PSH seq 1000:1081 length 81
PSH seq 1000:1081 length 81
PSH seq 1000:1081 length 81
```

同一个：

```text
seq 1000:1081
```

不断重复。

说明：

```text
TCP 已建立

但是这 81 字节一直没有得到有效 ACK
```

这就是非常典型的：

```text
建连成功
数据阶段失败
```

---

# 五十四、如何结合两端抓包定位故障

这是非常实用的方法。

假设客户端抓包：

```text
SYN       ✅
SYN+ACK   ✅
ACK       ✅
PSH 81B   ✅
```

服务器抓包：

```text
SYN       ✅
SYN+ACK   ✅
ACK       ✅
PSH 81B   ❌
```

那么可以非常明确地说：

```text
应用已经发送了数据

但数据在：

客户端出口
   ↓
中间网络
   ↓
服务器入口

之间消失了
```

这比只看：

```text
应用 timeout
```

有价值得多。

---

# 五十五、tcpdump 常用命令

抓指定端口：

```bash
tcpdump -ni any -nn tcp port 11010
```

抓指定主机：

```bash
tcpdump -ni any -nn host 1.2.3.4
```

同时限定主机和端口：

```bash
tcpdump -ni any -nn \
'host 1.2.3.4 and tcp port 11010'
```

显示时间：

```bash
tcpdump -ni any -nn -tttt tcp port 11010
```

抓完整包：

```bash
tcpdump -ni any -nn -s0 tcp port 11010
```

保存为 pcap：

```bash
tcpdump -ni any -nn -s0 \
-w /tmp/test.pcap \
tcp port 11010
```

---

# 五十六、Windows PktMon 常用命令

清除过滤器：

```powershell
pktmon filter remove
```

添加目标：

```powershell
pktmon filter add TCPTest -i <TARGET_IP> -p <PORT>
```

开始完整抓包：

```powershell
pktmon start --capture --pkt-size 0 --file-name D:\tcp-test.etl
```

停止：

```powershell
pktmon stop
```

转文本：

```powershell
pktmon etl2txt D:\tcp-test.etl `
  --out D:\tcp-test.txt `
  -x -v 3
```

如果需要 Wireshark：

```powershell
pktmon etl2pcap D:\tcp-test.etl `
  --out D:\tcp-test.pcapng
```

---

# 五十七、看 tcpdump 时最值得盯的字段

例如：

```text
192.168.0.187.61628 > 1.2.3.4.55010:
Flags [P.],
seq 1408665952:1408666033,
ack 4290657886,
win 255,
length 81
```

可以拆成：

```text
192.168.0.187
客户端 IP

61628
客户端临时源端口

1.2.3.4
服务端 IP

55010
目标端口

[P.]
PSH + ACK

seq 1408665952:1408666033
这次发送的数据序列范围

ack 4290657886
已经确认对方数据到这里

win 255
当前通告窗口

length 81
TCP Payload 为 81 字节
```

---

# 五十八、为什么 length 很重要

如果看到：

```text
Flags [.]
length 0
```

通常只是：

```text
纯 ACK
```

没有应用数据。

如果看到：

```text
Flags [P.]
length 81
```

说明：

```text
这个 Segment 中携带 81 字节 TCP Payload
```

排障时可以快速区分：

```text
控制包
```

和：

```text
真正的应用数据包
```

---

# 五十九、SACK 是什么

SACK：

```text
Selective Acknowledgment
```

也就是：

```text
选择性确认
```

假设发送：

```text
1
2
3
4
5
```

其中：

```text
3 丢了
```

传统累计 ACK 只能说：

```text
我连续收到 1、2
```

而 SACK 可以额外告诉发送端：

```text
4、5 其实已经到了
```

这样发送端只需要重点补：

```text
3
```

提高丢包环境下的效率。

SACK 支持通常在 SYN Options 里协商。

---

# 六十、TCP 是有序的

TCP 给应用层保证：

```text
按顺序交付字节流
```

即使网络中：

```text
Segment 2
```

比：

```text
Segment 1
```

先到。

TCP 也会尽量：

```text
先缓存 Segment 2
等 Segment 1 到达
再按顺序交给应用
```

因此 TCP 很适合：

```text
文件传输
SSH
HTTP
数据库
```

这类不能乱序的业务。

---

# 六十一、可靠不等于永不失败

TCP 叫：

```text
可靠传输
```

不是说：

```text
数据绝对不会丢
连接绝对不会断
```

而是说 TCP 会：

```text
检测丢包
重传
排序
去重
确认
流量控制
拥塞控制
```

如果网络一直坏：

```text
TCP 最终仍然会 timeout
```

可靠的意思是：

```text
TCP 尽力保证应用看到的是完整、有序的数据，
失败时也会明确表现为连接错误，而不是悄悄乱序交付。
```

---

# 六十二、TCP 和 UDP 的核心差别

| 特性           | TCP               | UDP                       |
| -------------- | ----------------- | ------------------------- |
| 是否建立连接   | 是                | 否                        |
| 是否有 SYN/ACK | 是                | 否                        |
| 是否保证顺序   | 是                | 否                        |
| 是否自动重传   | 是                | 否                        |
| 是否有流量控制 | 是                | 否                        |
| 是否有拥塞控制 | 是                | 通常由应用自己处理        |
| Header 开销    | 较高              | 较低                      |
| 典型场景       | HTTP、SSH、数据库 | DNS、实时音视频、部分 VPN |

UDP 更像：

```text
我把这个 Datagram 发出去
至于是否收到，由应用自己决定怎么办
```

TCP 则是：

```text
我维护一个连接和字节流，
负责确认、排序、重传。
```

---

# 六十三、WebSocket 和 TCP 是什么关系

WebSocket 不是 TCP 的替代品。

通常：

```text
WebSocket
   ↓
TCP
```

建立过程：

```text
TCP 三次握手
   ↓
HTTP Upgrade
   ↓
WebSocket
   ↓
WebSocket Frame
```

所以：

```text
ws://
```

本质仍然使用 TCP。

区别只是应用层数据格式发生了变化。

---

# 六十四、HTTPS 和 TCP 的关系

传统 HTTPS：

```text
HTTP
 ↓
TLS
 ↓
TCP
 ↓
IP
```

建立连接：

```text
TCP 三次握手
   ↓
TLS Handshake
   ↓
HTTP Request
```

所以：

```text
443 端口 TCP connect 成功
```

并不能说明：

```text
TLS 一定成功
```

更不能说明：

```text
HTTP 一定成功
```

---

# 六十五、为什么抓包排障一定要分层

一个典型网络问题应该分层看：

```text
第一层：
IP 是否可达

第二层：
TCP 是否建立

第三层：
TCP Payload 是否送达

第四层：
TLS / WebSocket / 数据库协议是否成功

第五层：
业务逻辑是否正常
```

不要看到：

```text
ping 通
```

就直接认为：

```text
TCP 正常
```

也不要看到：

```text
TCP connect 成功
```

就认为：

```text
应用正常
```

---

# 六十六、一个非常实用的 TCP 排障判断表

| 抓包现象                         | 优先怀疑                        |
| -------------------------------- | ------------------------------- |
| 只有 SYN，没有任何响应           | 防火墙 DROP、路由、服务端不可达 |
| SYN 后马上 RST                   | 端口未监听、REJECT              |
| SYN/SYN+ACK/ACK 正常             | TCP 建连成功                    |
| 建连后没有任何 Payload           | 应用没发送                      |
| 客户端有 PSH，服务端没有         | 中间链路、NAT、Proxy、过滤      |
| PSH 同 seq 不断重传              | 没收到有效 ACK                  |
| 服务端收到 PSH，但不回复应用数据 | 服务端应用层问题                |
| 很快出现 RST                     | 主动拒绝、异常关闭              |
| FIN/ACK 正常完成                 | 正常关闭                        |
| 小包正常、大包失败               | MTU/MSS/PMTUD 优先检查          |

---

# 六十七、看到 SYN 重传时怎么判断

例如：

```text
SYN
1 秒后 SYN
2 秒后 SYN
4 秒后 SYN
```

说明：

```text
客户端一直没有收到有效 SYN+ACK
```

此时不要先去查：

```text
HTTP
TLS
EasyTier handshake
```

因为：

```text
TCP 连接都还没有建立
```

应该先查：

```text
服务是否监听
防火墙
路由
端口映射
安全组
NAT
```

---

# 六十八、看到 PSH 重传时怎么判断

例如：

```text
SYN       ✅
SYN+ACK   ✅
ACK       ✅

PSH 81B
PSH 81B
PSH 81B
```

说明：

```text
连接已经建立
应用也已经发送数据

问题发生在数据确认阶段
```

此时检查：

```text
服务端是否收到
中间设备是否丢包
服务端是否 ACK
NAT / Proxy 状态
```

---

# 六十九、最有效的办法：两端同时抓

只在客户端抓：

```text
看到发送
```

不知道：

```text
服务端有没有收到
```

只在服务端抓：

```text
没看到数据
```

不知道：

```text
客户端到底有没有发
```

所以最好：

```text
客户端抓包
+
服务端抓包
```

然后对比：

```text
Seq
Ack
Length
时间戳
源端口
目标端口
```

这样可以把故障点非常准确地夹出来。

---

# 七十、总结 TCP 建连、传输、关闭的完整生命周期

整个 TCP 生命周期可以浓缩为：

```text
1. 建立连接

SYN
 ↓
SYN + ACK
 ↓
ACK


2. 发送数据

PSH + ACK + Payload
 ↓
ACK


3. 丢包时

Payload
 ↓
没有 ACK
 ↓
重传


4. 正常关闭

FIN
 ↓
ACK
 ↓
FIN
 ↓
ACK


5. 异常关闭

RST
```

---

# 七十一、最值得记住的几条规则

第一条：

```text
[S]
=
我要建立连接
```

第二条：

```text
[S.]
=
我同意建立连接，并确认你的 SYN
```

第三条：

```text
[.]
=
ACK
```

第四条：

```text
[P.]
=
PSH + ACK
通常携带应用层数据
```

第五条：

```text
[F.]
=
正常关闭
```

第六条：

```text
[R.]
=
强制重置
```

第七条：

```text
同一个 Seq 的 Payload 反复出现
=
TCP 正在重传
```

第八条：

```text
三次握手成功
≠
业务一定正常
```

第九条：

```text
客户端有 Payload
服务端没有 Payload
=
问题在两端之间
```

第十条：

```text
小包正常、大包异常
优先检查 MTU / MSS
```

---

# 七十二、最终结论

理解 TCP 最重要的不是背定义，而是能够看到一段抓包后，快速还原：

```text
连接有没有建立
谁主动发起
谁在确认
有没有应用数据
数据有没有被 ACK
有没有重传
是谁主动关闭
是正常 FIN 还是异常 RST
```

例如：

```text
[S]
[S.]
[.]
[P.]
[P.]
[P.]
```

看到这种序列，就应该马上想到：

```text
TCP 已经成功建立

应用发送了 Payload

但是同一段 Payload 没有得到有效确认

因此 TCP 正在重传
```

这比只看应用日志中的：

```text
timeout
```

更接近真正的故障位置。

网络排障最有效的方法始终是：

```text
先确认层级
再确认方向
最后确认数据到底在哪一跳消失
```

一旦理解：

```text
SYN
ACK
PSH
FIN
RST
Seq
Ack
MSS
Window
Retransmission
```

再看 `tcpdump`、Wireshark、PktMon 时，TCP 就不再是一堆看不懂的数字，而是一段可以直接读出来的“网络对话”。

---

## 相关阅读

- [EasyTier 原生 TCP 握手失败排查：TCP 映射能连通，却吞掉二进制 Payload](/posts/easytier-tcp-mapping-binary-filter-troubleshooting/) — 实战分析 TCP 三次握手成功、但应用层二进制 Payload 在映射链路中消失的问题。
- [EasyTier 虚拟 IP 延迟异常排查：OpenClash 透明代理的锅](/posts/easytier-latency-openclash-troubleshooting/) — 从真实来源 IP 和链路角度定位透明代理导致的 EasyTier 延迟异常。
