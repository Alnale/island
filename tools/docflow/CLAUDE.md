# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

DocFlow — a Windows-only bidirectional document conversion web app with three modes:
- **DOC → PDF**: Flask backend drives Microsoft Word via COM automation (pywin32)
- **PDF → DOCX**: Pure Python conversion via `pdf2docx` library + RapidOCR for scanned pages
- **转MD (to Markdown)**: PDF/DOC/DOCX → Markdown with optional mindmap generation (SVG/PNG) via kmind

Single-page vanilla JS frontend with PDF.js preview. **All UI strings are in Chinese.**

## Commands

```bash
pip install -r requirements.txt   # Install dependencies
python server.py                  # Start dev server at http://localhost:5000
```

### Build .exe (PyInstaller)

```bash
# NOTE: build.bat and docflow.spec do not currently exist on disk.
# To create them: pyinstaller docflow.spec
# Output: dist/DocFlow/DocFlow.exe  (+ _internal/ folder)
```

Requires Python 3.10+. The `.exe` runs without Python — bundled assets are read-only inside `_internal/`; writable data (`uploads/`, `output/`, `temp/`, `fonts/`, `docflow.db`) is created next to the `.exe`.

## Architecture

**Backend (`server.py`, ~3600 lines):** Flask app with SQLite (`docflow.db`). Each job has a `conversion_type` field (`doc_to_pdf` | `pdf_to_docx` | `to_markdown`). Conversion runs in background threads; DOC→PDF threads call `pythoncom.CoInitialize()`/`CoUninitialize()` for COM apartment threading. Progress is estimated via a time-based ease-out curve in a daemon thread, capping at 95%. Output files go to timestamped subdirectories under `output/`; preview copies go to `temp/`. Server detects frozen PyInstaller state (`sys.frozen`) and sets `BUNDLE_DIR` (read-only) vs `BASE_DIR` (writable) accordingly.

**Database (`docflow.db`):** Single `jobs` table with WAL journal mode. Key columns: `id`, `name`, `status` (pending/processing/done/error), `conversion_type`, `input_path`, `output_path`, `input_size`, `pdf_size`, `docx_size`, `markdown_size`, `pages`, `error`, `created_at`, `finished_at`. Schema migrations use idempotent `ALTER TABLE` (e.g., `conversion_type`, `docx_size`, `markdown_size` columns added incrementally).

**OCR engine (`ocr_engine.py`):** `DocFlowOCR` class wrapping RapidOCR (PaddleOCR ONNX models). Lazy-loaded singleton via `get_ocr_engine()`. Provides `recognize()` (returns regions with text/box/confidence) and `ocr_page()` (returns PDF-point coordinates). Smart preprocessing activates only when image std < 40 (low contrast). `server.py` uses dual-engine fallback: RapidOCR primary, Tesseract fallback for both page-level and cell-level OCR.

**Frontend:** Single-page vanilla JS app split across three files:
- `index.html` — HTML markup only. Server injects custom font `<link>`/`<style>` before `</head>` at serve time.
- `styles.css` — All CSS (~13200 lines): Morandi palette (`oklch()` colors), glassmorphism, layout grid.
- `app.js` — All JS (~7200 lines): state management, API calls, UI rendering, PDF.js integration.

All static files served via explicit Flask routes (no `static_folder`). `help_docs/` contains markdown help files for each conversion mode, served via `/help_docs/<filename>`.

**Key layout:** 3-column CSS Grid (sidebar 280px / center / right panel 340px). Views: convert (upload + queue), history (list + detail), preview (PDF thumbnails + lightbox with zoom/pan).

**State:** Single global `state` object (`{ queues: {doc_to_pdf:[], pdf_to_docx:[], to_markdown:[]}, history, selectedFile, nextId, polling }`). `currentMode` global tracks active mode.

