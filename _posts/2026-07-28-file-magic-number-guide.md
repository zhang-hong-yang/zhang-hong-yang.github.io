---
title: 文件头 Magic Number 识别与查看指南
description: 从原理到实践，介绍文件 Magic Bytes 的含义、常见格式对照表，以及用 Linux 命令、Python、JavaScript 读取与识别文件头的方法。
date: 2026-07-28 17:00:00 +0800
categories: [教程, 开发]
tags: [文件格式, Magic Number, xxd, Python, JavaScript, 十六进制]
order: 21
---

改个扩展名就能「伪装」文件类型——这在日常里很常见，但在程序里靠扩展名判断文件类型并不可靠。更靠谱的做法是读取文件开头的 **Magic Number**（也叫 Magic Bytes、File Signature）：格式规范约定的固定字节序列，通常位于文件偏移 0 处。

本文整理了一份实用的 Magic 对照表，并介绍如何用命令行和代码查看、识别文件头。

## 你将学到什么

- Magic Number 是什么，以及它和扩展名的关系
- 如何阅读 `xxd` 等工具的十六进制输出
- 常见文档、压缩包、图片等格式的 Magic 对照
- Linux 下 `xxd`、`file`、`od`、`hexdump` 的用法
- Python / JavaScript 中读取文件头并做轻量识别的示例
- Magic 在加密文件检测场景中的意义

---

## 一、什么是文件 Magic

文件 Magic Number 是格式规范约定的固定字节序列。例如：

- PNG 通常以 `89 50 4E 47 0D 0A 1A 0A` 开头
- ZIP 通常以 `50 4B 03 04` 开头，其中 `50 4B` 按 ASCII 解释就是 `PK`

扩展名只是文件名的一部分，可以随意修改；Magic 来自文件实际内容，识别文件类型时通常比扩展名更可靠。

但 Magic **也不是**完整的格式校验，需要注意：

- 文件可以伪造正确的 Magic，后续内容却是无效的
- 文件可能损坏或被截断，只剩下正确文件头
- 多种格式可能共用同一个容器 Magic（例如 DOCX/XLSX/PPTX 都是 ZIP）
- 有些格式的标记不在偏移 0（例如 WebP、AVIF）
- 文本格式（例如 SVG）可能没有唯一固定的二进制 Magic
- 文件被外层加密后，原始 Magic 通常会消失

因此，更可靠的判断方式是：

```text
扩展名 + Magic + 固定偏移标记 + 容器内部结构
```

---

## 二、如何阅读十六进制输出

执行：

```bash
xxd -l 32 -g 1 example.png
```

典型输出：

```text
00000000: 89 50 4e 47 0d 0a 1a 0a 00 00 00 0d 49 48 44 52  .PNG........IHDR
00000010: 00 00 07 80 00 00 04 38 08 06 00 00 00 ...       .......8.....
```

三列分别表示：

1. `00000000`：当前行第一个字节在文件中的偏移
2. 中间部分：文件内容的十六进制字节
3. 右侧：可打印字节对应的 ASCII 文本，不可打印字节显示为 `.`

`89 50 4e 47 0d 0a 1a 0a` 就是 PNG Magic。十六进制不区分大小写，`4E` 和 `4e` 表示同一个字节。

---

## 三、常见 Magic 对照表

### 3.1 文档和 Office 文件

| 文件类型 | 常见扩展名 | 偏移 | Magic / 检查方式 | 说明 |
|---|---|---:|---|---|
| PDF | `.pdf` | 0 | `25 50 44 46 2D` | ASCII `%PDF-`；还应在文件尾检查 `startxref` 和 `%%EOF` |
| OLE Compound File | `.doc` `.xls` `.ppt` | 0 | `D0 CF 11 E0 A1 B1 1A E1` | 旧版 Office 容器，部分 Office 密码保护或 IRM 文件也使用它 |
| OOXML Word | `.docx` | 0 | 通常为 ZIP Magic | ZIP 内还应包含 `[Content_Types].xml` 和 `word/` |
| OOXML Excel | `.xlsx` | 0 | 通常为 ZIP Magic | ZIP 内还应包含 `[Content_Types].xml` 和 `xl/` |
| OOXML PowerPoint | `.pptx` | 0 | 通常为 ZIP Magic | ZIP 内还应包含 `[Content_Types].xml` 和 `ppt/` |

DOCX、XLSX、PPTX 本质上都是 ZIP 容器。仅看到 `50 4B 03 04` 只能说明文件「像 ZIP」，不能区分它究竟是 Word、Excel、PowerPoint 还是普通 ZIP。

### 3.2 压缩包

