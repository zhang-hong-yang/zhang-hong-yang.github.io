---
title: Nginx 常见问题排查：403 Forbidden 与 SELinux
description: 分析 Nginx 访问静态页面返回 403 的常见原因，重点讲解 SELinux 拦截自定义目录的排查思路与正式修复方案，含反向代理相关配置。
date: 2026-07-01 11:00:00 +0800
categories: [教程, Nginx]
tags: [Nginx, SELinux, 403, Rocky Linux, 反向代理]
order: 20
---

部署 Nginx 静态前端或反向代理时，配置看起来没问题，页面却返回 **403 Forbidden**。本文以一次真实排障为例，说明如何区分普通权限问题与 **SELinux 拦截**，并给出可长期使用的修复方案。

## 你将学到什么

- Nginx 403 的常见原因清单
- 如何用 `setenforce 0` 快速判断是否为 SELinux 问题
- 给自定义静态目录设置正确的 SELinux 上下文
- 反向代理场景下需要额外开启的 SELinux 布尔值

---

## 一、问题现象

在 Linux 服务器上部署 Nginx 静态前端页面，访问：

```text
http://192.168.0.220/app/
```

页面返回：

```html
<html>
<head><title>403 Forbidden</title></head>
<body>
<center><h1>403 Forbidden</h1></center>
<hr><center>nginx/1.26.3</center>
</body>
</html>
```

Nginx 配置中对应的静态资源目录如下：

```nginx
location ^~ /app/ {
    alias /data/nginx/dist;
    index index.html;
    try_files $uri $uri/ /app/index.html;
}
```

检查静态目录文件：

```bash
ls -lah /data/nginx/dist
```

结果如下：

```text
drwxr-xr-x. 4 root root   92 Jul  1 15:51 .
drwxr-xr-x. 3 root root   31 Jul  1 15:46 ..
drwxr-xr-x. 2 root root 4.0K Jul  1 15:51 assets
drwxr-xr-x. 2 root root 8.0K Jul  1 15:51 cmaps
-rw-r--r--. 1 root root 4.2K Jul  1 15:51 favicon.ico
-rw-r--r--. 1 root root 1.3K Jul  1 15:51 index.html
-rw-r--r--. 1 root root 153K Jul  1 15:51 leejun_icn.png
```

从普通 Linux 权限来看：

```text
目录权限：755
文件权限：644
```

这些权限是正常的，Nginx 理论上应该可以读取。

但是执行下面命令后：

```bash
sudo setenforce 0
```

页面可以正常访问。

这说明问题不是 Nginx 配置错误，也不是普通 Linux 文件权限问题，而是 **SELinux 拦截了 Nginx 对静态文件目录的访问**。

---

## 二、Nginx 403 常见原因

访问静态页面出现 403，一般常见原因有：

```text
1. index.html 不存在
2. Nginx location 没匹配到
3. alias / root 配置错误
4. Linux 普通文件权限不足
5. SELinux 拦截
```

本次问题中，目录权限和文件权限都是正常的，`index.html` 也存在，并且执行 `setenforce 0` 后页面可以正常访问，因此可以确定是第 5 种情况。

---

## 三、问题原因：SELinux 安全上下文

### 什么是 SELinux

SELinux 是 Linux 系统中的一套安全访问控制机制。

普通 Linux 权限主要看：

```text
用户 / 用户组 / 其他人
读 / 写 / 执行权限
```

例如：

```text
-rw-r--r--
drwxr-xr-x
```

但是在开启 SELinux 的系统中，仅仅普通权限正确还不够。SELinux 还会检查进程和文件的**安全上下文**。

例如 Nginx 进程默认属于 `httpd_t` 类型，它能访问的文件通常需要带有类似下面的 SELinux 类型：

```text
httpd_sys_content_t
```

如果静态文件放在 `/usr/share/nginx/html` 这类默认目录中，通常不会有问题。

但如果静态文件放在自定义目录，比如：

```text
/data/nginx/dist
```

SELinux 可能认为这个目录不是 Web 服务可访问目录，于是拒绝 Nginx 读取。

### 为什么 `setenforce 0` 后可以访问

查看当前 SELinux 状态：

```bash
getenforce
```

可能返回：

```text
Enforcing
```

表示 SELinux 正在强制执行安全策略。

执行 `setenforce 0` 后，SELinux 会切换为宽松模式 `Permissive`。在这个模式下，SELinux 不再阻止访问，只记录告警日志。

所以如果执行 `setenforce 0` 后页面能访问，基本可以判断：

```text
Nginx 配置没问题
普通文件权限没问题
问题是 SELinux 拦截
```

---

## 四、如何确认是 SELinux 问题

### 1. 查看 SELinux 状态

```bash
getenforce
```

如果返回 `Enforcing`，说明 SELinux 正在开启并强制执行。

### 2. 查看文件 SELinux 上下文

```bash
ls -Zd /data/code/ai-knowledge-lib-web/library_base-dist
ls -Zd /data/nginx/distindex.html
```