### API endpoints

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/upload` | Upload file, returns job |
| POST | `/api/convert/<job_id>` | Start conversion |
| POST | `/api/reconvert/<job_id>` | Reconvert with new settings |
| GET | `/api/status/<job_id>` | Poll conversion progress |
| GET | `/api/download/<job_id>` | Download output file |
| GET | `/api/download-all` | Download all done as ZIP |
| GET | `/api/preview/<job_id>` | PDF preview (output or temp) |
| GET | `/api/preview-source/<job_id>` | Source PDF preview (PDF→DOCX) |
| GET | `/api/markdown/<job_id>` | Markdown content |
| GET | `/api/history` | List history (filterable) |
| DELETE | `/api/history/<job_id>` | Delete one entry |
| DELETE | `/api/history` | Clear all history |
| GET | `/api/engine` | OCR engine + Word status |
| GET/POST/DELETE | `/api/font` | Custom font management |
| GET/POST/DELETE | `/api/mindmap/<job_id>` | Mindmap generation |
| GET | `/api/mindmap-check` | Pre-flight kmind check |
| GET | `/api/music/list` | List background tracks |

### Dual-mode system

A pill-shaped switcher in the topbar toggles between three modes. `MODE_THEMES` defines per-mode accent colors, upload zone text, and accepted file types. `switchMode()` updates CSS custom properties, re-renders the settings panel, clears the queue, and fetches mode-filtered history.

### Settings & per-file persistence

Settings rendered per mode via `SETTINGS_CONFIG` and `renderSettingsPanel()`. DOC→PDF has 输出/质量/安全/转换后 sections; PDF→DOCX has 布局/内容/转换后 sections; 转MD has 输出/质量/安全/内容/转换后 sections — the first three are marked `_docToPdfOnly` and conditionally hidden when input is PDF (only shown for DOC/DOCX). Each queue item stores its own `settings` object. When viewing a preview, changing settings triggers a debounced POST to `/api/reconvert/<job_id>`.

Two localStorage layers:
- **Per-file settings** (`docflow_file_settings`): keyed by job ID. Each queue item has its own `settings` object persisted here. `applySettings()` reads/writes this.
- **Panel defaults** (`docflow_panel_settings`): keyed by mode (`doc_to_pdf`/`pdf_to_docx`/`to_markdown`). Saves the last-used panel settings so they survive page refresh. `_savePanelSettings()` called on every change; `_applyPanelSettings()` called in `init()` and `switchMode()` after `renderSettingsPanel()`.

### PDF → DOCX conversion pipeline

1. `_classify_pages()` determines scanned vs native per page
2. All native → `pdf2docx` library path (fast)
3. All scanned → `_ocr_scanned_pdf_to_docx()` with RapidOCR/Tesseract, then structural fallback `_structural_form_to_docx()` if OCR quality low
4. Mixed → per-page routing, native pages through pdf2docx, scanned through OCR, results merged

OCR quality checked via `_ocr_output_quality()` (CJK character ratio, threshold 0.1). Cell-level OCR uses `_ocr_cell_region()` for table reconstruction.

### 转MD (to Markdown) conversion pipeline

`convert_to_markdown()` in `server.py` handles PDF/DOC/DOCX → Markdown:
- PDF input: uses PyMuPDF (`fitz`) to extract text blocks, images, and tables; reconstructs Markdown with headings, lists, tables, and image references
- DOC/DOCX input: first converts to PDF via Word COM (if available), then runs PDF→Markdown; falls back to `python-docx` extraction if Word unavailable
- Images extracted to a `media/` subdirectory alongside the `.md` file
- Tables detected via block analysis and converted to Markdown pipe-table format via `_md_table_to_markdown()`
- Preview: `renderMarkdownPreview()` in `app.js` renders the Markdown with a custom renderer; supports view switching between raw/rendered modes

### Mindmap generation (kmind integration)

Mind maps can be generated from Markdown output in `to_markdown` mode:
- **Backend:** `POST /api/mindmap/<job_id>` invokes the `kmind-markdown-to-mindmap` Node.js CLI (`kmind-markdown-to-mindmap-0.1.0/scripts/kmind-render.mjs`) via `subprocess`
- **Pre-flight:** `GET /api/mindmap-check` verifies Node.js and kmind script availability
- **Output:** SVG (default) or PNG with configurable scale. SVG files are post-processed to inject CJK-compatible font stack (`Microsoft YaHei`, `PingFang SC`, etc.) for proper Chinese character rendering
- **Viewport:** Command uses `--viewport-width 2400 --viewport-height 1600` (larger than kmind default) to give CJK text more room
- **Timeout:** 120 seconds. Temp files cleaned up after response
- **Frontend:** Mindmap SVG/PNG buttons in markdown preview header (`generateMindmap()`). Availability cached in `_mindmapCheckCache`

### DOCX image analysis

`analyze_docx_images()` parses DOCX zip to count images, detect PNG/JPEG dimensions, and recommend optimal DPI. Results shown in settings panel and used to auto-adjust DPI for high-res documents.

### Preview & lightbox

- **DOC→PDF jobs:** Output PDF previewed via `/api/preview/<job_id>`.
- **PDF→DOCX jobs:** Source PDF previewed via `/api/preview-source/<job_id>`.
- `pdfCache` (Map) caches loaded PDF.js documents. PDF.js served locally.
- Lightbox supports Ctrl+scroll zoom (25%–400%), double-click toggle, drag-to-pan, touch pinch-to-zoom. Zoom resets to 100% on page change.
- **Reconvert preview cache:** `/api/preview-docx/<job_id>` caches a `{job_id}_preview.pdf` in `TEMP_DIR`. The `/api/reconvert` endpoint deletes this stale cache file before spawning the conversion thread, so subsequent preview requests regenerate from the new DOCX.

### OCR engine status

`/api/engine` endpoint returns both Word availability and OCR engine status (`{ rapidocr, tesseract, primary, chinese_optimized }`). Settings panel shows engine status badge (green=RapidOCR, blue=Tesseract, orange=none with install hint).

### Custom background & font system

- **Background:** User uploads image → compressed to max 1920px → stored as `data:` URL in `localStorage` (`docflow_bg_image`). `body.custom-bg` class activates glassmorphism CSS across every UI element. **New UI elements MUST include `body.custom-bg` variants.**
- **Font:** User uploads TTF/OTF/WOFF → saved to `fonts/custom{ext}` + `fonts/font.json`. Server injects `@font-face` CSS at serve time.

### Background music player

`musicPlayer` object in `app.js` manages a mini audio player in the topbar. Tracks come from `music/` directory (MP3 files). `GET /api/music/list` returns available tracks. Player supports play/pause, next/previous, repeat modes (`single`/`list`), and a seekable progress bar. State (playing, current track index, position) persists to localStorage keys `docflow_music_playing`, `docflow_music_track`, `docflow_music_position`, `docflow_music_mode`.

### Loading overlay

A deconstructivist animated splash screen (2s minimum) with geometric fragments, character-by-character title reveal, and segmented progress bar. Font data preloads during this window. `prefers-reduced-motion` disables all animations.

### Preset system

Presets stored in localStorage (`docflow_presets`) keyed by mode, each containing a name + settings snapshot. CRUD via `_loadAllPresets()`, `_savePresetsForMode()`, `_deletePreset()`, `_renamePreset()`. The preset modal (`_renderPresetModal`) uses `_slideOpen()`/`_slideClose()` Promise-based helpers for expand/collapse animations (max-height + spring cubic-bezier). Drag-and-drop file upload is only active in the `convert` view — disabled in `history` and `preview` views.

### Preset inheritance (cross-mode sync)

"转MD" presets can inherit DOC→PDF settings via `_basePreset` field. Two import paths:

1. **At save time** — `_savePreset(mode, name, settings, basePreset)` stores `_basePreset` on the preset itself. Used when creating/editing a "转MD" preset with a base preset picker.
2. **At import time** — `_importDocToPdfPreset(name)` merges a doc_to_pdf preset's keys into the current panel settings and creates `_syncedBase` metadata in `docflow_panel_settings`.

**`_syncedBase` structure** (stored in `docflow_panel_settings[currentMode]`):
```js
{ basePreset: "presetName", userEdited: { imageDpi: true } }
```
- `basePreset`: name of the doc_to_pdf preset to sync from
- `userEdited`: keys the user has manually overridden (stops live sync for those keys)

**Shared keys** (`_DOC_TO_PDF_SETTING_KEYS`): `pdfVersion`, `pageSize`, `orientation`, `imageDpi`, `embedFonts`, `losslessImages`, `passwordProtect`, `allowPrinting`, `allowCopying`.

**Live sync flow** (`_applyPanelSettings`):
1. Resolves base preset name from active preset's `_basePreset` or `saved._syncedBase.basePreset`
2. Reads live values from the doc_to_pdf preset (always fresh, not snapshot)
3. Skips keys in `userEdited` map

**Manual override**: `_isApplyingSettings` flag prevents change handlers from marking keys as edited during programmatic `applySettings` calls. User-initiated changes go through `_markSyncedKeyIfManual(el)` which adds the key to `userEdited`, then strips DOM markers (`section-synced` class, `data-synced-section`, `data-synced-base`, `section-synced-header` class) so the section no longer appears synced.

**Section UI**: Synced sections get `section-synced` class, `data-synced-section` and `data-synced-base` attributes. Synced sections are always interactive (never disabled with `section-na`) — the `isNA` flag explicitly excludes synced sections (`!isSynced`). Headers are clickable to toggle fold/unfold. Sync badges (`sync-hint`) are not rendered on any section.

**`_resolvePreset(preset)`**: Merges base doc_to_pdf preset first, then overlays to_markdown overrides (skipping `_basePreset` key). Used for preset matching and display.

### Design language

Constructivist/deconstructivist aesthetic: thick borders (2-3px), hard offset shadows (no blur), corner blocks, mono typography with wide letter-spacing, industrial-grade animations. oklch color space. `prefers-reduced-motion` disables all animations.

## Critical Notes

- **Windows-only:** Requires Microsoft Word for DOC/DOCX → PDF conversion via COM. `pywin32` is mandatory. PDF→DOCX works without Word.
- **`docflow.db`** auto-created on first run. Stale `processing` jobs reset to `error` on startup. Schema migrations use idempotent `ALTER TABLE`.
- **File cleanup:** `uploads/` and `temp/` cleaned on shutdown via `atexit`. `output/` is not cleaned.
- **Glass morphism:** Every new UI element needs a corresponding `body.custom-bg` CSS variant (translucent backgrounds, `backdrop-filter`, adjusted borders).
- **Per-file settings:** Each queue item has its own `settings` object persisted to `localStorage`. When adding new settings, update both `SETTINGS_CONFIG` and ensure `getDefaultSettings()` handles them.
- **OCR dual-engine:** `_get_ocr_engine()` returns RapidOCR singleton or None. All OCR call sites check RapidOCR first, then Tesseract fallback. Never assume only one engine is available.

### Server startup resilience

- `server.py` calls `_warmup_imports()` before `app.run()` to pre-import heavy libraries.
- Frontend retries failed requests up to 3 times with exponential backoff.

### Appearance restoration

- Custom background and font are applied immediately at script load time via `applySavedAppearance()` IIFE, **before** `init()` runs. Do not move these calls back inside `init()`.

### localStorage keys

| Key | Purpose |
|---|---|
| `docflow_presets` | Presets per mode (`{doc_to_pdf:{...}, pdf_to_docx:{...}, to_markdown:{...}}`) |
| `docflow_panel_settings` | Last-used panel settings per mode. May contain `_syncedBase: {basePreset, userEdited}` for inherited "转MD" settings |
| `docflow_active_preset` | Currently applied preset name per mode (`{doc_to_pdf:"name", ...}`) |
| `docflow_file_settings` | Per-file settings keyed by job ID |
| `docflow_bg_image` | Custom background image (data URL) |
| `docflow_font_name` | Custom font name |
| `docflow_zoom_hint_shown` | Lightbox zoom hint shown once flag |
| `docflow_music_playing` | Music player playing state (`"true"`/`"false"`) |
| `docflow_music_track` | Current music track index |
| `docflow_music_position` | Current playback position (seconds) |
| `docflow_music_mode` | Repeat mode (`"single"`/`"list"`) |