| 文件类型 | 常见扩展名 | 偏移 | Magic | 说明 |
|---|---|---:|---|---|
| ZIP（普通条目） | `.zip` | 0 | `50 4B 03 04` | ASCII `PK` |
| ZIP（空包） | `.zip` | 0 | `50 4B 05 06` | 文件可直接从 EOCD 开始 |
| ZIP（分卷） | `.zip` | 0 | `50 4B 07 08` | Spanned ZIP |
| RAR 1.5～4.x | `.rar` | 0 | `52 61 72 21 1A 07 00` | 前四字节为 ASCII `Rar!` |
| RAR 5.x | `.rar` | 0 | `52 61 72 21 1A 07 01 00` | RAR5 版本签名 |
| 7-Zip | `.7z` | 0 | `37 7A BC AF 27 1C` | 前两个字节为 ASCII `7z` |
| Gzip | `.gz` | 0 | `1F 8B` | 常见后续压缩方法字节为 `08` |
| Bzip2 | `.bz2` | 0 | `42 5A 68` | ASCII `BZh` |
| XZ | `.xz` | 0 | `FD 37 7A 58 5A 00` | 中间字节可读为 `7zXZ` |

普通的密码 ZIP/RAR 通常仍然保留容器 Magic。密码保护条目与「整个文件被外层加密」不是同一件事：后者通常会使原来的 `PK` 或 `Rar!` 文件头消失。

### 3.3 图片文件

| 文件类型 | 常见扩展名 | 偏移 | Magic / 检查方式 | 说明 |
|---|---|---:|---|---|
| JPEG | `.jpg` `.jpeg` | 0 | `FF D8 FF` | `FF D8` 是 SOI（Start Of Image） |
| PNG | `.png` | 0 | `89 50 4E 47 0D 0A 1A 0A` | 偏移 12 通常还有 ASCII `IHDR` |
| GIF87a | `.gif` | 0 | `47 49 46 38 37 61` | ASCII `GIF87a` |
| GIF89a | `.gif` | 0 | `47 49 46 38 39 61` | ASCII `GIF89a` |
| BMP | `.bmp` | 0 | `42 4D` | ASCII `BM` |
| TIFF（小端） | `.tif` `.tiff` | 0 | `49 49 2A 00` | ASCII `II` + 小端整数 42 |
| TIFF（大端） | `.tif` `.tiff` | 0 | `4D 4D 00 2A` | ASCII `MM` + 大端整数 42 |
| WebP | `.webp` | 0、8 | 偏移 0 为 `52 49 46 46`，偏移 8 为 `57 45 42 50` | ASCII `RIFF....WEBP`；中间 4 字节是长度，不固定 |
| ICO | `.ico` | 0 | `00 00 01 00` | Windows 图标 |
| AVIF | `.avif` | 4、8 | 偏移 4 为 `66 74 79 70`，偏移 8 常见 `avif`/`avis` | ISO BMFF 容器 |
| HEIC/HEIF | `.heic` `.heif` | 4、8 | 偏移 4 为 `66 74 79 70`，偏移 8 检查品牌 | 常见品牌包括 `heic`、`heix`、`mif1` |
| SVG | `.svg` | 不固定 | 文本中出现 `<svg` | 可能先有 BOM、空白或 `<?xml ...?>`，没有唯一二进制 Magic |

`ftyp` 不是 AVIF/HEIF 独有标记，MP4、3GP 等格式也使用 ISO BMFF 容器，所以必须继续检查偏移 8 的主品牌（major brand）。

### 3.4 其他常见格式

| 文件类型 | 常见扩展名 | 偏移 | Magic | 说明 |
|---|---|---:|---|---|
| Windows PE/DOS | `.exe` `.dll` | 0 | `4D 5A` | ASCII `MZ`；PE 还需根据 DOS 头找到 `PE\0\0` |
| Linux ELF | 无固定扩展名、`.so` | 0 | `7F 45 4C 46` | 后三字节为 ASCII `ELF` |
| Java Class | `.class` | 0 | `CA FE BA BE` | Java 字节码 |
| SQLite 3 | `.sqlite` `.db` | 0 | `53 51 4C 69 74 65 20 66 6F 72 6D 61 74 20 33 00` | ASCII `SQLite format 3\0` |
| UTF-8 BOM | `.txt` 等 | 0 | `EF BB BF` | 可选的 UTF-8 字节序标记 |
| UTF-16 LE BOM | `.txt` 等 | 0 | `FF FE` | 小端 UTF-16 |
| UTF-16 BE BOM | `.txt` 等 | 0 | `FE FF` | 大端 UTF-16 |

---

## 四、Linux 命令查看文件头

### 4.1 使用 `xxd`

