# Rocky Linux 10 KVM 显卡直通完整步骤（适配当前 4 张 NVIDIA 服务器卡）

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
- BMC 显卡：`0000:02:00.0` ASPEED `1a03:2000`（宿主机管理显示）
- NVIDIA 卡：
  - `0000:38:00.0` `10de:2bb5`
  - `0000:49:00.0` `10de:2bb5`
  - `0000:98:00.0` `10de:2bb5`
  - `0000:b8:00.0` `10de:2bb5`

> 这 4 张 NVIDIA 卡同 ID（`10de:2bb5`），因此“按 ID 绑定”会全绑，“按 BDF 地址绑定”可只绑指定几张。

---

## 1. 前提检查

### 1.1 BIOS/UEFI

确认开启：

- `Intel VT-d`
- `SR-IOV`（可选，非必须）
- `Above 4G Decoding`（建议开启，避免大显存 BAR 资源冲突）

### 1.2 宿主机安装 KVM 组件

```bash
sudo dnf install -y \
  qemu-kvm libvirt libvirt-daemon libvirt-client \
  virt-install virt-manager virt-viewer \
  edk2-ovmf pciutils driverctl

sudo systemctl enable --now libvirtd
```

---

## 2. 启用 IOMMU（必须）

你当前 `dmesg` 已看到 DMAR，但 `cmdline` 缺少 `intel_iommu=on`，建议明确写入。

```bash
sudo grubby --args="intel_iommu=on iommu=pt" --update-kernel=ALL

cat /etc/default/grub

sudo reboot
```

grubby 是修改 /etc/default/grub 

重启后验证：

```bash
cat /proc/cmdline
# 期望看到 intel_iommu=on iommu=pt

dmesg | grep -Ei 'DMAR|IOMMU'
```

---

## 3. IOMMU 分组查看（修复你之前的报错）

你之前报 `IOMMU Group *` 是因为 glob 没匹配到目录。请用下面这个“防空目录”版本：

```bash
for g in /sys/kernel/iommu_groups/*; do
  [ -d "$g" ] || { echo "IOMMU groups not found. Check BIOS VT-d and kernel cmdline."; break; }
  echo "IOMMU Group ${g##*/}:"
  for d in "$g"/devices/*; do
    echo "  $(lspci -nns ${d##*/})"
  done
done
```

---

## 4. 统一使用 `driverctl set-override`

这份文档只保留一种绑定方式：`driverctl set-override`。

选择这套方式的原因：

- 这 4 张 NVIDIA 卡的 PCI ID 都是 `10de:2bb5`。如果使用 `vfio-pci.ids=10de:2bb5` 这种“按 ID 绑定”，4 张卡会一次性全部绑到 `vfio-pci`，无法只挑其中几张。
- `driverctl set-override` 是按 BDF 地址绑定，例如 `0000:38:00.0`，可以精确决定哪几张给 VM，哪几张留给宿主机。
- 如果你最终就是想 4 张卡全部直通，也仍然可以继续用 `driverctl`，把 4 个 BDF 都 override 即可，不需要再维护第二套“全绑”方案。
- `grubby` 写内核参数的方式改动快、重启后立即生效；`/etc/modprobe.d/` 的黑名单方式更持久、更稳定。两者都可以继续作为“防止宿主机驱动抢卡”的辅助手段，但它们不再承担“按哪张卡绑定”的职责。
- 使用 `driverctl` 后，不需要再额外写 `rd.driver.pre=vfio-pci` 或 `vfio-pci.ids=...`。只要第 2 节的 IOMMU 已开启，目标卡完成 override，重启后就会由 `vfio-pci` 接管。

### 4.1 先清理旧的“按 ID 全绑”参数（若之前配过）

如果你之前试过“按 ID 全绑”，先把旧参数清掉，避免 4 张卡再次被一起绑定：

```bash
sudo grubby --remove-args="rd.driver.pre=vfio-pci vfio-pci.ids=10de:2bb5" --update-kernel=ALL
sudo grubby --args="intel_iommu=on iommu=pt" --update-kernel=ALL
```

如果你的目标是“宿主机完全不用 NVIDIA，只把这些卡都交给 VM”，可以额外加上宿主机驱动黑名单。这里保留两种方式的说明，但都归并到 `driverctl` 方案下：

- `grubby` 方式优点是快，改一次内核参数、重启后立即生效；缺点是它本质上依赖启动参数，排障时要记得一起检查内核命令行。
- `/etc/modprobe.d/` 方式优点是更持久、更直观；缺点是多维护一个配置文件。
- 实际使用时两者一起保留最省心，尤其是“4 张卡全直通、宿主机完全不跑 NVIDIA”的场景。

```bash
sudo grubby --args="modprobe.blacklist=nouveau,nvidia,nvidia_drm,nvidia_modeset,nvidia_uvm" --update-kernel=ALL

sudo tee /etc/modprobe.d/blacklist-nvidia.conf >/dev/null <<'EOF'
blacklist nouveau
blacklist nvidia
blacklist nvidia_drm
blacklist nvidia_modeset
blacklist nvidia_uvm
EOF

cat /etc/modprobe.d/blacklist-nvidia.conf

sudo dracut -f --regenerate-all
```

说明：

