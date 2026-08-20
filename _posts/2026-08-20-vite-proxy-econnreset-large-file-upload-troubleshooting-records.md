---
categories:
- 前端
- Vite
- 文件上传
date: "2026-08-20 13:47:00 +0800"
description: 记录 Vite Proxy 大文件上传 ECONNRESET
  的定位过程、日志分析与解决方案。
tags:
- Vite Proxy
- ECONNRESET
- multipart
- 大文件上传
- Hash秒传
title: Vite Proxy 大文件上传 ECONNRESET 问题排查记录
---

# Vite Proxy 大文件上传 ECONNRESET 问题排查记录

## 1. 问题现象

前端通过 Vite Proxy 上传文件：

``` text
POST http://127.0.0.1:5173/fd-server/file/upload
```

现象：

-   小文件上传正常
-   大文件上传失败
-   直连文件服务正常
-   Axios 报 `Network Error` / `ERR_CONNECTION_RESET`

------------------------------------------------------------------------

## 2. 排查结论

经过测试：

-   WSL curl 通过 Vite Proxy 上传大文件成功
-   带真实 `X-Auth-Token` 和 `Hash-Code` 上传成功
-   文件服务返回 SUCCESS
-   Vite Proxy 本身支持大文件上传

因此排除：

-   Vite Proxy 文件大小限制
-   WSL 网络问题
-   Axios timeout
-   文件服务上传能力问题

------------------------------------------------------------------------

## 3. Vite Proxy 调试代码

``` ts
configure(proxy) {

  proxy.on('proxyReq', (_proxyReq, req) => {
    console.log(
      'proxy request:',
      req.method,
      req.url,
      req.headers['content-length']
    )
  })

  // proxyRes 只表示收到上游响应头
  proxy.on('proxyRes', (proxyRes, req) => {
    console.log(
      'proxy response:',
      req.url,
      proxyRes.statusCode
    )
  })

  // 响应完整结束
  proxy.on('end', (req, _res, proxyRes) => {
    console.log(
      'proxy response completed:',
      req.url,
      proxyRes.statusCode
    )
  })

  proxy.on('econnreset', (err, req) => {
    console.error(
      'proxy connection reset:',
      req.url,
      err.message
    )
  })

  proxy.on('error', (err, req) => {
    console.error(
      'proxy error:',
      req.url,
      err.message
    )
  })

}
```

------------------------------------------------------------------------

## 4. 最终日志

``` text
proxy request:
POST /fd-server/file/upload 56051885

proxy response:
200

proxy response completed:
200

proxy connection reset:
read ECONNRESET
```

------------------------------------------------------------------------

## 5. 根因分析

文件上传接口通过 `Hash-Code` 判断文件是否已经存在。

异常流程：

``` text
浏览器
 |
 | 上传大文件
 |
Vite Proxy
 |
 | 转发上传流
 |
文件服务器
 |
 | Hash-Code 判断文件已存在
 |
 | 提前返回 200
 |
Vite Proxy
 |
 | 仍然等待剩余 request body
 |
 | socket状态异常
 |
ECONNRESET
```

本质：

> 文件服务已经完成响应，但客户端上传请求体还没有结束。经过代理后，请求流和响应流生命周期不同步，导致连接重置。

------------------------------------------------------------------------

## 6. 为什么小文件正常

小文件：

``` text
上传body
 |
Hash检查
 |
返回结果
```

时间接近。

大文件：

``` text
上传几十MB
       |
       |
       文件服务已经返回结果
       |
       |
       Vite仍处理剩余上传流
```

容易触发：

``` text
ECONNRESET
```

------------------------------------------------------------------------

## 7. 推荐解决方案

### 方案一：上传前 Hash 检查（推荐）

不要：

``` text
POST /file/upload

Header:
Hash-Code

Body:
500MB文件
```

改为：

``` text
1. 前端计算Hash

2. 调用:

POST /file/check

{
  hash:"xxxx"
}

3. 根据结果：

已存在 -> 秒传

不存在 -> 上传文件
```

优点：

-   真正秒传
-   节省网络
-   避免代理连接问题

------------------------------------------------------------------------

### 方案二：服务端消费完整 request body

如果保持单接口：

``` text
POST /file/upload
```

即使 Hash 存在，也先读取完整 multipart body，再返回。

优点：

-   HTTP行为稳定

缺点：

-   大文件仍然浪费上传流量

------------------------------------------------------------------------

## 8. 最终结论

问题不是：

-   Vite Proxy 限制
-   WSL 网络
-   Axios timeout
-   文件大小限制

真正原因：

> Hash
> 秒传逻辑在上传接口内部提前返回，导致大文件上传过程中响应提前结束，请求流未结束，经过
> Vite Proxy 后触发 ECONNRESET。

最佳方案：

> 增加 `/file/check` 接口，将 Hash 检查和文件上传拆分。
