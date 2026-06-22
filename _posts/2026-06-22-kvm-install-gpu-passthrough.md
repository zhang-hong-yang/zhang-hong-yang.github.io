---
title: Rocky Linux 10 安装 KVM 与 NVIDIA 显卡直通
description: 在 Rocky Linux 10 上安装 KVM/libvirt，配置 Cockpit 与桥接网络，并通过 IOMMU、VFIO 和 driverctl 实现 NVIDIA GPU 精确直通。
date: 2026-06-22 14:00:00 +0800
categories: [教程, KVM]
tags: [KVM, Rocky Linux, libvirt, GPU 直通, VFIO, NVIDIA]
order: 10
---

本文记录在 **Rocky Linux 10** 上安装 KVM 虚拟化环境，并将 NVIDIA 显卡直通给虚拟机的完整流程。整体方案使用 **KVM + QEMU + libvirt** 管理虚拟机，使用 **driverctl** 按 PCI 地址精确绑定 GPU 到 `vfio-pci`，避免多张同型号显卡被一次性全部接管。

## 你将完成什么

- 安装 KVM、libvirt、virt-install、Cockpit 等组件
- 启用并验证硬件虚拟化与 IOMMU
- 配置默认 NAT 或桥接网络
- 创建 Rocky Linux 虚拟机
- 将指定 NVIDIA GPU 直通给虚拟机
- 掌握常用 `virsh` 管理命令和回滚方法

---

## 前置条件

开始前确认：

- 已安装 Rocky Linux 10 64 位系统
- BIOS/UEFI 中已开启 **Intel VT-x / AMD-V**
- 若要显卡直通，还需开启 **Intel VT-d / AMD IOMMU**
- 建议开启 **Above 4G Decoding**
- 具有 `sudo` 权限

检查 CPU 是否支持虚拟化：

```bash
# Intel 应看到 vmx，AMD 应看到 svm
grep -E 'vmx|svm' /proc/cpuinfo
```

有输出表示 CPU 支持虚拟化。若没有输出，先进入 BIOS/UEFI 开启虚拟化相关选项。

> SELinux 一般不需要关闭。KVM/libvirt 可以在 `Enforcing` 模式下正常工作。只有在排障时，才建议临时切到 `Permissive`。

---

## 安装 KVM 与管理工具

### 1. 启用仓库并更新系统

Rocky Linux 10 的部分虚拟化依赖来自 AppStream 和 CRB，建议先确认仓库启用。

```bash
sudo dnf config-manager --set-enabled appstream
sudo dnf config-manager --set-enabled crb
sudo dnf install -y epel-release

sudo dnf makecache
sudo dnf update -y
```

如需编译或安装额外依赖，可安装开发工具组：

```bash
sudo dnf group install -y "Development Tools"
```

### 2. 安装虚拟化组件

```bash
sudo dnf install -y \
  qemu-kvm libvirt libvirt-daemon libvirt-client \
  virt-install virt-manager virt-viewer \
  libguestfs-tools virt-top \
  cockpit cockpit-machines \
  edk2-ovmf pciutils driverctl
```

组件说明：

| 组件 | 作用 |
| --- | --- |
| KVM | Linux 内核虚拟化模块 |
| QEMU | 虚拟硬件与设备模拟 |
| libvirt | 虚拟化管理 API 与守护进程 |
| virt-install | 命令行创建虚拟机 |
| virt-manager | 图形化管理工具 |
| Cockpit Machines | Web 管理虚拟机 |
| driverctl | 按 PCI 地址绑定设备驱动 |

### 3. 启动服务

```bash
sudo systemctl enable --now libvirtd
sudo systemctl status libvirtd

sudo systemctl enable --now cockpit.socket
```

如开启了防火墙，放行 Cockpit：

```bash
sudo firewall-cmd --permanent --zone=public --add-service=cockpit
sudo firewall-cmd --reload
```

Cockpit 默认访问地址：