- `modprobe.blacklist=...`：通过内核参数阻止 `nouveau/nvidia` 在启动时抢设备。
- `/etc/modprobe.d/blacklist-nvidia.conf`：让黑名单配置在系统里持久存在。
- `dracut -f --regenerate-all`：重建 initramfs，让新的黑名单在开机早期也能生效。
- 如果你要保留 1 张卡给宿主机做 CUDA/图形，就不要加上面这组 NVIDIA 黑名单；只做 `driverctl set-override` 即可。

### 4.2 用 `driverctl` 按地址绑定目标 GPU

示例 1：绑定 `38/49/98`，保留 `b8` 给宿主机。

```bash
sudo driverctl set-override 0000:38:00.0 vfio-pci
sudo driverctl set-override 0000:49:00.0 vfio-pci
sudo driverctl set-override 0000:98:00.0 vfio-pci

driverctl list-overrides

sudo reboot
```

示例 2：如果你要 4 张 NVIDIA 全部直通，就把 `b8` 也一起 override：

```bash
sudo driverctl set-override 0000:b8:00.0 vfio-pci

driverctl list-overrides

sudo reboot
```

说明：

- `driverctl set-override` 是按设备地址做持久化绑定，重启后仍然有效。
- 不需要额外再执行一条“手工指定 `vfio-pci.ids` 接管”的命令。
- 你只需要决定哪些 BDF 要直通，然后对这些 BDF 执行 `set-override`。

### 4.3 验证结果

```bash
for dev in 38:00.0 49:00.0 98:00.0 b8:00.0; do
  echo "==== $dev ===="
  lspci -nnk -s $dev
done
```

预期：

- 执行过 `set-override` 的卡：`Kernel driver in use: vfio-pci`
- 没有 override 的卡：继续由宿主机默认驱动接管；如果你同时启用了 NVIDIA 黑名单，则它可能显示为未绑定或不会加载 NVIDIA 驱动

---

## 5. 创建虚拟机并分配 GPU

通用建议：

- 机型：`Q35`
- 固件：`OVMF (UEFI)`
- CPU：`host-passthrough`

### 5.1 每台 VM 分配 1 张 GPU（推荐）

例如：

- VM1 -> `0000:38:00.0`
- VM2 -> `0000:49:00.0`
- VM3 -> `0000:98:00.0`
- VM4 -> `0000:b8:00.0`（仅当你也对 `b8` 执行了 `driverctl set-override`）

在 `virt-manager` 里添加 `PCI Host Device` 即可。

### 5.2 libvirt XML 示例（单张卡）

```xml
<cpu mode='host-passthrough' check='none' migratable='off'/>

<hostdev mode='subsystem' type='pci' managed='yes'>
  <source>
    <address domain='0x0000' bus='0x38' slot='0x00' function='0x0'/>
  </source>
</hostdev>
```

> 你的卡目前是 `3D controller` 且未显示 `.1` 音频功能，因此按 `.0` 添加即可。

---

## 6. 运行时验证命令

```bash
# 查看虚拟机
virsh list --all

# 查看每张卡当前驱动
for dev in 38:00.0 49:00.0 98:00.0 b8:00.0; do lspci -nnk -s $dev | grep -E 'controller|Kernel driver'; done

# 查看 vfio 模块
lsmod | grep vfio
```

---

## 7. 常见问题

### 7.1 VM 启动报 IOMMU group 不满足

- 先看第 3 步分组输出。
- 若目标卡与关键设备同组，优先换插槽再测。

### 7.2 VM 内驱动异常

- 确认该 GPU 已是 `vfio-pci`，没被宿主机 nvidia 驱动占用。
- Windows Guest 先安装 VirtIO 驱动，再装 NVIDIA 驱动。

### 7.3 宿主机突然看不到 NVIDIA

- 如果你把 4 张卡都做了 `driverctl set-override`，这是预期行为。
- 如果你想保留 1 张给宿主机，确认该卡没有执行 `set-override`，并且没有把 `nvidia/nouveau` 一并加入黑名单。
- 如需恢复，按第 8 节回滚。

---

## 8. 回滚步骤

### 8.1 回滚 `driverctl` 绑定

```bash
sudo driverctl unset-override 0000:38:00.0
sudo driverctl unset-override 0000:49:00.0
sudo driverctl unset-override 0000:98:00.0
# 若你也绑了 b8，则同样 unset
sudo driverctl unset-override 0000:b8:00.0

driverctl list-overrides
sudo reboot
```

如果你之前还加过“按 ID 全绑”参数或 NVIDIA 黑名单，也一并清掉：

```bash
sudo grubby --remove-args="rd.driver.pre=vfio-pci vfio-pci.ids=10de:2bb5 modprobe.blacklist=nouveau,nvidia,nvidia_drm,nvidia_modeset,nvidia_uvm" --update-kernel=ALL
sudo rm -f /etc/modprobe.d/blacklist-nvidia.conf
sudo dracut -f --regenerate-all
sudo reboot
```

---

## 9. 快速执行清单

- 启用 `intel_iommu=on iommu=pt` 并重启
- 确认 IOMMU 分组正常
- 只对要直通的 GPU 执行 `driverctl set-override`
- 如果 4 张卡都给 VM、宿主机完全不用 NVIDIA，可额外配置 `modprobe.blacklist` 和 `/etc/modprobe.d` 黑名单
- 重启后确认目标卡驱动为 `vfio-pci`
- VM 使用 `Q35 + OVMF + host-passthrough`
- 给每台 VM 添加对应 PCI GPU