如果看到的类型不是 `httpd_sys_content_t`，Nginx 就可能无法读取。

### 3. 查看 Nginx 错误日志

```bash
sudo tail -n 100 /var/log/nginx/server.error.log
```

或者：

```bash
sudo tail -n 100 /var/log/nginx/error.log
```

常见错误可能类似：

```text
open() ".../index.html" failed (13: Permission denied)
```

如果普通权限明明正确，但 Nginx 仍然提示 `Permission denied`，就要重点怀疑 SELinux。

---

## 五、临时解决方案

临时关闭 SELinux 强制模式：

```bash
sudo setenforce 0
```

这个方式可以用于快速验证问题，但**不建议长期使用**，因为它会降低系统安全性。

查看状态：

```bash
getenforce
```

如果显示 `Permissive`，说明已经临时关闭强制拦截。

验证完成后恢复：

```bash
sudo setenforce 1
```

---

## 六、正式解决方案

正确做法是：**给 Nginx 静态文件目录设置合适的 SELinux 类型**。

### 1. 安装 SELinux 管理工具

Rocky / RHEL / AlmaLinux / CentOS Stream 系统执行：

```bash
sudo dnf install -y policycoreutils-python-utils
```

### 2. 设置目录的 SELinux 上下文规则

如果静态文件目录在：

```text
/data/nginx/dist
```

可以只放行这个目录：

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/data/code/ai-knowledge-lib-web/library_base-dist(/.*)?"
sudo restorecon -Rv /data/code/ai-knowledge-lib-web/library_base-dist
```

如果 `/data/code` 下都是需要给 Nginx 访问的前端静态项目，也可以设置整个 `/data/code`：

```bash
sudo semanage fcontext -a -t httpd_sys_content_t "/data/code(/.*)?"
sudo restorecon -Rv /data/code
```

### 3. 恢复 SELinux 强制模式

```bash
sudo setenforce 1
getenforce
```

正常应返回 `Enforcing`。

### 4. 重载 Nginx

```bash
sudo systemctl reload nginx
```

然后重新访问页面。如果正常打开，说明 SELinux 上下文修复成功。

---

## 七、验证修复结果

执行：

```bash
ls -Zd /data/code/ai-knowledge-lib-web/library_base-dist
ls -Zd /data/nginx/distindex.html
```

正常应能看到类似：

```text
system_u:object_r:httpd_sys_content_t:s0
```

关键是里面要有 `httpd_sys_content_t`，表示该目录和文件已经被 SELinux 识别为 Web 服务可读取的静态内容。

---

## 八、反向代理场景的额外配置

如果 Nginx 配置中还有反向代理，例如：

```nginx
proxy_pass http://192.168.0.175:48888;
proxy_pass https://192.168.1.248:5500;
proxy_pass http://192.168.1.242:9004;
```

SELinux 还可能限制 Nginx 主动连接其他网络服务。这种情况下需要开启：

```bash
sudo setsebool -P httpd_can_network_connect 1
```

`httpd_can_network_connect` 允许 Nginx / Apache 这类 Web 服务进程主动发起网络连接。如果不开启，可能出现**前端页面可以访问，但接口代理失败**的问题。

---

## 九、推荐执行命令

如果确认静态文件目录是 `/data/nginx/dist`，推荐执行：

```bash
sudo dnf install -y policycoreutils-python-utils

sudo semanage fcontext -a -t httpd_sys_content_t "/data/code/ai-knowledge-lib-web/library_base-dist(/.*)?"
sudo restorecon -Rv /data/code/ai-knowledge-lib-web/library_base-dist

sudo setsebool -P httpd_can_network_connect 1

sudo setenforce 1
sudo systemctl reload nginx
```

如果 `/data/code` 下都是 Web 静态项目，可以改成：

```bash
sudo dnf install -y policycoreutils-python-utils

sudo semanage fcontext -a -t httpd_sys_content_t "/data/code(/.*)?"
sudo restorecon -Rv /data/code

sudo setsebool -P httpd_can_network_connect 1

sudo setenforce 1
sudo systemctl reload nginx
```

---

## 十、总结

| 现象 | 可能原因 | 处理方式 |
|------|----------|----------|
| 403，权限正常，`setenforce 0` 后恢复 | SELinux 拦截自定义目录 | 设置 `httpd_sys_content_t` 上下文 |
| 静态页正常，接口代理失败 | SELinux 限制出站连接 | `setsebool -P httpd_can_network_connect 1` |
| 403，文件不存在 | 路径或构建产物问题 | 检查 `alias`/`root` 与 `index.html` |
| 403，权限不足 | 普通文件权限 | `chmod` / `chown` 调整目录与文件权限 |

正确解决方式不是长期关闭 SELinux，而是给静态目录设置正确的 SELinux 类型 `httpd_sys_content_t`，并在需要反向代理时开启 `httpd_can_network_connect`。这样既能保证 Nginx 正常访问前端静态文件和后端接口，也能保留 SELinux 的安全防护能力。