```text
https://<宿主机 IP>:9090/
```

若需要允许 root 登录 Cockpit，可编辑 `/etc/cockpit/disallowed-users`，注释掉 `root` 后重启：

```bash
sudo vim /etc/cockpit/disallowed-users
sudo systemctl restart cockpit
```

### 4. 验证 KVM 模块

```bash
lsmod | grep kvm
```

Intel 平台应能看到 `kvm_intel`，AMD 平台应能看到 `kvm_amd`。

---

## 配置用户权限

将当前用户加入 `libvirt` 组，后续可用普通用户管理虚拟机：

```bash
sudo usermod -aG libvirt $USER
newgrp libvirt
```

如果当前会话未生效，重新登录即可。

---

## 配置虚拟机网络

libvirt 默认会创建 NAT 网络 `virbr0`。这种方式最简单，虚拟机可以访问外网，但局域网其它机器不能直接访问虚拟机。

如果希望虚拟机和宿主机在同一网段，建议配置桥接网络。

> 远程 SSH 配置桥接有断网风险。删除或禁用主网卡连接前，建议使用本地控制台、IPMI、BMC 或其它带外管理方式。

### 1. 查看现有连接

```bash
nmcli connection show
```

记下当前物理网卡连接名和接口名，例如 `ens5f0`。

### 2. 创建桥接 br0

```bash
sudo nmcli connection add type bridge autoconnect yes con-name br0 ifname br0
```

### 3. 配置静态 IP

下面的地址按你的真实网络替换：

```bash
sudo nmcli connection modify br0 ipv4.addresses 192.168.0.177/24 ipv4.method manual
sudo nmcli connection modify br0 ipv4.gateway 192.168.0.1
sudo nmcli connection modify br0 ipv4.dns "8.8.8.8 114.114.114.114"
```

### 4. 将物理网卡加入桥接

以 `ens5f0` 为例：

```bash
sudo nmcli connection add type bridge-slave autoconnect yes con-name ens5f0-slave ifname ens5f0 master br0
```

### 5. 切换到桥接连接

确认 `br0` 的 IP、网关、DNS 都配置正确后，再禁用或删除原物理连接。这里不要拆成两次执行，否则第一条命令执行后 SSH 可能已经断开，第二条 `br0` 就没有机会拉起来。

```bash
sudo nmcli connection down "ens5f0" && sudo nmcli connection up br0
```

若确认不再需要原连接，可删除：

```bash
sudo nmcli connection delete "ens5f0" && sudo nmcli connection up br0
```

### 6. 允许 QEMU 使用桥接

```bash
echo 'allow all' | sudo tee -a /etc/qemu-kvm/bridge.conf
sudo systemctl restart libvirtd
```

创建虚拟机时使用 `--network bridge=br0,model=virtio` 即可。

---

## 创建虚拟机

### 1. 准备 ISO 和磁盘目录

```bash
mkdir -p ~/isos
sudo mkdir -p /var/lib/libvirt/images
```

将 Rocky Linux 10 ISO 放到合适目录，例如：

```text
/data/Rocky-10.1-x86_64-dvd1.iso
```

若希望当前用户直接管理默认镜像目录：

```bash
sudo chown -R $USER:libvirt /var/lib/libvirt/images
```

### 2. 创建普通虚拟机

NAT 网络示例：

```bash
virt-install \
  --name rocky10-desktop \
  --memory 4096 \
  --vcpus 4 \
  --cpu host-passthrough \
  --disk path=/var/lib/libvirt/images/rocky10-desktop.qcow2,size=40,bus=virtio,format=qcow2 \
  --os-variant rocky10 \
  --network network=default,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \
  --boot cdrom,hd \
  --virt-type kvm
```

桥接网络示例：

