---
title: Rocky Linux firewalld 防火墙：端口开放与管理
description: 在 Rocky Linux 上使用 firewalld 查看状态、开放常用端口、管理服务规则，以及通过富规则实现 IP 级别的访问控制。
date: 2026-07-02 12:00:00 +0800
categories: [教程, Linux]
tags: [firewalld, Rocky Linux, 防火墙, 端口]
order: 10
---

本文介绍在 **Rocky Linux** 上使用 `firewalld` 管理防火墙的常用操作，包括查看状态、开放端口、管理服务规则，以及通过富规则实现更精细的访问控制。

## 你将完成什么

- 查看和管理 firewalld 服务状态
- 开放单个端口、端口范围和常用服务端口
- 查看和删除已开放的规则
- 使用富规则限制特定 IP 的访问

---

## 查看防火墙状态

```bash
# 查看服务状态
sudo systemctl status firewalld

# 查看防火墙是否运行
sudo firewall-cmd --state
```

输出 `running` 表示防火墙正在运行。

---

## 启动与停止防火墙

```bash
# 启动
sudo systemctl start firewalld

# 停止
sudo systemctl stop firewalld

# 重启
sudo systemctl restart firewalld

# 设置开机自启
sudo systemctl enable firewalld
```

> 生产环境建议保持 firewalld 运行，通过规则放行所需端口，而非直接关闭防火墙。

---

## 开放端口

firewalld 的规则分为**运行时**（立即生效，重启后丢失）和**永久**（需 `--permanent` 并 `--reload` 后生效）。以下示例均使用永久规则。

### 开放单个端口

```bash
# TCP
sudo firewall-cmd --zone=public --add-port=80/tcp --permanent

# UDP
sudo firewall-cmd --zone=public --add-port=53/udp --permanent

# 重载使配置生效
sudo firewall-cmd --reload
```

### 开放端口范围

```bash
sudo firewall-cmd --zone=public --add-port=8000-9000/tcp --permanent
sudo firewall-cmd --reload
```

---

## 常用端口开放示例

```bash
# HTTP
sudo firewall-cmd --zone=public --add-port=80/tcp --permanent

# HTTPS
sudo firewall-cmd --zone=public --add-port=443/tcp --permanent

# SSH
sudo firewall-cmd --zone=public --add-port=22/tcp --permanent

# MySQL
sudo firewall-cmd --zone=public --add-port=3306/tcp --permanent

# PostgreSQL
sudo firewall-cmd --zone=public --add-port=5432/tcp --permanent

# Redis
sudo firewall-cmd --zone=public --add-port=6379/tcp --permanent

# MongoDB
sudo firewall-cmd --zone=public --add-port=27017/tcp --permanent

# Docker API（生产环境慎用，建议配合 TLS 和 IP 限制）
sudo firewall-cmd --zone=public --add-port=2375/tcp --permanent
sudo firewall-cmd --zone=public --add-port=2376/tcp --permanent

sudo firewall-cmd --reload
```

---

## 开放服务（推荐方式）

对于 HTTP、HTTPS、SSH 等标准服务，优先使用服务名而非端口号，语义更清晰：

```bash
sudo firewall-cmd --zone=public --add-service=http --permanent
sudo firewall-cmd --zone=public --add-service=https --permanent
sudo firewall-cmd --zone=public --add-service=ssh --permanent

# 查看所有可用服务
sudo firewall-cmd --get-services

sudo firewall-cmd --reload
```

---

## 查看已开放规则

```bash
# 查看当前 zone 下所有开放的端口
sudo firewall-cmd --zone=public --list-ports

# 查看完整规则（端口、服务、富规则等）
sudo firewall-cmd --list-all
```

---

## 删除端口

```bash
sudo firewall-cmd --zone=public --remove-port=80/tcp --permanent
sudo firewall-cmd --reload
```

---

## 富规则（高级）

富规则支持按源 IP、端口、协议等条件做精细控制。

### 允许特定 IP 访问 SSH

```bash
sudo firewall-cmd --zone=public \
  --add-rich-rule='rule family="ipv4" source address="192.168.1.100" port protocol="tcp" port="22" accept' \
  --permanent
sudo firewall-cmd --reload
```

### 拒绝特定 IP

```bash
sudo firewall-cmd --zone=public \
  --add-rich-rule='rule family="ipv4" source address="192.168.1.100" reject' \
  --permanent
sudo firewall-cmd --reload
```

### 仅允许内网访问某端口

```bash
sudo firewall-cmd --zone=public \
  --add-rich-rule='rule family="ipv4" source address="192.168.0.0/16" port protocol="tcp" port="8080" accept' \
  --permanent
sudo firewall-cmd --reload
```

---

## 常见问题

**修改规则后不生效**

永久规则需要执行 `sudo firewall-cmd --reload` 才会加载。可用 `firewall-cmd --list-all` 确认当前生效的规则。

**Docker 与 firewalld 冲突**

Docker 默认会管理 iptables 规则，可能与 firewalld 产生冲突。若宿主机使用 firewalld 统一管理，可在 Docker 的 `daemon.json` 中设置 `"iptables": false`，详见 [daemon.json 参数说明](/posts/docker-daemon-json-guide/)。

**临时测试规则**

不加 `--permanent` 添加的规则立即生效但重启后丢失，适合临时调试：

```bash
sudo firewall-cmd --zone=public --add-port=8080/tcp
```

确认无误后再添加永久规则并 reload。
