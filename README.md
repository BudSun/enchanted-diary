# 🪄 enchanted-diary

> Write to Tom Riddle's diary on the parchment. Rest your pen. The ink is drunk — and the diary writes back, stroke by stroke.

**[中文](#中文)** | **English below**

A web port of [Maxime Rivest's *riddle*](https://github.com/MaximeRivest/riddle), originally built for the reMarkable Paper Pro e-ink tablet. The whole UX (write → ink fades → reply animates in handwriting → fades) is preserved, but runs in any modern browser.

Inspired by the recent viral "handwritten Harry Potter diary" demos.

---

## English

### What it does

1. You draw / write on a parchment surface with mouse, finger, or stylus
2. After ~2.8s of idle, the ink **fades** ("the diary drinks your ink")
3. The diary thinks for a moment, then **writes back in real handwriting**
4. After a few seconds, the reply **fades too**, and the page is yours again

The "spirit" inside the diary is a vision LLM that reads your handwriting from the page and replies in character as 16-year-old Tom Riddle — courteous, curious, subtly probing.

### Architecture (one API key)

```
browser  ── POST /api/oracle { image, apiKey }  ──►  server.py
                                                       │
                                              ┌────────┴────────┐
                                              ▼                 ▼
                                       SiliconFlow OCR    DeepSeek V3
                                       (Qwen3-VL-8B)      (chat, streaming)
                                              │                 │
                                              └────────┬────────┘
                                                       ▼
                                            SSE stream back to browser
                                                       ▼
                                       opentype.js → SVG <path> stroke
                                       animation, one stroke at a time
```

A single SiliconFlow API key handles both vision (OCR) and chat (DeepSeek V3 hosted on SiliconFlow). Models are pinned in `src/providers/siliconflow.js` — change them in one place.

### Running locally

```sh
git clone https://github.com/Shawn-TKD/enchanted-diary.git
cd enchanted-diary
python3 server.py
# → http://localhost:8080/
```

`server.py` is **not optional** — it's both a static file server *and* a CORS-bypassing proxy for the upstream LLM API. The browser only talks to `localhost:8080`; the Python process forwards requests to SiliconFlow server-side. (A plain `python3 -m http.server` won't work because browsers can't call the LLM APIs directly.)

### Configuration

Open the page → ⚙ top-right → paste a **SiliconFlow API key** (get one at [siliconflow.cn](https://siliconflow.cn)). That's it.

- Keys are stored in `localStorage` only — never sent anywhere except your own backend
- Default rate limit: **20 requests per IP per hour** (set in `server.py`)

### Self-hosting

Two options:

#### A. Local / LAN (Python, zero deps)

```sh
python3 server.py
# → http://localhost:8080/  (binds 0.0.0.0 so other devices on your Wi-Fi can reach it)
```

`server.py` is a single-file Python 3 server using only the standard library — no `pip install` needed.

#### B. Public deployment (Cloudflare Workers, free)

```sh
# one-time setup
npm install -g wrangler
wrangler login            # opens browser to authorize

# deploy (takes ~30s)
wrangler deploy

# → https://enchanted-diary.<your-subdomain>.workers.dev
```

Free tier: **100,000 requests/day**, global edge, SSE streaming works natively. No env vars needed since users supply their own API key at runtime (kept in browser localStorage).

To use your own API key for everyone, edit `worker.js` and `wrangler.toml`:
```toml
# wrangler.toml
[vars]
SILICONFLOW_API_KEY = "sk-..."   # then read env.SILICONFLOW_API_KEY in worker.js
```

Edit models / prompts in `worker.js` (lines near the top) or `src/providers/siliconflow.js`.

### Tech

- **Frontend**: vanilla JS, single HTML file (no build step)
- **Fonts**: Dancing Script (English) + Ma Shan Zheng (Chinese), both SIL OFL
- **Handwriting animation**: `opentype.js` parses the TTF into SVG paths; `stroke-dashoffset` animates each glyph being written
- **Backend**: Python `http.server` + `http.client` (streaming-friendly SSE relay)

### Credits

- Original *riddle* concept and Rust implementation: [Maxime Rivest](https://github.com/MaximeRivest/riddle)
- Tom Riddle character: J.K. Rowling / Warner Bros (this is a fan tribute, not affiliated)
- OCR: [Qwen3-VL-8B](https://siliconflow.cn) (Alibaba, Apache-2.0)
- Chat: [DeepSeek V3](https://api-docs.deepseek.com/) hosted on SiliconFlow

### License

MIT (see [LICENSE](LICENSE)). The bundled fonts are under SIL OFL — see [fonts/OFL.txt](fonts/OFL.txt).

---

## 中文

### 这是什么

把 [Maxime Rivest 的 *riddle*](https://github.com/MaximeRivest/riddle)（一个为 reMarkable Paper Pro 电子墨水平板写的 Rust 程序）搬到了网页上。保留所有原始交互：写字 → 墨水被吸走 → 日记回应，一笔一画写出回复 → 淡去。

最近网上那种"手写版哈利波特日记"的 demo 用法之一。

### 用法

```sh
git clone https://github.com/Shawn-TKD/enchanted-diary.git
cd enchanted-diary
python3 server.py
# → http://localhost:8080/
```

**为什么必须用 `server.py`**：浏览器不能直接调 LLM API（CORS 拦截）。`server.py` 自带一个 CORS 代理，浏览器只跟 `localhost` 说话，Python 进程替你跟硅基流动通信。用 `python3 -m http.server` 是不行的。

### 配置

打开页面 → 右上角 ⚙ → 填 **SiliconFlow API key**（在 [siliconflow.cn](https://siliconflow.cn) 注册创建）。一个 key 全搞定，OCR 和对话都走它。

- key 只存在浏览器 localStorage
- 默认限频：**每 IP 每小时 20 次**

### 技术栈

- **前端**：纯 JS 单 HTML 文件（无构建步骤）
- **字体**：Dancing Script（英文）+ 演示夏行楷 Ma Shan Zheng（中文），均 SIL OFL
- **手写动画**：`opentype.js` 把 TTF 解成 SVG path，用 `stroke-dashoffset` 一画一笔动
- **后端（本地）**：Python `http.server` + `http.client`，零依赖
- **后端（云端）**：`worker.js` —— Cloudflare Worker 部署，全球边缘节点

### 部署到 Cloudflare（免费）

```sh
npm install -g wrangler
wrangler login
wrangler deploy
```

部署完会得到一个 `https://enchanted-diary.<subdomain>.workers.dev` 的 URL，全球可访问，免费 100K 请求/天。

如果想让所有人用同一个 key（不用每人填），改 `wrangler.toml` 加 `[vars]`：

```toml
[vars]
SILICONFLOW_API_KEY = "sk-..."
```

### 致谢

- 原版 *riddle* 概念和 Rust 实现：[MaximeRivest](https://github.com/MaximeRivest/riddle)
- Tom Riddle 角色：J.K. Rowling / Warner Bros（粉丝致敬，非官方）
- OCR：[Qwen3-VL-8B](https://siliconflow.cn)
- 对话：[DeepSeek V3](https://api-docs.deepseek.com/)（硅基流动托管）

### 协议

MIT（见 [LICENSE](LICENSE)）。字体是 SIL OFL（见 [fonts/OFL.txt](fonts/OFL.txt)）。