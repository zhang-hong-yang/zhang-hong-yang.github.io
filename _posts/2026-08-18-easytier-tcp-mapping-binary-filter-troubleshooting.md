---
title: EasyTier 原生 TCP 握手失败排查：TCP 映射能连通，却吞掉二进制 Payload
description: EasyTier 通过公网 TCP 端口映射时三次握手正常，但原生 TCP 一直 handshake timeout，而 WebSocket 却能正常组网。本文记录一次从 PktMon、tcpdump、nc 到 Payload 重放的完整排查，并定位到平台 TCP 映射疑似存在应用层协议识别或二进制流量过滤。
date: 2026-08-18 14:08:00 +0800
categories: [教程, 网络]
tags: [EasyTier, TCP, WebSocket, DNAT, DPI, 端口映射, 排障, PktMon, tcpdump]
order: 12
---

EasyTier 通过一个公网 TCP 端口映射连接 VPS 时，遇到了一个非常反常的问题：

```text
TCP 三次握手：成功
普通文本 TCP：成功
EasyTier 原生 TCP：handshake timeout
EasyTier over WebSocket：成功
```

一开始很容易怀疑 EasyTier 版本、MTU、MSS、Windows 防火墙、Clash、TCP 首包发送过快，甚至怀疑服务端配置错误。

但经过抓包、原始 TCP 测试、二进制 Payload 重放后，最终得到了一条很完整的证据链：

> **当前平台提供的 TCP 映射并不像完全透明的四层 DNAT，而更像经过了 TCP Proxy、应用层协议识别、安全检测或其他内容过滤。**
>
> 可打印 ASCII 数据可以正常透传，但随机二进制、全 `0x00`、全 `0xFF` 以及 EasyTier 原生二进制握手 Payload 都无法到达后端；使用 WebSocket 封装后则可以正常连接。

本文完整记录这次排查过程。

> 说明：为了避免泄露真实公网地址、端口和组网密钥，本文统一使用 `<PUBLIC_MAPPING_IP>`、`<PUBLIC_TCP_PORT>`、`<VPS_TCP_PORT>` 等占位符。

## 你将学到什么

- 为什么 TCP 端口能 `connect`，不代表应用数据一定能透传
- 如何区分 EasyTier 本身故障和公网端口映射故障
- 如何用 Windows `PktMon` 确认 EasyTier 是否真的发出了握手 Payload
- 如何用 Linux `tcpdump` 判断 Payload 是否真正到达 VPS
- 如何使用 `nc` 和 PowerShell 构造不同类型的 TCP Payload
- 如何通过原样重放 EasyTier Payload 验证是否存在内容过滤
- DNAT、TCP Proxy 与应用层协议识别之间有什么区别
- 为什么 EasyTier 原生 `tcp://` 失败，而 `ws://` 可以正常工作
- 在只能使用 TCP 映射的平台上应该如何部署 EasyTier

---

## 一、问题背景

网络结构大致如下：

```text
Windows EasyTier
      |
      | TCP
      v
<PUBLIC_MAPPING_IP>:<PUBLIC_TCP_PORT>
      |
      | 平台 TCP 端口映射
      v
VPS:<VPS_TCP_PORT>
      |
      v
EasyTier Server
```

服务端 EasyTier 监听：

```text
tcp://0.0.0.0:<VPS_TCP_PORT>
```

Windows 客户端配置：

```toml
[[peer]]
uri = "tcp://<PUBLIC_MAPPING_IP>:<PUBLIC_TCP_PORT>"
```

但客户端一直出现类似：

```text
connect tcp start
waiting for handshake request from server
handshake timeout
```

与此同时：

```powershell
Test-NetConnection <PUBLIC_MAPPING_IP> -Port <PUBLIC_TCP_PORT>
```

却显示：

```text
TcpTestSucceeded : True
```

也就是说：

```text
TCP 端口能建立连接
EasyTier 却无法完成握手
```

---

## 二、一个重要背景：平台的端口映射模式发生过变化

这个平台以前提供：

```text
TCP + UDP 端口映射
```

当时 EasyTier 原生 TCP 可以正常使用。

后来平台调整为只提供：

```text
TCP 端口映射
```

之后出现了：

```text
EasyTier tcp://    失败
EasyTier ws://     成功
```

因此从一开始就需要考虑一种可能：