```bash
virt-install \
  --name rocky10-bridge \
  --memory 8192 \
  --vcpus 8 \
  --cpu host-passthrough \
  --disk path=/var/lib/libvirt/images/rocky10-bridge.qcow2,size=100,bus=virtio,format=qcow2 \
  --os-variant rocky10 \
  --network bridge=br0,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \
  --boot cdrom,hd \
  --virt-type kvm
```

也可以在 Cockpit 的“虚拟机”页面中完成图形化安装。

---

## NVIDIA GPU 直通

这一节以多张 NVIDIA 服务器卡为例。目标是将指定 GPU 交给虚拟机，宿主机继续使用 BMC/ASPEED 显示或保留部分 NVIDIA 卡。

### 1. 查看显卡 PCI 地址

```bash
lspci -nn | grep -Ei 'vga|3d|display|audio'
```

示例输出：

```text
0000:02:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000]
0000:38:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5]
0000:49:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5]
0000:98:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5]
0000:b8:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5]
```

这里：

- `0000:02:00.0` 是 ASPEED/BMC 显卡，留给宿主机
- `0000:38:00.0`、`0000:49:00.0`、`0000:98:00.0`、`0000:b8:00.0` 是 NVIDIA GPU
- 多张 NVIDIA 卡的 PCI ID 都是 `10de:2bb5`

因为多张卡的 PCI ID 相同，不建议使用 `vfio-pci.ids=10de:2bb5` 这种按 ID 绑定的方式，否则会一次性绑定所有同型号卡。本文使用 `driverctl set-override` 按 BDF 地址精确绑定。

### 2. 启用 IOMMU

Intel 平台：

```bash
sudo grubby --args="intel_iommu=on iommu=pt" --update-kernel=ALL
sudo reboot
```

AMD 平台可使用：

```bash
sudo grubby --args="amd_iommu=on iommu=pt" --update-kernel=ALL
sudo reboot
```

重启后验证：

```bash
cat /proc/cmdline
dmesg | grep -Ei 'DMAR|IOMMU|AMD-Vi'
```

### 3. 查看 IOMMU 分组

```bash
for g in /sys/kernel/iommu_groups/*; do
  [ -d "$g" ] || { echo "IOMMU groups not found. Check BIOS and kernel cmdline."; break; }
  echo "IOMMU Group ${g##*/}:"
  for d in "$g"/devices/*; do
    echo "  $(lspci -nns ${d##*/})"
  done
done
```

直通设备最好处于独立 IOMMU 组。如果目标 GPU 与关键设备同组，优先调整 BIOS 选项或更换插槽。

### 4. 清理旧的按 ID 绑定参数

如果之前尝试过 `vfio-pci.ids=10de:2bb5`，先移除，避免所有同型号 GPU 被一起绑定：

```bash
sudo grubby --remove-args="rd.driver.pre=vfio-pci vfio-pci.ids=10de:2bb5" --update-kernel=ALL
sudo grubby --args="intel_iommu=on iommu=pt" --update-kernel=ALL
```

AMD 平台把最后一行换成：

```bash
sudo grubby --args="amd_iommu=on iommu=pt" --update-kernel=ALL
```

### 5. 按地址绑定 GPU 到 vfio-pci

示例：将 `38:00.0`、`49:00.0`、`98:00.0` 三张卡直通给虚拟机，保留 `b8:00.0` 给宿主机。

```bash
sudo driverctl set-override 0000:38:00.0 vfio-pci
sudo driverctl set-override 0000:49:00.0 vfio-pci
sudo driverctl set-override 0000:98:00.0 vfio-pci

driverctl list-overrides
sudo reboot
```

如果四张 NVIDIA 卡都要直通：

```bash
sudo driverctl set-override 0000:b8:00.0 vfio-pci
driverctl list-overrides
sudo reboot
```

重启后检查驱动：

```bash
for dev in 38:00.0 49:00.0 98:00.0 b8:00.0; do
  echo "==== $dev ===="
  lspci -nnk -s "$dev"
done
```

执行过 `set-override` 的设备应显示：

```text
Kernel driver in use: vfio-pci
```

