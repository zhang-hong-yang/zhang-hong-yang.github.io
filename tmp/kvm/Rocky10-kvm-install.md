# Rocky Linux 10 安装 KVM 教程

## 简介

KVM（Kernel-based Virtual Machine）是 Linux 内核内置的虚拟化方案，配合 QEMU 和 libvirt 可以创建和管理虚拟机。本教程介绍在 Rocky Linux 10 上安装并配置 KVM 虚拟化环境。

**主要组件：**

- **KVM**：内核虚拟化模块
- **QEMU**：硬件模拟器
- **libvirt**：虚拟化管理 API 与工具
- **virt-manager**（可选）：图形化管理界面

---

## 前置条件

- 已安装 **Rocky Linux 10**（64 位）
- 物理机在 BIOS/UEFI 中已开启 **虚拟化**（Intel VT-x 或 AMD-V）
- 具有 `sudo` 权限的账户

### 检查 CPU 是否支持虚拟化

```bash
# Intel：应能看到 vmx
# AMD：应能看到 svm
grep -E 'vmx|svm' /proc/cpuinfo
```

有输出即表示 CPU 支持虚拟化。若没有输出，需在 BIOS 中启用 Virtualization Technology / SVM Mode 等选项。

---

### （可选）关闭 SELinux（不推荐，一般只用于排错）

正常情况下，KVM/libvirt 可以在 SELinux `Enforcing` 模式下正常工作，无需关闭 SELinux。  
若你所在环境习惯关闭 SELinux，或需要快速排查是否为 SELinux 导致的问题，可按如下方式操作：

```bash
# 永久关闭：修改配置文件后需要重启生效
sudo sed -i 's/^SELINUX=.*/SELINUX=disabled/' /etc/selinux/config

# 立即生效：当前会话改为 Permissive（临时）
sudo setenforce 0
```

> **提示**：出于安全考虑，生产环境应优先保持 SELinux 启用，只对必要的策略做放行。

---

## 一、安装 KVM 与相关软件包

### 1. 启用 EPEL 仓库并更新系统

```bash
# 启用 CRB 仓库（Rocky 10 中对应 RHEL 的 CodeReady Builder，很多额外包在这里）
sudo dnf config-manager --set-enabled crb

sudo dnf install -y epel-release

# 建议在启用 EPEL 后先整体更新一次系统
sudo dnf makecache
dnf repolist enabled
# 若未看到 appstream，启用它
sudo dnf config-manager --set-enabled appstream
# 重新生成缓存
sudo dnf makecache
sudo dnf update -y
# 安装常用软件包
dnf group install "Development Tools"  -y

```

### 2. 安装完整的 KVM / 虚拟化相关包

**先确保启用 AppStream 和 CRB，并刷新缓存**  
（`virt-manager` 等虚拟化相关包主要在 AppStream，部分开发/依赖包在 CRB：CodeReady Builder）  

**一次性安装常用虚拟化组件：**  Rocky 10 已经移除 `bridge-utils  已内置`**nmcli**

```bash
sudo dnf install -y \
  qemu-kvm libvirt libvirt-daemon libvirt-client \
  virt-install virt-manager virt-viewer \
  libguestfs-tools virt-top  cockpit cockpit-machines
```

若提示 **「未找到匹配的参数: virt-manager」**，请按下方「故障排查 → virt-manager 找不到」处理。

### 3. 验证 KVM 模块

```bash
lsmod | grep kvm
```

你应该看到类似下面的输出，以确认已加载必要的模块，例如包含：

- `kvm_intel`（Intel CPU）或 `kvm_amd`（AMD CPU）
- `kvm` 核心模块

同时建议在这里就启动并启用 `libvirtd` 守护进程（后面章节会再详细说明）：

```bash
sudo systemctl start libvirtd
sudo systemctl enable --now libvirtd
sudo systemctl status libvirtd
```

---

### 4. 启用管理服务

```
sudo systemctl enable --now cockpit.socket
firewall-cmd --permanent --zone=public --add-service=cockpit
# 重新加载防护墙
firewall-cmd --reload
sudo firewall-cmd --list-ports
# 启用root登录
vim /etc/cockpit/disallowed-users 
注释掉root
sudo systemctl restart cockpit
```

## 二、配置用户与服务

### 1. 将用户加入 libvirt 组

便于以普通用户管理虚拟机，无需每次使用 root：

```bash
sudo usermod -aG libvirt $USER
```

使当前会话生效：

```bash
newgrp libvirt
```

或重新登录后再操作。

### 2. 启用并启动 libvirtd

`libvirtd` 是在宿主机上运行的服务端守护进程，用来管理虚拟化相关的各类任务（如 KVM、Xen、ESXi 等）。  
在下一步中，一定要启动并启用它：