> 平台虽然仍然叫“TCP 端口映射”，但底层实现可能已经发生变化。

以前可能是：

```text
公网
 ↓
L4 NAT / DNAT
 ↓
VPS
```

现在则可能变成：

```text
公网
 ↓
TCP Proxy / 安全网关
 ↓
协议识别或内容检查
 ↓
VPS
```

---

## 三、先排除 EasyTier 客户端和版本问题

首先确认同一台 Windows、同一套 EasyTier 客户端配置，连接另一台普通 VPS 上的 EasyTier 服务端可以正常工作。

结果：

```text
Windows EasyTier → 另一台 VPS：正常
Windows EasyTier → 当前 TCP 映射平台：失败
```

又分别测试了不同 EasyTier 版本，现象一致。

因此基本排除：

```text
EasyTier 单一版本 bug
Windows EasyTier 本机故障
配置文件语法导致完全无法连接
```

问题范围开始集中到：

```text
Windows
    ↓
公网 TCP 映射平台
    ↓
VPS
```

这一段。

---

## 四、普通 TCP 连接是否真的能透传

先停止 VPS 上的 EasyTier，让 `nc` 直接监听后端端口：

```bash
rc-service easytier stop
pkill -f easytier-core 2>/dev/null

busybox nc -l -p <VPS_TCP_PORT>
```

Windows 直接用 PowerShell 建立 TCP 连接并发送字符串：

```powershell
$c = [Net.Sockets.TcpClient]::new()
$c.Connect("<PUBLIC_MAPPING_IP>", <PUBLIC_TCP_PORT>)

$s = $c.GetStream()

$data = [Text.Encoding]::UTF8.GetBytes("HELLO_EASYTIER_TEST`n")

$s.Write($data, 0, $data.Length)
$s.Flush()

Start-Sleep -Seconds 2

$s.Close()
$c.Close()
```

VPS 可以正常收到：

```text
HELLO_EASYTIER_TEST
```

继续测试更大的 ASCII 数据：

```text
78B       正常
1000B     正常
1400B     正常
2000B     正常
```

这一步可以先排除：

```text
TCP 端口完全不通
简单的 MTU 问题
只能传很小数据包
公网端口映射配置完全错误
```

> BusyBox 的 `nc -l` 通常是一次性监听。每完成一次连接后进程会退出，下一轮测试前需要重新启动。

---

## 五、抓 Windows：EasyTier 到底有没有发出数据

仅仅看到：

```text
handshake timeout
```

还不能判断是：

```text
EasyTier 没发
```

还是：

```text
EasyTier 发了，但中间被丢了
```

因此在 Windows 上使用 `PktMon` 抓包。

先添加过滤器：

```powershell
pktmon filter remove
pktmon filter add EasyTier -i <PUBLIC_MAPPING_IP> -p <PUBLIC_TCP_PORT>
```

开始完整抓包：

```powershell
pktmon start --capture --pkt-size 0 --file-name D:\easytier.etl
```

让 EasyTier 尝试连接几次，然后：

```powershell
pktmon stop
```

转换为带十六进制内容的文本：

```powershell
pktmon etl2txt D:\easytier.etl `
  --out D:\easytier-hex.txt `
  -x -v 3
```

抓包中可以看到完整 TCP 三次握手：

```text
Windows → 映射地址   SYN
Windows ← 映射地址   SYN,ACK
Windows → 映射地址   ACK
```

随后 Windows 立即发出了 EasyTier 的第一个应用层数据包：

```text
Flags [P.]
length 81
```

之后同一个 TCP sequence 的 81 字节不断重传：

```text
第一次发送     81B
第一次重传     81B
第二次重传     81B
第三次重传     81B
...
```

这说明：

> **EasyTier 确实已经把握手数据交给 Windows TCP 栈，并且数据包已经从 Windows 发出。**

由于一直没有收到对应 ACK，Windows 才会不断重传。

因此可以排除：

```text
EasyTier 没调用 send
EasyTier 没有写 socket
Windows TCP 栈没有发送
```

---

## 六、抓 VPS：后端到底有没有收到 EasyTier Payload

与此同时，在 VPS 上抓：

```bash
tcpdump -ni any -nn -tttt -s0 \
'host <CLIENT_PUBLIC_IP> and tcp port <VPS_TCP_PORT>'
```

服务端可以看到：

```text
SYN
SYN,ACK
ACK
```

说明平台确实把 TCP 建连过程转发到了 VPS。

但是关键问题出现了：

```text
Windows 抓包：