### 6. 可选：宿主机完全不用 NVIDIA 时黑名单驱动

如果宿主机完全不使用 NVIDIA，只把 GPU 全部给虚拟机，可额外阻止宿主机加载 `nouveau` 和 NVIDIA 驱动：

```bash
sudo grubby --args="modprobe.blacklist=nouveau,nvidia,nvidia_drm,nvidia_modeset,nvidia_uvm" --update-kernel=ALL

sudo tee /etc/modprobe.d/blacklist-nvidia.conf >/dev/null <<'EOF'
blacklist nouveau
blacklist nvidia
blacklist nvidia_drm
blacklist nvidia_modeset
blacklist nvidia_uvm
EOF

sudo dracut -f --regenerate-all
sudo reboot
```

如果需要保留一张 NVIDIA 给宿主机做 CUDA 或图形输出，不要配置这组黑名单，只对要直通的卡执行 `driverctl set-override`。

---

## 创建带 GPU 直通的虚拟机

推荐配置：

- 机型：Q35
- 固件：OVMF/UEFI
- CPU：`host-passthrough`
- 网卡与磁盘：virtio
- GPU：通过 `--host-device` 或 libvirt XML 添加

### 1. virt-install 示例

单张 GPU：

```bash
virt-install \
  --name rocky10-gpu \
  --memory 65536 \
  --vcpus 48 \
  --cpu host-passthrough \
  --disk path=/data/libvirt/images/rocky10-gpu.qcow2,size=1000,bus=virtio,format=qcow2 \
  --os-variant rocky10 \
  --network bridge=br0,model=virtio \
  --graphics vnc,listen=0.0.0.0,password=<VNC_PASSWORD> \
  --video none \
  --host-device 98:00.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \
  --boot cdrom,hd \
  --virt-type kvm
```

多张 GPU：

```bash
virt-install \
  --name rocky10-ai \
  --memory 102400 \
  --vcpus 50 \
  --cpu host-passthrough \
  --disk path=/data/libvirt/images/rocky10-ai.qcow2,size=500,bus=virtio,format=qcow2 \
  --os-variant rocky10 \
  --network bridge=br0,model=virtio \
  --graphics vnc,listen=0.0.0.0,password=<VNC_PASSWORD> \
  --video none \
  --host-device 38:00.0 \
  --host-device 49:00.0 \
  --host-device 98:00.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \
  --boot cdrom,hd \
  --virt-type kvm
```

> `password=<VNC_PASSWORD>` 请替换为自己的临时密码。VNC 安装完成后，建议关闭远程 VNC 或限制监听地址。

### 2. 给已有虚拟机增加 GPU

查看虚拟机：

```bash
virsh list --all
```

编辑虚拟机 XML：

```bash
virsh edit vm-rocky10-01
```

添加 PCI Host Device：

```xml
<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x38' slot='0x00' function='0x0'/>
  </source>
</hostdev>

<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x49' slot='0x00' function='0x0'/>
  </source>
</hostdev>
```

上面的 `bus='0x38'` 和 `bus='0x49'` 对应 `0000:38:00.0`、`0000:49:00.0`。

如果使用 `virt-manager`，也可以在虚拟机详情中添加 **PCI Host Device**。

---

## 虚拟机内验证 GPU

Linux Guest 安装 NVIDIA 驱动后验证：

```bash
lspci | grep -Ei 'nvidia|3d|vga'
nvidia-smi
```

宿主机查看 GPU 当前驱动：

```bash
for dev in 38:00.0 49:00.0 98:00.0 b8:00.0; do
  lspci -nnk -s "$dev" | grep -E 'controller|Kernel driver'
done

lsmod | grep vfio
```

---

## 常用 virsh 命令