```bash
# 启动 libvirtd 守护进程
sudo systemctl start libvirtd

# 设置为开机自动启动（并立即启动）
sudo systemctl enable --now libvirtd

# 验证 libvirtd 是否正在运行
sudo systemctl status libvirtd
```

状态应显示为 `active (running)`。

---

## 三、网络配置（可选）

默认会有一个 NAT 网络 `virbr0`，虚拟机可上网，但宿主机外无法直接访问虚拟机。若需要虚拟机与宿主机同一网段、直接通过 IP 访问，可配置桥接网络。

> **注意**：通过 SSH 远程配置桥接时，删除主网卡连接会导致断线，建议在本地控制台或带外管理下操作。

### 1. 查看当前网络连接

```bash
nmcli connection show
```

记下当前上网使用的连接名（如 `ens5f0`、`eth0`）和接口名。

### 2. 创建桥接连接

以下示例中：

- 桥接名称：`br0`
- 桥接接口名：`br0`
- 物理网卡连接名与接口名请按实际情况替换（如 `ens5f0`）

```bash
# 创建桥接
sudo nmcli connection add type bridge autoconnect yes con-name br0 ifname br0
```

### 3. 为桥接配置静态 IP（必须先执行,否则无法连到真机）

若宿主机需要固定 IP：

```bash
sudo nmcli connection modify br0 ipv4.addresses 192.168.0.177/24 ipv4.method manual
sudo nmcli connection modify br0 ipv4.gateway 192.168.0.1
sudo nmcli connection modify br0 ipv4.dns "8.8.8.8 114.114.114.114"
```

### 4. 将物理网卡加入桥接

将上面记下的「连接名」和「接口名」替换到下面命令中：

```bash
sudo nmcli connection add type bridge-slave autoconnect yes con-name ens5f0-slave ifname ens5f0 master br0
```

### 5. 删除(禁用)原物理网卡上的连接（会断网） 并且 启动桥接

```bash
# 可以先禁用 
# sudo nmcli connection down "ens5f0"  && sudo nmcli connection up br0 

# 删除
sudo nmcli connection delete "ens5f0"  && sudo nmcli connection up br0 


```

```bash

```

### 7. 允许 QEMU 使用桥接（若使用默认策略）

```bash
echo 'allow all' | sudo tee -a /etc/qemu-kvm/bridge.conf
sudo systemctl restart libvirtd
```

创建虚拟机时使用 `--network bridge=br0` 即可让该虚拟机使用桥接网络。

---

## 四、创建虚拟机

### 1. 准备镜像与目录

将 ISO 放到合适目录，例如：

```bash
mkdir -p ~/isos
# 将 Rocky Linux 10 或其他 ISO 放到 ~/isos/
```

默认镜像目录为 `/var/lib/libvirt/images/`，若希望用当前用户直接写入，可调整权限（可选）：

```bash
sudo chown -R $USER:libvirt /var/lib/libvirt/images
```

### 2. 命令行创建虚拟机（virt-install）


**示例：带图形安装界面（VNC/SPICE）**