SYN       ✅
SYN,ACK   ✅
ACK       ✅
PSH 81B   ✅


VPS 抓包：

SYN       ✅
SYN,ACK   ✅
ACK       ✅
PSH 81B   ❌
```

也就是说：

> Windows 已经发送的 EasyTier 应用层 Payload，在进入 VPS 之前消失了。

这一步非常关键，它把故障位置从：

```text
EasyTier 应用本身
```

缩小到了：

```text
Windows 出口
        ↓
公网 TCP 映射平台 / 中间网络
        ↓
VPS
```

---

## 七、是不是首包发送得太快

EasyTier 的行为比较激进。

TCP 三次握手完成后，几乎马上发送第一个握手包。

抓包中可以看到：

```text
ACK 完成
 ↓
约亚毫秒级
 ↓
EasyTier 发送首个 Payload
```

因此一度怀疑：

> 平台 TCP Proxy 是否先给客户端回了 SYN/ACK，但后端连接状态还没准备好，导致太早发送的首包被丢弃？

为了验证，使用 PowerShell 分别测试：

```text
TCP Connect 后立即发送 78B
TCP Connect 后等待 500ms 再发送 78B
```

服务端两次都收到：

```text
78 /tmp/nc-test.bin
```

因此：

```text
立即发送        ✅
延迟 500ms      ✅
```

可以基本排除：

```text
首包发送过快
TCP Proxy 后端建立存在明显 race
```

---

## 八、是不是 EasyTier Payload 本身被识别

这时候出现了一个更值得怀疑的方向：

```text
普通 ASCII TCP       ✅
EasyTier 二进制 TCP   ❌
```

于是从 Windows `PktMon` 抓包中提取了 EasyTier 的原始应用层 Payload。

当次 EasyTier 首包长度为：

```text
81 bytes
```

然后停止 EasyTier，在 VPS 上改用：

```bash
rm -f /tmp/easytier-replay.bin
busybox nc -l -p <VPS_TCP_PORT> > /tmp/easytier-replay.bin
```

Windows 使用普通 `TcpClient`，将抓包中的 EasyTier Payload **原样重放**：

```powershell
$hex = "<EASYTIER_PAYLOAD_HEX>"

$buf = New-Object byte[] ($hex.Length / 2)

for ($i = 0; $i -lt $buf.Length; $i++) {
    $buf[$i] = [Convert]::ToByte(
        $hex.Substring($i * 2, 2),
        16
    )
}

$c = [Net.Sockets.TcpClient]::new()

try {
    $c.Connect("<PUBLIC_MAPPING_IP>", <PUBLIC_TCP_PORT>)
    $s = $c.GetStream()

    $s.Write($buf, 0, $buf.Length)
    $s.Flush()

    Start-Sleep -Seconds 2
}
finally {
    if ($s) { $s.Close() }
    if ($c) { $c.Close() }
}
```

服务端检查：

```bash
wc -c /tmp/easytier-replay.bin
```

结果：

```text
0 /tmp/easytier-replay.bin
```

也就是说：

```text
EasyTier 程序发送原始 Payload        ❌
普通 TcpClient 重放同样 Payload      ❌
```

这一步非常重要。

它说明问题已经不是：

```text
EasyTier 特殊 socket API
EasyTier runtime
EasyTier TCP 实现
```

而是与：

```text
传输的数据内容特征
```

高度相关。

---

## 九、继续验证：是不是只针对 EasyTier

如果只测试 EasyTier Payload，还不能排除平台是不是专门针对 EasyTier 做了协议识别。

因此继续构造不同的数据。

### 1. 随机二进制 81B

Windows：

```powershell
$c = [Net.Sockets.TcpClient]::new()
$c.Connect("<PUBLIC_MAPPING_IP>", <PUBLIC_TCP_PORT>)

$s = $c.GetStream()

$buf = New-Object byte[] 81
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
$rng.GetBytes($buf)

$s.Write($buf, 0, $buf.Length)
$s.Flush()

Start-Sleep -Seconds 2

