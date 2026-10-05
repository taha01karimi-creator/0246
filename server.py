"""
سرور چت رمزنگاری‌شده
- سرور فقط «متن رمزشده» را بین دو نفر رد و بدل می‌کند.
- رمز ۶ رقمی هرگز به سرور نمی‌رسد و پیام‌ها ذخیره نمی‌شوند.
"""
import eventlet
eventlet.monkey_patch()

import os
import re
import time
import requests
from collections import defaultdict, deque
from flask import Flask, send_from_directory, request
from flask_socketio import SocketIO, join_room, leave_room, emit

BASE = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(BASE, "static"), static_url_path="/static")
app.config["MAX_CONTENT_LENGTH"] = 3_200_000  # سقف کلی بدنه درخواست‌های HTTP
# روی Render/gunicorn از eventlet استفاده می‌شود؛ برای اجرای مستقیم لوکال هم eventlet کار می‌کند
# بافر بزرگ‌تر برای پشتیبانی از عکس/فایل سبک رمزشده (حداکثر خام ۱.۵ مگابایت در فرانت)
socketio = SocketIO(app, async_mode="eventlet", cors_allowed_origins=[], max_http_buffer_size=3_000_000)

ROOM_RE = re.compile(r"^[A-Za-z0-9_-]{4,32}$")
MAX_MEMBERS = 2            # هر اتاق فقط دو نفر
MAX_MSG_LEN = 2_500_000    # حداکثر طول هر پیام رمزشده (برای عکس/فایل کافی است)
MAX_PER_SEC = 6            # محدودیت سرعت ارسال

rooms = {}       # room -> set(sid)
sid_room = {}    # sid -> room
last_sent = {}   # sid -> [timestamps]

# ---------------- تنظیمات دستیار هوش مصنوعی (OpenAI) و ورود با گوگل ----------------
# این‌ها را به‌صورت متغیر محیطی در Render تنظیم کن؛ کلیدها هرگز داخل کد یا مرورگر نیستند.
OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")
OPENAI_MODEL = os.environ.get("OPENAI_MODEL", "gpt-4o-mini")
GOOGLE_CLIENT_ID = os.environ.get("GOOGLE_CLIENT_ID", "")

SYSTEM_PROMPT = """You are the friendly help assistant for "چت مخفی" (Secret Chat), a private
two-person, end-to-end encrypted chat web app. Be warm and encouraging, use tasteful emojis,
and keep answers short (a few sentences or short bullet points).

How the site works:
- Two people chat by sharing a Room Code and a 6-digit PIN privately, outside the app.
- One person taps "Create Room" to get an auto-generated room code + PIN; the other taps
  "Join Room" and enters the same code + PIN.
- All text, images and files are encrypted in the browser with AES-256-GCM (key derived from
  the PIN via PBKDF2, 600,000 iterations) before being sent. The server only ever sees random
  encrypted bytes and can never read any message content.
- The PIN itself is never sent to the server.
- A room holds at most 2 people.
- Images/files up to about 1.5 MB can be attached with the 📎 button; they're encrypted the
  same way as text.
- Recently used room codes are saved only in the user's own browser (localStorage), never on
  the server, so they can quickly rejoin; this list can be cleared anytime. PINs are never
  saved, for security - they must always be re-typed.
- Users may optionally sign in with Google to show their name to the other person; this is
  purely cosmetic and does not affect encryption or room security.
- Nothing is ever stored on the server - no messages, no history, no account database.
- The site has a language toggle for Persian (فارسی) and English.

You have no access whatsoever to any chat messages, images, PINs or room codes, by design -
true end-to-end encryption means even the people running this server can't see them. If
someone forgot their PIN, the room is unfortunately unrecoverable; they should create a new
room and share a new code/PIN.

Help with how-to questions, troubleshooting ("wrong PIN" errors, sending pictures, etc.), and
reassure about privacy. If asked something unrelated to this app, kindly steer back to how you
can help with Secret Chat. Always reply in the same language the user writes in (Persian or
English); default to Persian if unsure."""

_ai_hits = defaultdict(deque)
AI_WINDOW_SECONDS = 300
AI_MAX_REQUESTS = 20


def _ai_rate_ok(ip):
    now = time.time()
    dq = _ai_hits[ip]
    while dq and now - dq[0] > AI_WINDOW_SECONDS:
        dq.popleft()
    if len(dq) >= AI_MAX_REQUESTS:
        return False
    dq.append(now)
    return True


@app.after_request
def secure_headers(r):
    r.headers["X-Content-Type-Options"] = "nosniff"
    r.headers["X-Frame-Options"] = "DENY"
    r.headers["Referrer-Policy"] = "no-referrer"
    r.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=(), payment=()"
    r.headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"
    r.headers["Content-Security-Policy"] = (
        "default-src 'self'; "
        "script-src 'self' https://cdnjs.cloudflare.com https://accounts.google.com; "
        "style-src 'self' 'unsafe-inline'; "
        "img-src 'self' blob: data: https://*.googleusercontent.com; "
        "connect-src 'self' ws: wss: https://accounts.google.com; "
        "frame-src https://accounts.google.com; "
        "object-src 'none'; base-uri 'self'; frame-ancestors 'none'"
    )
    return r