```bash
virt-install \
  --name rocky10-desktop \
  --ram 4096 \
  --vcpus 4 \
  --disk path=/var/lib/libvirt/images/rocky10-desktop.qcow2,size=40 \
  --os-variant rocky10 \
  --network network=default,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --cdrom /path/to/Rocky-10-x86_64-dvd.iso


virt-install \
  --name vm-rocky10-02 \                             # 虚拟机名称
  --memory 65536,maxmemory=204800 \         # 分配 64GB 内存, 最大200G
  --memballoon model=virtio,autodeflate=on \   # 启用 virtio balloon + 自动 deflate（虚拟机内部从虚拟机程序抢内存防止虚拟机OOM）
  --vcpus 48 \                               # 分配 4 个虚拟 CPU
  --cpu host-passthrough \                              # 用 host-passthrough 更完整地透传 CPU 特性
  --disk path=/data/kvm_fd/vm-rocky10-02/images/vm-rocky10-02.qcow2,size=1000,bus=virtio,format=qcow2 \  # qcow2 格式支持磁盘的动态扩展，虚拟机使用的空间会随着实际数据的写入而增加，直到达到设置的最大大小, 所以可以设置大一些 , 这里是1000G
  --os-variant rocky10 \                # 操作系统类型（优化设置）
  --network bridge=br0,model=virtio  \  # 使用虚拟网络，虚拟网卡使用 virtio 驱动
  --graphics vnc,listen=0.0.0.0,password=Ljun233 \  # 使用 VNC 图形界面，允许任何主机连接，设置密码最长8位
  --host-device 98:00.0 \  # 显卡ID
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \       # 指定操作系统 ISO 镜像作为安装盘
  --boot cdrom,hd \                         # 启动顺序：先从 CD-ROM 启动，再从硬盘启动
  --noautoconsole \                        # 不自动连接到控制台
  --extra-args "console=ttyS0" \            # 传递额外的启动参数
  --virt-type kvm \                        # 使用 KVM 虚拟化
  --channel type=spicevmc,id=ch0,name=com.redhat.spice.0 \                     # 配置 SPICE 虚拟通道，支持图形和文件传输
  --channel type=unix,target.type=virtio,target.name=org.qemu.guest_agent.0 \  # 建议加 guest agent 通道


virt-install \
  --name vm-rocky10-02 \
  --memory 65536,maxmemory=204800 \
  --memballoon model=virtio,autodeflate=on \
  --vcpus 48 \
  --cpu host-passthrough \
  --disk path=/data/kvm_fd/vm-rocky10-02/images/vm-rocky10-02.qcow2,size=1000,bus=virtio,format=qcow2 \
  --os-variant rocky10 \
  --network bridge=br0,model=virtio  \
  --graphics vnc,listen=0.0.0.0,password=Ljun233 \
  --host-device 98:00.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso \
  --boot cdrom,hd \
  --virt-type kvm  


virt-install \
  --name rocky10-desktop \
  --ram 4096 \          # 启动时分配 4GB 内存
  --vcpus 4 \
  --disk path=/var/lib/libvirt/images/rocky10-desktop.qcow2,size=40 \
  --os-variant rocky10 \
  --network network=default,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --cdrom /path/to/Rocky-10-x86_64-dvd.iso \
  --memory 400000 \     # 最大内存 400GB（单位为 KB）
  --balloon 8192       # 最小内存 8GB（单位为 MB）

  # 桥接 - 分配显卡 --host-device 指定显卡
    virt-install \
  --name rocky10-ai \
  --memory 102400 \
  --vcpus 50 \
  --cpu host-passthrough \
  --disk path=/data/libvirt/images/rocky10-ai.qcow2,size=500,bus=virtio \
  --os-variant rocky10 \
  --network bridge=br0,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --video none \
  --host-device 38:00.0 \
  --host-device 49:00.0 \
  --host-device 98:00.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso



  # 非桥接 - 分配显卡
    virt-install \
  --name rocky10-ai \
  --memory 102400 \
  --vcpus 50 \
  --cpu host-passthrough \
  --disk path=/data/libvirt/images/rocky10-ai.qcow2,size=500,bus=virtio \
  --os-variant rocky10 \
  --network network=default,model=virtio \
  --graphics vnc,listen=0.0.0.0 \
  --video none \
  --host-device 38:00.0 \
  --host-device 49:00.0 \
  --host-device 98:00.0 \
  --cdrom /data/Rocky-10.1-x86_64-dvd1.iso
```

若已配置桥接网络，将 `network=default` 改为 `bridge=br0` 即可。

**访问https://192.168.0.177:9090/进入管理页面选择虚拟机进行图形化安装过程**

### 3. 使用图形界面（virt-manager）

在已安装图形界面的 Rocky Linux 10 上：

```bash
virt-manager
```

通过菜单可新建虚拟机、选择 ISO、配置 CPU/内存/磁盘和网络等。

---

### 4. 在已有虚拟机上增加显卡


```shell
[root@localhost images]# virsh list
 Id   名称            状态
----------------------------
 4    vm-rocky10-01   运行

[root@localhost images]# virsh edit vm-rocky10-01
域 'vm-rocky10-01' XML 配置没有改变。

```

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

说明:
  - bus这里将显卡0000:38:00.0, 0000:49:00.0分配给虚拟机vm-rocky10-01
```shell
lspci -nn | grep -Ei 'vga|3d|display|audio'
```
适配目标机器（你当前输出）：
```shell
[root@localhost ~]# lspci -nn | grep -Ei 'vga|3d|display|audio'
0000:02:00.0 VGA compatible controller [0300]: ASPEED Technology, Inc. ASPEED Graphics Family [1a03:2000] (rev 52)
0000:38:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5] (rev a1)
0000:49:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5] (rev a1)
0000:98:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5] (rev a1)
0000:b8:00.0 3D controller [0302]: NVIDIA Corporation GB202GL [RTX PRO 6000 Blackwell Server Edition] [10de:2bb5] (rev a1)

```

---

## 五、常用虚拟机管理命令（virsh）