$s.Close()
$c.Close()
```

VPS：

```bash
wc -c /tmp/random.bin
```

结果：

```text
0 /tmp/random.bin
```

因此：

```text
随机二进制       ❌
EasyTier binary  ❌
```

说明并不像是单独针对 EasyTier。

---

## 十、测试 `0x00`、`0xFF` 与 ASCII

为了判断是否存在简单的“非文本字符过滤”，继续测试。

### 1. 80 个 `A` + 1 个 `0x00`

Windows：

```powershell
$buf = New-Object byte[] 81

for ($i = 0; $i -lt 81; $i++) {
    $buf[$i] = 0x41
}

$buf[80] = 0x00
```

发送后，VPS 收到：

```text
81 /tmp/test.bin
```

说明：

```text
只要出现 0x00 就丢弃
```

这个假设是错误的。

### 2. 81 个 `0x00`

```powershell
$buf = New-Object byte[] 81
```

结果：

```text
0 /tmp/zero.bin
```

### 3. 81 个 `0xFF`

```powershell
$buf = New-Object byte[] 81

for ($i = 0; $i -lt 81; $i++) {
    $buf[$i] = 0xFF
}
```

结果：

```text
0 /tmp/ff.bin
```

因此平台不是简单检查：

```text
是否包含 0x00
```

更像是在观察：

```text
整段 Payload 的整体特征
```

---

## 十一、最后一个关键实验：随机可打印 ASCII

再构造一段：

```text
长度 81B
内容随机
但全部来自可打印 ASCII
```

Windows：

```powershell
$chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"

$buf = New-Object byte[] 81
$r = New-Object System.Random

for ($i = 0; $i -lt $buf.Length; $i++) {
    $buf[$i] = [byte][char]$chars[$r.Next(0, $chars.Length)]
}

Write-Host ([Text.Encoding]::ASCII.GetString($buf))

$c = [Net.Sockets.TcpClient]::new()
$c.Connect("<PUBLIC_MAPPING_IP>", <PUBLIC_TCP_PORT>)

$s = $c.GetStream()
$s.Write($buf, 0, $buf.Length)
$s.Flush()

Start-Sleep -Seconds 2

$s.Close()
$c.Close()
```

VPS：

```bash
wc -c /tmp/ascii-random.bin
cat /tmp/ascii-random.bin
```

结果：

```text
81 /tmp/ascii-random.bin
```

而且 `cat` 可以完整看到随机 ASCII 字符串。

至此测试矩阵已经非常清楚。

---

## 十二、完整测试矩阵

| 测试内容 | 结果 |
|---|---|
| 普通 ASCII 文本 | ✅ |
| 78B ASCII | ✅ |
| 1000B ASCII | ✅ |
| 1400B ASCII | ✅ |
| 2000B ASCII | ✅ |
| 81B 随机可打印 ASCII | ✅ |
| 80 × `A` + 1 × `0x00` | ✅ |
| 81 × `0x00` | ❌ |
| 81 × `0xFF` | ❌ |
| 81B 随机二进制 | ❌ |
| EasyTier 原始 81B Payload | ❌ |
| 修改过首字节的 EasyTier Payload | ❌ |
| EasyTier 原生 `tcp://` | ❌ |
| EasyTier `ws://` | ✅ |

这组结果说明：

```text
不是：
TCP 端口不通

不是：
包太大

不是：
MTU

不是：
首包发太快

不是：
Windows 没发送

不是：
EasyTier 版本 bug

也不像：
专门封锁 EasyTier
```

而是高度符合：

```text
TCP 映射中存在应用层流量分类 / 协议识别 / 安全检测
```

---

## 十三、DNAT 是什么，为什么正常 DNAT 不应该这样

DNAT 全称：

```text
Destination Network Address Translation
```

也就是：

```text
目标地址转换
```

例如：

```text
客户端访问：

<PUBLIC_MAPPING_IP>:<PUBLIC_TCP_PORT>

              ↓ DNAT

实际改写为：

<VPS_PRIVATE_IP>:<VPS_TCP_PORT>
```

传统透明 DNAT 主要处理：

```text
IP
端口
连接状态
```

它通常不会关心 TCP Payload 到底是什么。

因此如果只是单纯 DNAT，理论上应该：

```text
ASCII              ✅
随机二进制          ✅
EasyTier binary     ✅
WebSocket           ✅
```

可以简单理解为：

```text
客户端 ─────────────────────→ VPS
           ↑
       只改目标 IP/端口
       不理解应用内容
```

而 TCP Proxy 则完全不同：