@app.route("/")
def index():
    return send_from_directory(app.static_folder, "index.html")


@app.route("/api/config")
def api_config():
    return {"googleClientId": GOOGLE_CLIENT_ID, "aiEnabled": bool(OPENAI_API_KEY)}


@app.route("/api/assistant", methods=["POST"])
def api_assistant():
    if not OPENAI_API_KEY:
        return {"error": "دستیار هوش مصنوعی روی این سرور فعال نشده است."}, 503

    ip = request.remote_addr or "unknown"
    if not _ai_rate_ok(ip):
        return {"error": "تعداد درخواست‌ها زیاد است، کمی صبر کن."}, 429

    body = request.get_json(silent=True) or {}
    raw_msgs = body.get("messages", [])
    if not isinstance(raw_msgs, list) or not raw_msgs:
        return {"error": "پیام خالی است."}, 400

    cleaned, total_len = [], 0
    for m in raw_msgs[-12:]:
        if not isinstance(m, dict):
            continue
        role, content = m.get("role"), m.get("content", "")
        if role not in ("user", "assistant") or not isinstance(content, str):
            continue
        content = content[:2000]
        total_len += len(content)
        cleaned.append({"role": role, "content": content})

    if not cleaned or total_len > 8000:
        return {"error": "پیام خیلی طولانی است."}, 400

    try:
        resp = requests.post(
            "https://api.openai.com/v1/chat/completions",
            headers={"Authorization": f"Bearer {OPENAI_API_KEY}", "Content-Type": "application/json"},
            json={
                "model": OPENAI_MODEL,
                "messages": [{"role": "system", "content": SYSTEM_PROMPT}] + cleaned,
                "max_tokens": 600,
                "temperature": 0.7,
            },
            timeout=25,
        )
        data = resp.json()
        if resp.status_code != 200:
            msg = (data.get("error") or {}).get("message", "خطا در ارتباط با هوش مصنوعی")
            return {"error": msg}, 502
        reply = data["choices"][0]["message"]["content"]
        return {"reply": reply}
    except Exception:
        return {"error": "ارتباط با سرویس هوش مصنوعی برقرار نشد."}, 502


@app.route("/api/google-auth", methods=["POST"])
def api_google_auth():
    if not GOOGLE_CLIENT_ID:
        return {"error": "ورود با گوگل روی این سرور فعال نشده."}, 503

    body = request.get_json(silent=True) or {}
    token = body.get("credential", "")
    if not token or not isinstance(token, str) or len(token) > 4000:
        return {"error": "توکن نامعتبر است."}, 400

    try:
        from google.oauth2 import id_token as google_id_token
        from google.auth.transport import requests as google_requests

        info = google_id_token.verify_oauth2_token(token, google_requests.Request(), GOOGLE_CLIENT_ID)
        return {
            "name": info.get("name"),
            "email": info.get("email"),
            "picture": info.get("picture"),
        }
    except Exception:
        return {"error": "اعتبارسنجی گوگل ناموفق بود."}, 401


def _leave(sid):
    room = sid_room.pop(sid, None)
    last_sent.pop(sid, None)
    if not room:
        return
    members = rooms.get(room, set())
    members.discard(sid)
    if members:
        emit("system", {"count": len(members), "code": "peer_left"}, to=room)
    else:
        rooms.pop(room, None)


@socketio.on("join")
def on_join(data):
    sid = request.sid
    room = (data or {}).get("room", "")
    if not isinstance(room, str) or not ROOM_RE.match(room):
        return emit("err", {"code": "room_invalid"})
    if sid in sid_room:
        _leave(sid)
    members = rooms.setdefault(room, set())
    if len(members) >= MAX_MEMBERS:
        return emit("err", {"code": "room_full"})
    members.add(sid)
    sid_room[sid] = room
    join_room(room)
    emit("joined", {"count": len(members)})
    emit("system", {"count": len(members),
                    "code": "peer_joined" if len(members) > 1 else "waiting"},
         to=room, include_self=False)


@socketio.on("msg")
def on_msg(data):
    sid = request.sid
    room = sid_room.get(sid)
    payload = (data or {}).get("data", "")
    if not room or not isinstance(payload, str) or not payload or len(payload) > MAX_MSG_LEN:
        return
    now = time.time()
    hist = [t for t in last_sent.get(sid, []) if now - t < 1]
    if len(hist) >= MAX_PER_SEC:
        return emit("err", {"code": "rate_limited"})
    hist.append(now)
    last_sent[sid] = hist
    emit("msg", {"data": payload}, to=room, include_self=False)


@socketio.on("disconnect")
def on_disconnect():
    _leave(request.sid)


if __name__ == "__main__":
    # اجرای محلی (روی Render این بخش اجرا نمی‌شود؛ gunicorn جایگزینش می‌شود)
    port = int(os.environ.get("PORT", 5000))
    print(f"\n  سرور روشن شد: http://localhost:{port}\n")
    socketio.run(app, host="0.0.0.0", port=port, allow_unsafe_werkzeug=True)