| 操作        | 命令                            |
| --------- | ----------------------------- |
| 列出运行中的虚拟机 | `virsh list`                  |
| 列出所有虚拟机   | `virsh list --all`            |
| 启动虚拟机     | `virsh start <vm_name>`            |
| 关机（ACPI）  | `virsh shutdown <vm_name>`         |
| 强制断电      | `virsh destroy <vm_name>`          |
| 重启        | `virsh reboot <vm_name>`           |
| 挂起        | `virsh suspend <vm_name>`          |
| 恢复        | `virsh resume <vm_name>`           |
| 删除虚拟机定义   | `virsh undefine <vm_name> --nvram` |
| 进入控制台     | `virsh console <vm_name>`          |
| 导出虚拟机配置     | `virsh dumpxml <vm_name> > xxx.xml`          |
| 从 XML 还原虚拟机定义     | `virsh define xxx.xml`          |
| 编辑虚拟机配置     | `virsh edit <vm_name>`          |
| 设置开机自启     | `virsh autostart <vm_name>`          |
| 查看开机自启     | `virsh list --autostart`          |


示例：

```bash
virsh list --all
virsh shutdown rocky10-vm
virsh start rocky10-vm
virsh undefine rocky10-vm --nvram
virsh dumpxml vm-rocky10-01  > vm-rocky10-01.xml
virsh define vm-rocky10-01.xml
virsh autostart vm-rocky10-01
```

### 从 XML 还原虚拟机步骤

适用于已经备份了虚拟机 XML 配置，或将虚拟机迁移到另一台 KVM 宿主机后重新导入定义的场景。

```bash
# 1. 在原宿主机导出虚拟机配置
virsh dumpxml vm-rocky10-01 > vm-rocky10-01.xml

# 2. 将 XML 和虚拟磁盘文件复制到目标宿主机
# 例如磁盘文件通常位于 /var/lib/libvirt/images/ 或自定义目录

# 3. 按需检查并修改 XML 中的磁盘路径、网络桥接名称、PCI 直通设备等配置
vim vm-rocky10-01.xml

# 4. 在目标宿主机导入虚拟机定义
virsh define vm-rocky10-01.xml

# 5. 设置开机自启并启动虚拟机
virsh autostart vm-rocky10-01
virsh start vm-rocky10-01
```

- `virsh define` 恢复的是虚拟机定义（XML 配置），不会自动复制 `.qcow2` 等磁盘文件。
- 如果目标宿主机已经存在同名虚拟机，建议先执行 `virsh undefine <vm_name> --nvram` 后再重新导入。
- 如果 XML 中引用了桥接网卡、存储路径、PCI 设备直通等信息，需要先按目标宿主机环境调整。
- `virsh restore` 用于恢复 `virsh save` 生成的运行状态文件，不用于从 XML 导入虚拟机定义。




---

## 六、故障排查

### 1. virt-manager 找不到（未找到匹配的参数）

在 Rocky Linux 10 上，`virt-manager` 和 `virt-viewer` 来自 **AppStream** 仓库。若 `dnf install virt-manager` 报「没有任何匹配」，按下面步骤检查：

**① 确认已启用 AppStream 并刷新缓存：**

```bash
sudo dnf clean all
sudo dnf makecache
dnf repolist enabled
```

确认列表中有 `appstream`。若没有：

```bash
sudo dnf config-manager --set-enabled appstream
sudo dnf makecache
```

**② 搜索包是否可见：**

```bash
dnf search virt-manager
```

若仍无结果，检查网络与镜像（如 `/etc/yum.repos.d/` 中 Rocky 源是否可达）。

**③ 不依赖图形界面时**：可只装命令行工具，用 `virt-install` + `virsh` 管理虚拟机，无需 virt-manager：

```bash
sudo dnf install -y qemu-kvm libvirt virt-install libguestfs-tools bridge-utils
```

**④ 若为 Minimal 或 Server 安装**：未装图形桌面时，virt-manager 可能因依赖 GUI 库而难以解析。可先安装基础 KVM 与 libvirt（如上），图形管理改用本机/其他机器的 **SSH 远程** 或 **Web 控制台**（如 cockpit-machines）。

### 2. 虚拟化未开启

- 在 BIOS 中启用 Intel VT-x / AMD-V。
- 若在虚拟机中再装 KVM，需开启嵌套虚拟化（nested virtualization）。

### 3. 权限不足

- 确认用户已在 `libvirt` 组：`groups`
- 执行 `newgrp libvirt` 或重新登录。

### 4. 无法连接 libvirtd

```bash
sudo systemctl restart libvirtd
sudo systemctl status libvirtd
```

### 5. 查看可用 os-variant

```bash
osinfo-query os
```

可从中选择与系统最接近的变体（如 `rocky10`）以优化虚拟硬件。

---

## 七、小结

1. 安装 `qemu-kvm`、`libvirt`、`virt-install`（及可选的 `virt-manager`）。
2. 将用户加入 `libvirt` 组并启用 `libvirtd`。
3. 按需配置桥接网络，使虚拟机与宿主机同网段。
4. 使用 `virt-install` 或 `virt-manager` 创建虚拟机，用 `virsh` 进行日常管理。

完成以上步骤后，即可在 Rocky Linux 10 上正常使用 KVM 虚拟化。




 
