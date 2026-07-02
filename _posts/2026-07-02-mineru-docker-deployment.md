---
title: MinerU Docker 部署：文档解析与 VLM 推理服务
description: 使用 Docker 部署 MinerU 文档解析工具，涵盖镜像构建、Compose 多服务模式（API、Gradio、OpenAI 兼容接口）及 GPU 配置要点。
date: 2026-07-02 14:00:00 +0800
categories: [教程, Docker]
tags: [安装, MinerU, AI, GPU, vLLM, 文档解析]
order: 30
---

[MinerU](https://github.com/opendatalab/MinerU) 是一个开源文档解析工具，支持 PDF 等格式的结构化提取。本文介绍通过 Docker 部署 MinerU 的完整流程，包括镜像构建、三种服务模式的选择，以及生产环境下的 Compose 配置参考。

## 你将完成什么

- 了解 MinerU 的 GPU 前置要求
- 构建 MinerU Docker 镜像
- 通过 Docker Compose 部署 API、Gradio、OpenAI 兼容三种服务
- 理解 `mineru-api`、`mineru-router`、`mineru-openai-server` 的区别与选型

---

## 前置要求

### GPU 要求（使用 vLLM 加速时）

| 项目 | 要求 |
|------|------|
| GPU 架构 | Volta 或更新，显存 ≥ 8 GB |
| CUDA 驱动 | 12.8+（用 `nvidia-smi` 检查） |
| Docker | 需能访问主机 GPU（`nvidia-container-toolkit`） |

若仅使用 CPU 模式或远程 VLM 客户端，可不满足上述 GPU 条件。

---

## 构建镜像

1. 下载 Dockerfile（国内镜像源）：

   ```bash
   wget https://gcore.jsdelivr.net/gh/opendatalab/MinerU@master/docker/china/Dockerfile
   ```

2. 构建镜像：

   ```bash
   docker build -t mineru:latest -f Dockerfile .
   ```

默认基础镜像为 `vllm/vllm-openai:v0.10.1.1`，支持 Ampere、Ada Lovelace 和 Hopper 架构。若使用 Volta、Turing 或 Blackwell GPU，需切换到 `vllm/vllm-openai:v0.11.0` 以上版本（如 `v0.18.0-cu130`）。

---

## 快速启动（docker run）

```bash
docker run --gpus all \
  --shm-size 32g \
  -p 30000:30000 -p 7860:7860 -p 8000:8000 \
  --ipc=host \
  -it mineru:latest \
  /bin/bash
```

端口说明：

| 端口 | 服务 |
|------|------|
| `30000` | OpenAI 兼容 API 服务 |
| `7860` | Gradio WebUI |
| `8000` | Web API 服务 |

---

## Docker Compose 部署

下载官方 compose 文件：

```bash
wget https://gcore.jsdelivr.net/gh/opendatalab/MinerU@master/docker/compose.yaml
```

> **重要：** vLLM 会预分配 GPU 显存，同一台机器上无法同时运行多个 vLLM 服务实例。按需选择一种 profile 启动。

### 1. OpenAI 兼容 API 服务

```bash
docker compose -f compose.yaml --profile openai-server up -d
```

客户端通过远程 VLM 后端调用（本地无需完整 VLM 依赖）：

```bash
mineru -p <input_path> -o <output_path> -b vlm-http-client -u http://<server_ip>:30000
```

### 2. Web API 服务

```bash
docker compose -f compose.yaml --profile api up -d
```

API 文档：`http://<server_ip>:8000/docs`

### 3. Gradio WebUI

```bash
docker compose -f compose.yaml --profile gradio up -d
```

Web 界面：`http://<server_ip>:7860`

---

## 三种服务对比

| 服务 | 用途 | 接口 | 适用场景 |
|------|------|------|----------|
| `mineru-api` | FastAPI 文档解析 | `/tasks`、`/file_parse`、`/health` | 单机单 GPU、本地解析 |
| `mineru-router` | 多服务/多 GPU 路由 | 与 mineru-api 相同 | 多 GPU 部署、负载均衡 |
| `mineru-openai-server` | OpenAI 兼容 VLM 推理 | OpenAI API 格式 | 轻量远程 VLM 推理 |

**选型建议：**

- **单机单 GPU**：直接使用 `mineru-api`
- **多 GPU 或多机**：使用 `mineru-router` 统一管理
- **轻量客户端**：部署 `mineru-openai-server` 作为远程推理后端，客户端通过 `vlm-http-client` 调用

---

## 生产环境 Compose 参考

以下配置基于实际部署场景，使用自定义镜像和网络，API 服务监听 `18980` 端口：

```yaml
services:
  mineru-api:
    image: mineru_vllm_v0.18.0:latest
    container_name: mineru-api
    restart: always
    profiles: [ "api" ]
    ports:
      - 18980:8000
    environment:
      MINERU_MODEL_SOURCE: local
      TZ: Asia/Shanghai
      MINERU_API_MAX_CONCURRENT_REQUESTS: 3
    networks:
      - docker_restricted
    volumes:
      - ./mineru-api/output:/vllm-workspace/output
      - ./mineru-api/root:/root
    entrypoint: mineru-api
    command:
      --host 0.0.0.0
      --port 8000
      --enable-vlm-preload true
      --allow-public-http-client
      --gpu-memory-utilization 0.1
    ulimits:
      memlock: -1
      stack: 67108864
    ipc: host
    healthcheck:
      test: [ "CMD-SHELL", "curl -f http://localhost:8000/health || exit 1" ]
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              device_ids: [ "0" ]
              capabilities: [ gpu ]

  mineru-gradio:
    image: mineru_vllm_v0.18.0:latest
    container_name: mineru-gradio
    restart: always
    profiles: [ "gradio" ]
    ports:
      - 7860:7860
    environment:
      MINERU_MODEL_SOURCE: local
      TZ: Asia/Shanghai
    networks:
      - docker_restricted
    entrypoint: mineru-gradio
    command:
      --server-name 0.0.0.0
      --server-port 7860
      --enable-api false
      --api-url http://mineru-api:8000
    ulimits:
      memlock: -1
      stack: 67108864
    ipc: host

networks:
  docker_restricted:
    external: true
    name: docker_restricted
```

关键配置说明：

- `--gpu-memory-utilization 0.1`：限制 vLLM 显存占用比例，适合与其他 GPU 任务共存
- `MINERU_API_MAX_CONCURRENT_REQUESTS: 3`：控制并发任务数，默认 3
- `mineru-gradio` 通过 `--api-url` 连接独立的 `mineru-api` 服务，两者可分 profile 独立启停
- 多 GPU 时修改 `device_ids: ["0", "1"]` 并配合 `--tensor-parallel-size 2`

启动 API 服务：

```bash
docker compose --profile api up -d
```

---

## 参考文档

- 官方 Docker 部署文档：[https://opendatalab.github.io/MinerU/zh/quick_start/docker_deployment/](https://opendatalab.github.io/MinerU/zh/quick_start/docker_deployment/)
- GitHub 仓库：[https://github.com/opendatalab/MinerU](https://github.com/opendatalab/MinerU)
