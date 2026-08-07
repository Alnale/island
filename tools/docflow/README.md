# DocFlow — DOC/DOCX ↔ PDF 双向转换工具

一款功能强大的文档转换工具，支持 Word 文档与 PDF 之间的双向转换，以及 PDF/DOC/DOCX 转 Markdown，具备智能 OCR 识别能力，可处理扫描版 PDF。

## 功能特性

### 三种转换模式

- **DOC/DOCX → PDF**: 通过 Microsoft Word COM 接口实现高质量转换
- **PDF → DOCX**: 原生 PDF 直接转换 + 扫描版 OCR 识别
- **转 Markdown**: PDF/DOC/DOCX → Markdown，保留文档结构、表格和图片；支持从 Markdown 生成思维导图（SVG/PNG）

### 智能 OCR 引擎

- 基于 RapidOCR (PaddleOCR ONNX) 的自研 OCR 引擎
- 支持中英文混合识别
- 智能图像预处理（对比度增强、去噪、自适应阈值）
- 自动表格结构检测与重建
- Tesseract OCR 降级支持

### 混合文档处理

- 自动检测页面类型（原生/扫描混合）
- 按页面类型智能路由转换流程
- 合并多部分转换结果

### 思维导图生成

- 从 Markdown 转换结果生成思维导图
- 支持 SVG（矢量）和 PNG（位图）格式
- 基于 kmind 引擎，需 Node.js 和 Chrome/Edge 浏览器

### 高级功能

- 批量文件转换
- 实时进度显示
- PDF/DOCX 预览功能（支持缩放、拖拽、多页滚动）
- Markdown 渲染预览与源码视图切换
- 转换历史管理（支持筛选、批量删除）
- 预设系统（保存/加载/重命名转换配置）
- 自定义字体支持（TTF/OTF/WOFF）
- 自定义背景图片
- 背景音乐播放器（支持单曲/列表循环）
- 图像质量分析与 DPI 自动推荐
- 音频帮助提示
- 帮助手册演示动画（自动播放转换流程演示）
- 构造主义/解构主义 UI 设计风格

## 系统要求

- Windows 操作系统
- Microsoft Word（用于 DOC→PDF 转换，PDF→DOCX 和转 MD 模式可不用）
- Python 3.10+
- Node.js（用于思维导图生成，可选）
- Chrome / Edge / Brave 浏览器（用于思维导图渲染，可选）

## 安装

### 1. 克隆仓库

```bash
git clone <repository-url>
cd DocFlow
```

### 2. 安装依赖

```bash
pip install -r requirements.txt
```

### 3. 启动服务

```bash
python server.py
```

服务启动后，浏览器将自动打开 `http://localhost:5000`

## 依赖说明

| 依赖包 | 用途 |
|--------|------|
| Flask | Web 服务框架 |
| pywin32 | Windows COM 接口（Word 集成） |
| PyMuPDF | PDF 处理与渲染 |
| pdf2docx | 原生 PDF 转 DOCX |
| opencv-python-headless | 图像预处理 |
| scipy | 数值计算（表格检测） |
| lxml | XML/HTML 解析 |
| python-docx | DOCX 文件操作 |
| rapidocr-onnxruntime | OCR 文字识别 |
| pypdf | PDF 后处理（密码保护、权限控制） |

## 项目结构

```
DocFlow/
├── server.py          # Flask 后端服务
├── ocr_engine.py      # 自研 OCR 引擎
├── app.js             # 前端逻辑
├── index.html         # 主页面
├── styles.css         # 样式文件
├── requirements.txt   # Python 依赖
├── docflow.db         # SQLite 数据库
├── fonts/             # 自定义字体
├── help_docs/         # 帮助文档（Markdown 格式）
├── music/             # 背景音乐（MP3 格式）
├── kmind-markdown-to-mindmap-0.1.0/  # 思维导图引擎
├── output/            # 转换输出目录（按时间戳子目录）
├── temp/              # 临时预览文件
├── uploads/           # 上传文件临时存储
├── pdf.min.js         # PDF.js 主文件
├── pdf.worker.min.js  # PDF.js Worker
├── icon.png           # 应用图标
└── READ.mp3           # 帮助音频（可选）
```

## API 接口

### 文件上传

```http
POST /api/upload
Content-Type: multipart/form-data

files: <文件列表>
```

### 开始转换

```http
POST /api/convert/<job_id>
Content-Type: application/json

{ "imageDpi": 300, "ocrEnabled": true, ... }
```

### 重新转换

```http
POST /api/reconvert/<job_id>
Content-Type: application/json

{ ... }  // 新的转换参数
```

### 查询状态

```http
GET /api/status/<job_id>
```

### 下载文件

```http
GET /api/download/<job_id>
GET /api/download-all    # 批量下载所有完成的任务（ZIP）
```

### 预览文件

```http
GET /api/preview/<job_id>        # 输出 PDF 预览
GET /api/preview-source/<job_id> # 源 PDF 预览（PDF→DOCX）
GET /api/preview-docx/<job_id>   # DOCX 转 PDF 预览（重新转换时）
GET /api/markdown/<job_id>       # Markdown 内容
GET /api/image/<job_id>/<文件名> # Markdown 中的图片
```