查看整个文件的十六进制表示：

```bash
xxd React-logo.png
```

只显示前 100 字节：

```bash
xxd -l 100 React-logo.png
```

以每个字节为一组显示前 64 字节，最适合对照 Magic：

```bash
xxd -l 64 -g 1 React-logo.png
```

从偏移 8 开始显示 16 字节（适合 WebP 等偏移标记）：

```bash
xxd -s 8 -l 16 -g 1 example.webp
```

只输出连续十六进制文本：

```bash
xxd -l 32 -p React-logo.png
```

将十六进制转储保存为文本文件，可用 `xxd -r` 反向恢复：

```bash
xxd React-logo.png > React-logo.hex
xxd -r React-logo.hex restored.png
```

文件名包含空格时必须加引号：

```bash
xxd -l 64 -g 1 "my image.png"
```

### 4.2 使用 `file`

让系统的 Magic 数据库自动判断文件类型：

```bash
file React-logo.png
file --mime-type React-logo.png
```

`file` 很方便，但安全程序仍应自行验证所需格式的结构，不应把命令输出当成绝对可信结论。

### 4.3 使用 `od` 和 `hexdump`

只读取前 32 字节，逐字节输出十六进制：

```bash
od -An -tx1 -N 32 React-logo.png
```

规范格式，同时显示十六进制和 ASCII：

```bash
hexdump -C -n 64 React-logo.png
```

部分精简 Linux 环境可能没有 `xxd` 或 `hexdump`，但通常至少可以使用 `od`。也可以组合 `head`：

```bash
head -c 64 React-logo.png | xxd -g 1
```

---

## 五、Python 读取文件头

### 5.1 读取并打印前 64 字节

```python
from pathlib import Path


def read_header(path: str | Path, length: int = 64) -> bytes:
    """以二进制方式读取文件头，不加载整个文件。"""
    with Path(path).open("rb") as file:
        return file.read(length)


header = read_header("React-logo.png")

print("紧凑格式:", header.hex())
print("逐字节格式:", " ".join(f"{byte:02X}" for byte in header))
```

必须使用 `"rb"` 二进制模式。文本模式会进行字符解码和可能的换行转换，不适合检查原始文件字节。

### 5.2 从指定偏移读取

```python
from pathlib import Path


def read_at(path: str | Path, offset: int, length: int) -> bytes:
    with Path(path).open("rb") as file:
        file.seek(offset)
        return file.read(length)


# WebP 的第二个关键标记位于偏移 8。
print(read_at("example.webp", 8, 4))  # 预期为 b"WEBP"
```

### 5.3 根据 Magic 做轻量识别

```python
from pathlib import Path


MAGIC = {
    "png": bytes.fromhex("89 50 4E 47 0D 0A 1A 0A"),
    "jpeg": bytes.fromhex("FF D8 FF"),
    "gif87a": b"GIF87a",
    "gif89a": b"GIF89a",
    "pdf": b"%PDF-",
    "ole_office": bytes.fromhex("D0 CF 11 E0 A1 B1 1A E1"),
    "zip": bytes.fromhex("50 4B 03 04"),
    "empty_zip": bytes.fromhex("50 4B 05 06"),
    "spanned_zip": bytes.fromhex("50 4B 07 08"),
    "rar4": bytes.fromhex("52 61 72 21 1A 07 00"),
    "rar5": bytes.fromhex("52 61 72 21 1A 07 01 00"),
}


def detect_magic(path: str | Path) -> str | None:
    with Path(path).open("rb") as file:
        header = file.read(64)

    for kind, signature in MAGIC.items():
        if header.startswith(signature):
            return kind

    # WebP 不是一段完全连续且固定的 Magic：中间包含 4 字节长度。
    if header[:4] == b"RIFF" and header[8:12] == b"WEBP":
        return "webp"

    # AVIF/HEIF 的 ftyp 位于偏移 4，主品牌位于偏移 8。
    if header[4:8] == b"ftyp":
        brand = header[8:12]
        if brand in {b"avif", b"avis"}:
            return "avif"
        if brand in {b"heic", b"heix", b"hevc", b"hevx", b"mif1", b"msf1"}:
            return "heif"

    return None


print(detect_magic("React-logo.png"))
```

这只是轻量识别。生产环境还应该验证文件长度、结束标记、块结构、ZIP 中央目录或格式对应的内部结构。

### 5.4 命令行版本

保存为 `show_magic.py`：

```python
import argparse
from pathlib import Path


parser = argparse.ArgumentParser(description="显示文件头十六进制字节")
parser.add_argument("file", type=Path)
parser.add_argument("-n", "--length", type=int, default=64)
args = parser.parse_args()

with args.file.open("rb") as file:
    header = file.read(args.length)

print(" ".join(f"{byte:02X}" for byte in header))
```

