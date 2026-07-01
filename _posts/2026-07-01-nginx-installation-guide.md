---
title: Rocky / RHEL 系 Linux 安装 Nginx
description: 在 Rocky、RHEL、AlmaLinux、CentOS Stream 等使用 dnf 的发行版上安装 Nginx，配置 systemd 服务与防火墙，并验证 Web 服务可用。
date: 2026-07-01 10:00:00 +0800
categories: [教程, Nginx]
tags: [Nginx, Rocky Linux, RHEL, 防火墙, systemd]
order: 10
---

本文记录在 **Rocky / RHEL / AlmaLinux / CentOS Stream** 等使用 `dnf` 的 Linux 发行版上安装 Nginx 的完整流程，包括服务管理、防火墙放行与基础验证。

## 你将完成什么

- 通过系统仓库安装 Nginx
- 启动服务并设置开机自启
- 放行 HTTP / HTTPS 端口
- 验证 Nginx 是否正常运行

---

## 前置条件

- 已安装 Rocky、RHEL、AlmaLinux 或 CentOS Stream 等 **64 位**系统
- 具备 `sudo` 或 root 权限
- 服务器可以访问软件源（内网镜像源亦可）

---

## 1. 更新系统

安装前先更新软件包索引，减少依赖冲突：

```bash
sudo dnf update -y
```

---

## 2. 安装 Nginx

Rocky / RHEL 系发行版的 AppStream 仓库已提供 Nginx，直接安装即可：

```bash
sudo dnf install nginx -y
```

安装完成后可查看版本：

```bash
nginx -v
```

---

## 3. 启动并设置开机自启

```bash
sudo systemctl start nginx
sudo systemctl enable nginx
```

查看服务状态，确认 `Active: active (running)`：

```bash
sudo systemctl status nginx
```

常用管理命令：

| 操作 | 命令 |
|------|------|
| 启动 | `sudo systemctl start nginx` |
| 停止 | `sudo systemctl stop nginx` |
| 重启 | `sudo systemctl restart nginx` |
| 重载配置 | `sudo systemctl reload nginx` |
| 查看状态 | `sudo systemctl status nginx` |

> 修改配置文件后，优先使用 `reload` 平滑重载，避免中断已有连接。

---

## 4. 配置防火墙

若系统启用了 `firewalld`，需要放行 HTTP（80）和 HTTPS（443）服务：

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --reload
```

确认规则已生效：

```bash
sudo firewall-cmd --list-all
```

输出中应能看到 `services: ... http https ...`。

若使用云服务器，还需在安全组中放行对应端口。

---

## 5. 验证安装

在浏览器访问服务器 IP，或使用 `curl`：

```bash
curl -I http://127.0.0.1
```

正常应返回 `HTTP/1.1 200 OK`，并看到 Nginx 默认欢迎页。

默认站点根目录：

```text
/usr/share/nginx/html
```

主配置文件：

```text
/etc/nginx/nginx.conf
```

站点配置目录（按需引入）：

```text
/etc/nginx/conf.d/
```

---

## 6. 配置文件语法检查

修改配置后，重载前先检查语法：

```bash
sudo nginx -t
```

看到 `syntax is ok` 和 `test is successful` 后再执行：

```bash
sudo systemctl reload nginx
```

---

## 小结

| 步骤 | 命令 |
|------|------|
| 更新系统 | `dnf update -y` |
| 安装 Nginx | `dnf install nginx -y` |
| 启动并自启 | `systemctl start nginx && systemctl enable nginx` |
| 放行防火墙 | `firewall-cmd --permanent --add-service={http,https} && firewall-cmd --reload` |
| 验证 | `systemctl status nginx` / `curl -I http://127.0.0.1` |

安装完成后，即可继续配置静态站点、反向代理等。若访问自定义目录下的静态页面出现 **403 Forbidden**，且执行 `setenforce 0` 后恢复正常，通常是 **SELinux** 拦截导致，可参考 [Nginx 常见问题排查](/posts/nginx-common-issues/) 一文处理。