```text
客户端 → TCP Proxy → VPS
             ↑
         可以终止 TCP
         可以检查内容
         可以识别协议
         可以执行安全策略
```

因此当前平台的现象明显更接近第二种。

---

## 十四、为什么三次握手成功，Payload 却可以消失

很多时候我们会认为：

```text
TCP connect 成功 = TCP 通了
```

实际上这句话只对了一半。

如果中间存在 TCP Proxy：

```text
Windows
   |
   | TCP #1
   v
平台 Proxy
   |
   | TCP #2
   v
VPS
```

Windows 看到的 SYN/ACK 有可能是：

```text
平台 Proxy 返回的
```

而不是 VPS TCP 栈直接返回的。

于是完全可能发生：

```text
1. 客户端和 Proxy 三次握手成功
2. Proxy 和 VPS 也建立连接
3. 客户端发送应用 Payload
4. Proxy 对 Payload 做检查
5. Proxy 决定不转发这段数据
```

因此会表现成：

```text
Connect() 成功
Test-NetConnection 成功
服务端也看到 TCP 建连

但应用层数据仍然无法正常传递
```

这也是这次问题最容易误导人的地方。

---

## 十五、为什么 WebSocket 可以正常连接

EasyTier 原生 TCP 大致是：

```text
TCP 建连
   ↓
EasyTier 私有二进制握手
   ↓
后续 EasyTier 数据
```

当前平台表现为：

```text
TCP
 ↓
EasyTier binary
 ↓
平台协议识别 / 安全检测
 ↓
❌
```

而 WebSocket 不一样。

EasyTier 使用：

```text
ws://
```

时，首先出现的是标准 HTTP WebSocket Upgrade：

```text
GET / HTTP/1.1
Host: ...
Upgrade: websocket
Connection: Upgrade
...
```

平台看到的是一个标准 WebSocket 连接：

```text
TCP
 ↓
HTTP Upgrade
 ↓
WebSocket established
 ↓
EasyTier binary 被封装在 WebSocket frame 中
 ↓
✅
```

所以 WebSocket 并没有绕开 TCP。

实际仍然是：

```text
WebSocket
   ↓
TCP
```

区别只是：

> EasyTier 原始二进制协议被包装成了平台能够正常接受和识别的标准 WebSocket 协议。

---

## 十六、最终解决方案：改用 WebSocket

既然当前平台只提供 TCP 映射，并且 `ws://` 已经验证稳定可用，那么没有必要继续强行使用原生：

```text
tcp://
```

### VPS 服务端

保留 WebSocket listener：

```toml
listeners = [
    "ws://0.0.0.0:11011/",
]
```

如果还需要 VPS 内部或其他网络直连，也可以同时保留其他 listener：

```toml
listeners = [
    "udp://0.0.0.0:11010",
    "tcp://0.0.0.0:11010",
    "wg://0.0.0.0:11011",
    "ws://0.0.0.0:11011/",
]
```

### 平台 TCP 映射

例如：

```text
<PUBLIC_WS_PORT>/TCP
        ↓
VPS 11011/TCP
```

### Windows 客户端

```toml
[[peer]]
uri = "ws://<PUBLIC_MAPPING_IP>:<PUBLIC_WS_PORT>/"
```

然后重启 EasyTier。

---

## 十七、建议的排查流程

如果以后遇到类似：

```text
TCP connect 成功
应用协议却 timeout
```

建议按照下面的顺序排查。

### 第一步：验证纯 TCP

服务端：

```bash
busybox nc -l -p <PORT>
```

客户端：

```powershell
$c = [Net.Sockets.TcpClient]::new()
$c.Connect("<IP>", <PORT>)

$s = $c.GetStream()

$data = [Text.Encoding]::ASCII.GetBytes("HELLO")
$s.Write($data, 0, $data.Length)
$s.Flush()

Start-Sleep -Seconds 1

$s.Close()
$c.Close()
```

### 第二步：客户端抓包

确认应用是否真的发出了 Payload。

Windows：

```powershell
pktmon start --capture --pkt-size 0 --file-name D:\test.etl
```

### 第三步：服务端同步抓包

```bash
tcpdump -ni any -nn -tttt -s0 'tcp port <PORT>'
```

比较：

```text
客户端有没有发
服务端有没有收
```

### 第四步：改变 Payload 类型

至少测试：