运行：

```bash
python3 show_magic.py React-logo.png
python3 show_magic.py React-logo.png -n 100
```

---

## 六、JavaScript 读取文件头

JavaScript 需要区分 Node.js 和浏览器环境。Node.js 可以通过文件路径访问磁盘；浏览器出于安全限制，只能读取用户主动选择或拖入页面的 `File`。

### 6.1 Node.js：只读取文件头

以下示例使用 ESM，保存为 `show-magic.mjs`：

```javascript
import { open } from 'node:fs/promises'


async function readHeader(path, length = 64, position = 0) {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, position)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}


function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0'))
      .join(' ')
      .toUpperCase()
}


const path = process.argv[2]
const length = Number(process.argv[3] ?? 64)

if (!path) {
  console.error('用法: node show-magic.mjs <文件> [读取字节数]')
  process.exitCode = 1
} else {
  const header = await readHeader(path, length)
  console.log(toHex(header))
}
```

这里使用 `open()` + `read()`，只读取需要的范围，不会像 `readFile()` 那样把整个大文件载入内存。

### 6.2 Node.js：匹配 Magic

```javascript
const MAGIC = {
  png: Buffer.from('89504E470D0A1A0A', 'hex'),
  jpeg: Buffer.from('FFD8FF', 'hex'),
  pdf: Buffer.from('255044462D', 'hex'),
  oleOffice: Buffer.from('D0CF11E0A1B11AE1', 'hex'),
  zip: Buffer.from('504B0304', 'hex'),
  emptyZip: Buffer.from('504B0506', 'hex'),
  rar4: Buffer.from('526172211A0700', 'hex'),
  rar5: Buffer.from('526172211A070100', 'hex'),
}


function startsWithBytes(buffer, signature) {
  return (
    buffer.length >= signature.length &&
    buffer.subarray(0, signature.length).equals(signature)
  )
}


function detectMagic(header) {
  for (const [kind, signature] of Object.entries(MAGIC)) {
    if (startsWithBytes(header, signature)) return kind
  }

  if (
    header.subarray(0, 4).toString('ascii') === 'RIFF' &&
    header.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return 'webp'
  }

  return null
}
```

### 6.3 浏览器：读取用户选择的文件

```html
<input id="fileInput" type="file">
<pre id="output"></pre>
```

```javascript
const input = document.querySelector('#fileInput')
const output = document.querySelector('#output')

input.addEventListener('change', async () => {
  const file = input.files?.[0]
  if (!file) return

  // File.slice() 只截取前 64 字节，不加载整个文件。
  const arrayBuffer = await file.slice(0, 64).arrayBuffer()
  const bytes = new Uint8Array(arrayBuffer)
  const hex = Array.from(
    bytes,
    byte => byte.toString(16).padStart(2, '0').toUpperCase(),
  ).join(' ')

  output.textContent = [
    `文件名: ${file.name}`,
    `大小: ${file.size} bytes`,
    `文件头: ${hex}`,
  ].join('\n')
})
```

浏览器提供的 `file.type` 来自 MIME 信息或扩展名推断，不能替代对实际字节的检查。

---

## 七、对加密文件检测的意义

高熵不等于加密。正常 ZIP、JPEG、PNG、PDF 或压缩型 Office 文件也可能有很高的熵。因此，加密文件检测应该先识别正常格式：

```text
扩展名受支持
&& 未识别到正常 Magic/结构
&& (文件头熵达到阈值 || 命中特定加密样本特征)
```

几个典型场景：

- 正常 ZIP 即使熵为 7.95，只要保留 `50 4B 03 04`，仍应优先视为正常 ZIP
- `.zip` 文件的 `PK` 签名消失，文件头又呈高熵随机数据，才属于疑似外层加密
- 仅修改扩展名不会改变 Magic
- 只伪造 Magic 也不能让整个文件结构变得合法

---

## 八、参考资料

- [Wikipedia：List of file signatures](https://en.wikipedia.org/wiki/List_of_file_signatures)
- [Magic Bytes 在线对照工具](https://tool.lu/en_US/magicbytes/)
- [掘金：十六进制的秘密——文件解析、文件格式校验、文件签名](https://juejin.cn/post/7426638953603170331)
- [Debian `xxd(1)` 手册](https://manpages.debian.org/wheezy/vim-common/xxd.1.en.html)
- [Python 官方教程：文件读写](https://docs.python.org/3/tutorial/inputoutput.html)
- [Node.js 官方文档：File system](https://nodejs.org/api/fs.html)
