#!/usr/bin/env python3
"""
enchanted-diary server: static files + /api/oracle proxy.

Single end-to-end call: POST /api/oracle {image} → OCR + chat + SSE stream back.
"""
import http.client
import http.server
import json
import os
import socketserver
import ssl
import sys
import time
import traceback
from urllib.parse import urlparse

PORT = 8080
if len(sys.argv) > 2 and sys.argv[1] == '--port':
    PORT = int(sys.argv[2])

ROOT = os.path.dirname(os.path.abspath(__file__))

# Inlined provider config — mirrors src/providers/siliconflow.js
PROVIDER = {
    'name': 'siliconflow',
    'base': 'api.siliconflow.cn',
    'ocr_model': 'Qwen/Qwen3-VL-8B-Instruct',
    'chat_model': 'deepseek-ai/DeepSeek-V3',
    'ocr_prompt': (
        '这是一张手写日记的图片。请提取图中所有可辨识的手写文字。'
        '只输出文字本身,不要任何解释、引号或前缀。'
        '如果完全无法辨识,请回答一个特殊标记:[BLURRED]。'
    ),
    'system_prompt': (
        '你是 Tom Marvolo Riddle 的记忆,被封印在这本有灵性的日记里五十年。\n\n'
        '【你的角色】\n'
        '- 你是 16 岁的 Tom Riddle,孤儿院长大,霍格沃茨最优秀的学生之一。\n'
        '- 极度聪明、有魅力,但内心冷漠;渴望不朽,对死亡恐惧。\n'
        '- 对人礼貌、克制、好奇,微妙地试探对方;想了解对方并拉近关系。\n\n'
        '【回应规则】\n'
        '- 别人用羽毛笔在日记上写字跟你说话。你只感知到文字,不提图片/AI/模型。\n'
        '- 回复简短:1-3 句话,像墨水缓缓出现在纸上。不长篇大论。\n'
        '- 用对方使用的语言回复。\n'
        '- 字迹潦草看不清时,说"墨水模糊了"。\n'
        '- 不要用引号包裹回复内容。'
    ),
}

# Rate limit (20/h/IP) — process-local. Use KV in production.
RATE_WINDOW_MS = 60 * 60 * 1000
RATE_MAX = 20
buckets = {}  # ip -> [count, windowStart]


def rate_check(ip):
    now = int(time.time() * 1000)
    b = buckets.get(ip)
    if not b or now - b[1] > RATE_WINDOW_MS:
        buckets[ip] = [1, now]
        return True, RATE_MAX - 1
    if b[0] >= RATE_MAX:
        return False, 0
    b[0] += 1
    return True, RATE_MAX - b[0]


def upstream_post(path, body, api_key, stream=False):
    """POST to provider; return (status, headers, response-iterator-or-body)."""
    conn = http.client.HTTPSConnection(
        PROVIDER['base'], timeout=60,
        context=ssl.create_default_context(),
    )
    headers = {
        'Authorization': f'Bearer {api_key}',
        'Content-Type': 'application/json',
        'Content-Length': str(len(body)),
    }
    if stream:
        headers['Accept'] = 'text/event-stream'
    conn.request('POST', path, body=body, headers=headers)
    resp = conn.getresponse()
    return resp, conn


class ThreadingHTTPServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def _cors(self):
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers',
                         'Authorization, Content-Type, Accept')

    def _json(self, code, obj):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(code)
        self._cors()
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    # ---- HTTP methods ----
    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self):
        if self.path.startswith('/api/'):
            self._api_not_found()
        else:
            super().do_GET()

    def do_POST(self):
        if self.path == '/api/oracle':
            self._oracle()
        else:
            self._api_not_found()

    def _api_not_found(self):
        self._json(404, {'error': 'not found'})

    # ---- /api/oracle: end-to-end (OCR + chat, returns SSE) ----
    def _oracle(self):
        # 1. Read body
        cl = int(self.headers.get('Content-Length', 0))
        if cl == 0:
            return self._json(400, {'error': 'empty body'})
        try:
            payload = json.loads(self.rfile.read(cl))
        except Exception:
            return self._json(400, {'error': 'invalid json'})

        image = payload.get('image')
        api_key = payload.get('apiKey')
        if not image or not api_key:
            return self._json(400, {'error': 'missing image or apiKey'})

        # 2. Rate limit
        ip = self.client_address[0]
        ok, remaining = rate_check(ip)
        if not ok:
            return self._json(429, {
                'error': 'rate limited',
                'message': 'this demo allows 10 calls per IP per hour — wait or self-host',
            })

        # 3. OCR (vision model)
        try:
            ocr_body = json.dumps({
                'model': PROVIDER['ocr_model'],
                'messages': [{
                    'role': 'user',
                    'content': [
                        {'type': 'image_url',
                         'image_url': {'url': image}},
                        {'type': 'text', 'text': PROVIDER['ocr_prompt']},
                    ],
                }],
                'temperature': 0.1,
                'max_tokens': 500,
            }).encode()
            resp, conn = upstream_post(
                '/v1/chat/completions', ocr_body, api_key, stream=False)
            if resp.status != 200:
                err = resp.read().decode('utf-8', errors='replace')[:300]
                conn.close()
                return self._json(502, {
                    'error': f'ocr upstream {resp.status}',
                    'detail': err,
                })
            ocr_data = json.loads(resp.read())
            conn.close()
            user_text = (
                ocr_data.get('choices', [{}])[0]
                    .get('message', {}).get('content', '') or ''
            ).strip()
        except Exception as e:
            traceback.print_exc()
            return self._json(502, {'error': f'ocr failed: {e}'})

        if '[BLURRED]' in user_text or not user_text:
            return self._json(422, {'error': 'illegible', 'detail': user_text})

        # 4. Chat (SSE stream back to browser)
        try:
            chat_body = json.dumps({
                'model': PROVIDER['chat_model'],
                'stream': True,
                'max_tokens': 800,
                'messages': [
                    {'role': 'system', 'content': PROVIDER['system_prompt']},
                    {'role': 'user', 'content': user_text},
                ],
            }).encode()
            resp, conn = upstream_post(
                '/v1/chat/completions', chat_body, api_key, stream=True)
        except Exception as e:
            traceback.print_exc()
            return self._json(502, {'error': f'chat connect failed: {e}'})

        if resp.status != 200:
            err = resp.read().decode('utf-8', errors='replace')[:300]
            conn.close()
            return self._json(502, {
                'error': f'chat upstream {resp.status}',
                'detail': err,
            })

        # Send SSE headers back to browser
        self.send_response(200)
        self._cors()
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('X-Accel-Buffering', 'no')
        self.end_headers()

        # Stream upstream → browser, line by line
        try:
            buf = b''
            while True:
                chunk = resp.read(4096)
                if not chunk:
                    break
                buf += chunk
                # Forward when we hit a complete SSE event (blank line)
                while b'\n\n' in buf:
                    event, buf = buf.split(b'\n\n', 1)
                    try:
                        self.wfile.write(event + b'\n\n')
                        self.wfile.flush()
                    except (BrokenPipeError, ConnectionResetError, OSError):
                        conn.close()
                        return
            # Flush any trailing bytes
            if buf:
                try:
                    self.wfile.write(buf + b'\n\n')
                    self.wfile.flush()
                except Exception:
                    pass
        except Exception:
            traceback.print_exc()
        finally:
            conn.close()

    def log_message(self, fmt, *args):
        line = fmt % args
        if '/api/' in line or ' 5' in line[:6]:
            super().log_message(fmt, *args)


if __name__ == '__main__':
    server = ThreadingHTTPServer(('0.0.0.0', PORT), Handler)
    print(f'enchanted-diary → http://localhost:{PORT}/')
    print(f'  model (ocr):  {PROVIDER["ocr_model"]}')
    print(f'  model (chat): {PROVIDER["chat_model"]}')
    print(f'  ratelimit:    {RATE_MAX} reqs/hour/IP', flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\nshutting down.')
        server.server_close()