```text
普通 ASCII
随机 ASCII
随机 binary
全 0x00
全 0xFF
原协议 Payload
```

### 第五步：尝试标准封装协议

如果：

```text
裸 TCP binary      ❌
WebSocket          ✅
```

应优先怀疑：

```text
TCP Proxy
DPI
应用层协议识别
安全网关
协议白名单
```

而不是继续反复调整：

```text
MTU
EasyTier 版本
路由
P2P 参数
```

---

## 十八、这次排除掉了哪些方向

整次排查后，基本排除了：

```text
EasyTier 客户端没有发送
EasyTier 单版本 bug
Windows TCP 栈故障
Clash TUN 导致本次问题
TCP 三次握手失败
TCP 端口映射完全不通
MTU / MSS 导致 81B 小包失败
首包发送过快
Payload 长度限制
只要存在 0x00 就过滤
专门识别 EasyTier 单一协议
```

最关键的证据是：

```text
同一个公网 TCP 映射：

随机 ASCII 81B      → VPS 完整收到
随机 binary 81B     → VPS 收到 0B
EasyTier binary      → VPS 收到 0B
WebSocket EasyTier   → 正常
```

这已经很难用 EasyTier 自身问题解释。

---

## 十九、最终结论

本次问题可以总结为：

```text
EasyTier 原生 TCP
       ↓
公网 TCP 映射
       ↓
TCP 三次握手成功
       ↓
EasyTier binary Payload
       ↓
❌ 未到达 VPS
```

而：

```text
EasyTier over WebSocket
       ↓
公网 TCP 映射
       ↓
HTTP / WebSocket
       ↓
✅ 正常到达 VPS
       ↓
EasyTier 组网成功
```

结合所有测试，最合理的判断是：

> **当前平台提供的 TCP 映射不是完全透明的任意 TCP 字节流转发。中间高度疑似存在 TCP Proxy、应用层协议识别、安全检测、内容分类或类似机制，导致部分裸二进制协议 Payload 无法透传。**

需要强调的是：

> 因为无法登录平台公网映射网关，也看不到平台的具体转发实现，所以仅凭客户端和 VPS 两端抓包，**无法百分之百确认具体是 DPI、协议白名单还是某种 TCP Proxy 安全策略**。

但是可以确定：

```text
故障点不在 EasyTier 应用层本身
而在 Windows 出口到 VPS 入口之间的 TCP 映射链路
```

实际解决方案也很明确：

```text
平台只能提供 TCP
        ↓
EasyTier 使用 ws://
        ↓
通过标准 WebSocket 承载 EasyTier 数据
```

---

## 二十、如果要向平台客服反馈

可以直接提供下面这段描述：

> TCP 端口映射可以正常完成三次握手，可打印 ASCII Payload 能正常透传，但随机二进制 Payload、全 `0x00`、全 `0xFF` 和私有二进制协议 Payload 无法到达后端，WebSocket 流量正常。客户端抓包确认 Payload 已发送，服务端抓包确认 Payload 未到达。请确认当前 TCP 映射是否经过应用层代理、DPI、安全网关、协议白名单或其他内容检测，而不是透明四层 TCP 转发。

这种描述比单纯反馈：

```text
EasyTier 连不上
```

更容易让平台工程师直接定位到转发层。

---

## 二十一、后续建议

如果平台以后恢复：

```text
TCP + UDP 透明映射
```

可以重新测试 EasyTier 原生：

```toml
[[peer]]
uri = "tcp://<PUBLIC_MAPPING_IP>:<PUBLIC_TCP_PORT>"
```

如果仍然只能使用当前 TCP-only 映射，则建议长期使用：

```toml
[[peer]]
uri = "ws://<PUBLIC_MAPPING_IP>:<PUBLIC_WS_PORT>/"
```

另外，组网密钥一旦在日志、截图或公开文档中出现，建议及时更换：

```text
network_secret
```

排障日志发布到博客前，也建议统一脱敏：

```text
公网 IP
端口
network_secret
设备唯一标识
内网敏感地址
```

---

## 相关阅读

- [EasyTier 虚拟 IP 延迟异常排查：OpenClash 透明代理的锅](/posts/easytier-latency-openclash-troubleshooting/) — 另一次 EasyTier 网络异常排查，重点介绍如何判断底层 TCP/UDP 流量是否被透明代理接管。