| 操作 | 命令 |
| --- | --- |
| 列出运行中的虚拟机 | `virsh list` |
| 列出所有虚拟机 | `virsh list --all` |
| 启动虚拟机 | `virsh start <vm_name>` |
| 正常关机 | `virsh shutdown <vm_name>` |
| 强制断电 | `virsh destroy <vm_name>` |
| 重启 | `virsh reboot <vm_name>` |
| 挂起 | `virsh suspend <vm_name>` |
| 恢复 | `virsh resume <vm_name>` |
| 编辑配置 | `virsh edit <vm_name>` |
| 导出 XML | `virsh dumpxml <vm_name> > <vm_name>.xml` |
| 从 XML 导入 | `virsh define <vm_name>.xml` |
| 设置开机自启 | `virsh autostart <vm_name>` |
| 查看自启虚拟机 | `virsh list --autostart` |
| 删除定义 | `virsh undefine <vm_name> --nvram` |

从 XML 迁移或恢复虚拟机时，注意 XML 只保存虚拟机定义，不会复制 `.qcow2` 磁盘文件。导入前需要确认磁盘路径、桥接名称和 PCI 设备地址都符合目标宿主机环境。

---

## 常见问题

### virt-manager 找不到

确认 AppStream 已启用：

```bash
sudo dnf clean all
sudo dnf makecache
dnf repolist enabled
dnf search virt-manager
```

如果是最小化服务器环境，也可以不安装 `virt-manager`，只使用 `virt-install`、`virsh` 和 Cockpit 管理。

### 虚拟化未开启

检查 BIOS/UEFI 中的 Intel VT-x、Intel VT-d、AMD-V、AMD IOMMU。若是在虚拟机中再运行 KVM，还需要开启 nested virtualization。

### VM 启动时报 IOMMU group 错误

先查看 IOMMU 分组。如果 GPU 与其它关键设备在同一组，优先更换插槽、调整 BIOS 选项，或确认主板是否支持更好的 PCIe ACS 隔离。

### VM 内看不到 GPU

检查：

- 宿主机对应 GPU 是否为 `Kernel driver in use: vfio-pci`
- 虚拟机 XML 是否添加了正确的 PCI 地址
- Guest 系统是否安装了 NVIDIA 驱动
- Windows Guest 是否已安装 VirtIO 驱动

### 宿主机看不到 NVIDIA

如果所有 NVIDIA 卡都执行了 `driverctl set-override`，这是预期行为。若想保留一张给宿主机，确认该卡没有执行 `set-override`，并且没有配置 NVIDIA 黑名单。

---

## 回滚显卡直通

取消 `driverctl` 绑定：

```bash
sudo driverctl unset-override 0000:38:00.0
sudo driverctl unset-override 0000:49:00.0
sudo driverctl unset-override 0000:98:00.0
sudo driverctl unset-override 0000:b8:00.0

driverctl list-overrides
sudo reboot
```

如果配置过按 ID 绑定或 NVIDIA 黑名单，也一并移除：

```bash
sudo grubby --remove-args="rd.driver.pre=vfio-pci vfio-pci.ids=10de:2bb5 modprobe.blacklist=nouveau,nvidia,nvidia_drm,nvidia_modeset,nvidia_uvm" --update-kernel=ALL
sudo rm -f /etc/modprobe.d/blacklist-nvidia.conf
sudo dracut -f --regenerate-all
sudo reboot
```

---

## 快速检查清单

- BIOS 开启 VT-x/AMD-V、VT-d/AMD IOMMU、Above 4G Decoding
- 安装 `qemu-kvm`、`libvirt`、`virt-install`、`driverctl`
- 启用 `libvirtd` 和 Cockpit
- 如需同网段访问，配置 `br0` 桥接
- 开启 `intel_iommu=on iommu=pt` 或 `amd_iommu=on iommu=pt`
- 确认 IOMMU 分组正常
- 只对要直通的 GPU 执行 `driverctl set-override`
- 重启后确认目标 GPU 驱动为 `vfio-pci`
- VM 使用 `host-passthrough`，并添加对应 PCI Host Device