### 历史记录

```http
GET    /api/history              # 查询历史（支持 ?type= 筛选）
DELETE /api/history/<job_id>     # 删除单条记录
DELETE /api/history              # 清空所有历史
```

### 元数据

```http
GET /api/metadata/<job_id>       # 获取文件元数据
```

### OCR 引擎状态

```http
GET /api/engine                  # 返回 Word 和 OCR 引擎可用性
```

### 思维导图

```http
GET  /api/mindmap-check          # 预检 kmind 和 Node.js 可用性
POST /api/mindmap/<job_id>       # 生成思维导图（SVG/PNG）
```

### 字体管理

```http
GET    /api/font                 # 获取当前自定义字体信息
POST   /api/font                 # 上传自定义字体（TTF/OTF/WOFF）
DELETE /api/font                 # 删除自定义字体
GET    /api/font-file            # 获取字体文件
```

### 背景音乐

```http
GET /api/music/list              # 列出可用背景音乐
```

### 活跃任务

```http
GET /api/active-jobs             # 获取当前正在处理的任务列表
```

## 转换选项

### DOC→PDF 选项

| 选项 | 类型 | 说明 |
|------|------|------|
| `pdfVersion` | 选择 | PDF 版本（1.5/1.6/1.7） |
| `pageSize` | 选择 | 页面尺寸（A4/Letter/Legal） |
| `orientation` | 选择 | 页面方向（纵向/横向） |
| `imageDpi` | 选择 | 图像分辨率（72/150/300/600） |
| `embedFonts` | 开关 | 嵌入 TrueType 字体 |
| `losslessImages` | 开关 | 无损图像模式（禁用压缩） |
| `passwordProtect` | 开关 | 密码保护（AES-256 加密） |
| `allowPrinting` | 开关 | 允许打印 |
| `allowCopying` | 开关 | 允许复制内容 |
| `autoDownload` | 开关 | 完成后自动下载 |
| `keepHistory` | 开关 | 保存转换记录 |

### PDF→DOCX 选项

| 选项 | 类型 | 说明 |
|------|------|------|
| `tableMode` | 选择 | 表格识别模式（严格/自动/宽松） |
| `ignoreEdges` | 开关 | 忽略页眉页脚区域 |
| `ocrEnabled` | 开关 | 启用 OCR 识别扫描页 |
| `imageDpi` | 选择 | 图片提取分辨率（72/150/300） |
| `extractImages` | 开关 | 提取文档中的图片 |
| `keepStyle` | 开关 | 保留原始排版样式 |
| `autoDownload` | 开关 | 完成后自动下载 |
| `keepHistory` | 开关 | 保存转换记录 |

### 转 MD 选项

| 选项 | 类型 | 说明 |
|------|------|------|
| `ocrEnabled` | 开关 | 对扫描页启用 OCR 识别 |
| `extractImages` | 开关 | 提取文档图片到 media/ 目录 |
| `autoDownload` | 开关 | 完成后自动下载 |
| `keepHistory` | 开关 | 保存转换记录 |

## 技术亮点

1. **智能页面分类**: 基于文本密度和图像覆盖率自动识别扫描页
2. **表格结构重建**: 通过投影分析和网格检测还原表格布局
3. **多引擎 OCR**: RapidOCR 为主，Tesseract 为备用
4. **图像预处理**: CLAHE 增强、自适应阈值、去噪
5. **混合文档处理**: 原生页与扫描页分别处理，结果合并
6. **PDF 安全控制**: 支持密码保护和权限管理（打印/复制）
7. **思维导图生成**: 基于 Markdown 标题层级自动生成 SVG/PNG 思维导图
8. **预设系统**: 保存/加载/重命名转换配置，支持跨模式继承
9. **自定义外观**: 支持自定义字体和背景图片，全局应用毛玻璃效果
10. **音频帮助**: 打开帮助时自动播放音频提示（需放置 READ.mp3）

## 许可证

Boost Software License - Version 1.0 - August 17th, 2003

```
Permission is hereby granted, free of charge, to any person or organization
obtaining a copy of the software and accompanying documentation covered by
this license (the "Software") to use, reproduce, display, distribute,
execute, and transmit the Software, and to prepare derivative works of the
Software, and to permit third-parties to whom the Software is furnished to
do so, all subject to the following:

The copyright notices in the Software and this entire statement, including
the above license grant, this restriction and the following disclaimer,
must be included in all copies of the Software, in whole or in part, and
all derivative works of the Software, unless such copies or derivative
works are solely in the form of machine-executable object code generated by
a source language processor.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE, TITLE AND NON-INFRINGEMENT. IN NO EVENT
SHALL THE COPYRIGHT HOLDERS OR ANYONE DISTRIBUTING THE SOFTWARE BE LIABLE
FOR ANY DAMAGES OR OTHER LIABILITY, WHETHER IN CONTRACT, TORT OR OTHERWISE,
ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
DEALINGS IN THE SOFTWARE.
```

## 作者

DocFlow Development Team

---

*Made with ❤️ for document conversion*
