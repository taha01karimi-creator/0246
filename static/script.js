const $ = id => document.getElementById(id);
const enc = new TextEncoder(), dec = new TextDecoder();
let socket = null, aesKey = null, currentRoom = null, pendingFile = null, googleProfile = null;
const objectUrls = [];

const MAX_FILE_BYTES = 1_500_000;
const ROOMS_KEY = "makhfichat_rooms_v1";
const LANG_KEY = "makhfichat_lang";
const CODE_CH = "abcdefghijkmnpqrstuvwxyz23456789";

// ---------- زبان ----------
const I18N = {
  fa: {
    appTitle: "🔒 چت مخفی", appSub: "گفتگوی خصوصی دو نفره، سرتاسر رمزنگاری‌شده",
    tabCreate: "✨ ساخت اتاق", tabJoin: "🚪 ورود به اتاق",
    labelRoomCode: "کد اتاق", labelPin: "رمز ۶ رقمی",
    hintCreate: "این کد و رمز را برای طرف مقابل بفرست تا وارد همین اتاق شود.",
    btnStart: "شروع چت", btnJoin: "ورود به اتاق",
    placeholderRoom: "مثلاً: sirius-42",
    recentTitle: "🕘 اتاق‌های اخیر من", recentSub: "فقط روی همین دستگاه دیده می‌شود",
    clearAll: "🗑 پاک کردن همه", leaveBtn: "خروج",
    inputPlaceholder: "پیامت را بنویس…", sendBtn: "ارسال",
    noteFooter: "پیام‌ها، عکس‌ها و فایل‌ها در مرورگر با AES‑256‑GCM قفل می‌شوند؛ سرور فقط داده‌ی رمزشده را می‌بیند و هیچ‌چیزی ذخیره نمی‌کند.",
    googlePrompt: "ورود اختیاری با گوگل برای نمایش نام شما به طرف مقابل",
    supportTitle: "دستیار راهنما", supportPlaceholder: "سوالت را بپرس…",
  },
  en: {
    appTitle: "🔒 Secret Chat", appSub: "Private two-person chat, end-to-end encrypted",
    tabCreate: "✨ Create Room", tabJoin: "🚪 Join Room",
    labelRoomCode: "Room code", labelPin: "6-digit PIN",
    hintCreate: "Send this code and PIN to the other person so they can join this room.",
    btnStart: "Start chat", btnJoin: "Join room",
    placeholderRoom: "e.g. sirius-42",
    recentTitle: "🕘 My recent rooms", recentSub: "Visible only on this device",
    clearAll: "🗑 Clear all", leaveBtn: "Leave",
    inputPlaceholder: "Type your message…", sendBtn: "Send",
    noteFooter: "Messages, images, and files are locked in your browser with AES-256-GCM; the server only ever sees encrypted data and stores nothing.",
    googlePrompt: "Optional Google sign-in to show your name to the other person",
    supportTitle: "Help Assistant", supportPlaceholder: "Ask a question…",
  }
};
let LANG = (() => { try { return localStorage.getItem(LANG_KEY) || "fa"; } catch { return "fa"; } })();

const ERRMSG = {
  room_invalid: { fa: "کد اتاق نامعتبر است (۴ تا ۳۲ حرف انگلیسی/عدد)", en: "Invalid room code (4-32 letters/numbers)" },
  room_full: { fa: "این اتاق پر است", en: "This room is full" },
  rate_limited: { fa: "خیلی سریع می‌فرستی", en: "You're sending too fast" },
  pinInvalid: { fa: "رمز باید دقیقاً ۶ رقم باشد", en: "PIN must be exactly 6 digits" },
  needHttps: { fa: "این صفحه باید با HTTPS یا localhost باز شود", en: "This page must be opened via HTTPS or localhost" },
  connecting: { fa: "در حال اتصال…", en: "Connecting…" },
  fileTooBig: { fa: "فقط فایل‌های سبک تا ۱.۵ مگابایت مجاز است", en: "Only light files up to 1.5MB are allowed" },
  copiedCode: { fa: "کد کپی شد ✅", en: "Code copied ✅" },
  copiedPin: { fa: "رمز کپی شد ✅", en: "PIN copied ✅" },
  wrongKeyMsg: { fa: "🔒 پیامی رسید که با این رمز باز نشد", en: "🔒 A message arrived that couldn't be opened with this PIN" },
  confirmClearRooms: { fa: "همه اتاق‌های ذخیره‌شده پاک شوند؟", en: "Clear all saved rooms?" },
  supportIntro: { fa: "سلام! 👋 من اینجام تا درباره چت مخفی راهنماییت کنم. چه کمکی از دستم برمیاد؟", en: "Hi! 👋 I'm here to help with Secret Chat. What can I help with?" },
  supportError: { fa: "⚠️ ارتباط با دستیار برقرار نشد", en: "⚠️ Couldn't reach the assistant" },
};
const t = k => (ERRMSG[k] ? ERRMSG[k][LANG] : k);

const SYS = {
  waiting: { fa: "منتظر طرف مقابل…", en: "Waiting for the other person…" },
  peer_joined: { fa: "طرف مقابل آنلاین است", en: "The other person is online" },
  peer_left: { fa: "طرف مقابل خارج شد", en: "The other person left" },
};
const sysText = code => (SYS[code] ? SYS[code][LANG] : code);
const statusRoomText = room => (LANG === "fa" ? `🔒 اتاق: ${room}` : `🔒 Room: ${room}`);

function applyLang() {
  document.documentElement.lang = LANG;
  document.documentElement.dir = LANG === "fa" ? "rtl" : "ltr";
  document.querySelectorAll("[data-i18n]").forEach(el => {
    const k = el.getAttribute("data-i18n");
    if (I18N[LANG][k]) el.textContent = I18N[LANG][k];
  });
  document.querySelectorAll("[data-i18n-placeholder]").forEach(el => {
    const k = el.getAttribute("data-i18n-placeholder");
    if (I18N[LANG][k]) el.placeholder = I18N[LANG][k];
  });
  $("langToggle").textContent = LANG === "fa" ? "EN" : "فا";
  try { localStorage.setItem(LANG_KEY, LANG); } catch {}
}
$("langToggle").onclick = () => { LANG = LANG === "fa" ? "en" : "fa"; applyLang(); };

// ---------- کدگذاری سریع برای داده‌های دودویی ----------
function bytesToB64(bytes) {
  let binary = "", chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  return btoa(binary);
}
function b64ToBytes(b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// ---------- رمزنگاری ----------
async function deriveKey(pin, room) {
  const m = await crypto.subtle.importKey("raw", enc.encode(pin), "PBKDF2", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("makhfi-chat|" + room), iterations: 600000, hash: "SHA-256" },
    m, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function encryptPayload(obj) {
  const bytes = enc.encode(JSON.stringify(obj));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, aesKey, bytes));
  const all = new Uint8Array(12 + ct.length);
  all.set(iv); all.set(ct, 12);
  return bytesToB64(all);
}
async function decryptPayload(b64) {
  const all = b64ToBytes(b64);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: all.slice(0, 12) }, aesKey, all.slice(12));
  return JSON.parse(dec.decode(pt));
}

// ---------- تاریخچه محلی اتاق‌ها ----------
function loadRooms() { try { return JSON.parse(localStorage.getItem(ROOMS_KEY)) || []; } catch { return []; } }
function saveRoomToHistory(code) {
  let rooms = loadRooms().filter(r => r.code !== code);
  rooms.unshift({ code, t: Date.now() });
  rooms = rooms.slice(0, 20);
  try { localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms)); } catch {}
  renderRecent();
}
function removeRoomFromHistory(code) {
  const rooms = loadRooms().filter(r => r.code !== code);
  try { localStorage.setItem(ROOMS_KEY, JSON.stringify(rooms)); } catch {}
  renderRecent();
}
function clearAllRooms() {
  if (!confirm(t("confirmClearRooms"))) return;
  try { localStorage.removeItem(ROOMS_KEY); } catch {}
  renderRecent();
}
function timeAgo(ts) {
  const s = Math.floor((Date.now() - ts) / 1000);
  const u = LANG === "fa" ? ["چند لحظه پیش", "دقیقه پیش", "ساعت پیش", "روز پیش"] : ["just now", "min ago", "h ago", "d ago"];
  if (s < 60) return u[0];
  if (s < 3600) return Math.floor(s / 60) + " " + u[1];
  if (s < 86400) return Math.floor(s / 3600) + " " + u[2];
  return Math.floor(s / 86400) + " " + u[3];
}
function renderRecent() {
  const rooms = loadRooms();
  $("recentCard").hidden = rooms.length === 0;
  const list = $("recentList");
  list.innerHTML = "";
  for (const r of rooms) {
    const item = document.createElement("div");
    item.className = "recent-item";
    const code = document.createElement("span");
    code.className = "rc-code"; code.textContent = r.code;
    const time = document.createElement("span");
    time.className = "rc-time"; time.textContent = timeAgo(r.t);
    const goBtn = document.createElement("button");
    goBtn.textContent = "🚪";
    goBtn.onclick = () => { tab(false); $("roomJ").value = r.code; $("pinJ").focus(); };
    const delBtn = document.createElement("button");
    delBtn.textContent = "🗑";
    delBtn.onclick = () => removeRoomFromHistory(r.code);
    item.append(code, time, goBtn, delBtn);
    list.appendChild(item);
  }
}

// ---------- کد/رمز تصادفی ----------
function randomCode() {
  const a = crypto.getRandomValues(new Uint8Array(8));
  let s = "";
  for (let i = 0; i < 8; i++) { s += CODE_CH[a[i] % CODE_CH.length]; if (i === 3) s += "-"; }
  return s;
}
function randomPin() {
  const a = crypto.getRandomValues(new Uint32Array(1));
  return String(100000 + (a[0] % 900000));
}
function fillCreateFields() { $("roomC").value = randomCode(); $("pinC").value = randomPin(); }

// ---------- پیام‌ها ----------
function add(cls, inner) {
  const d = document.createElement("div");
  d.className = cls;
  if (typeof inner === "string") d.textContent = inner; else d.appendChild(inner);
  $("log").appendChild(d);
  $("log").scrollTop = $("log").scrollHeight;
  return d;
}
function fmtSize(n) {
  if (n < 1024) return n + (LANG === "fa" ? " بایت" : " B");
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + (LANG === "fa" ? " کیلوبایت" : " KB");
  return (n / (1024 * 1024)).toFixed(2) + (LANG === "fa" ? " مگابایت" : " MB");
}
function renderPayload(payload, who) {
  if (who === "other" && payload.from) {
    const label = document.createElement("div");
    label.className = "sender-label"; label.textContent = payload.from;
    $("log").appendChild(label);
  }
  if (payload.t === "text") { add("b " + who, payload.v); return; }
  if (payload.t === "file") {
    const bytes = b64ToBytes(payload.data);
    const blob = new Blob([bytes], { type: payload.mime || "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    objectUrls.push(url);
    const wrap = document.createElement("div");
    if ((payload.mime || "").startsWith("image/")) {
      const img = document.createElement("img");
      img.src = url; img.onclick = () => window.open(url, "_blank");
      wrap.appendChild(img);
    } else {
      const card = document.createElement("div"); card.className = "filecard";
      const icon = document.createElement("span"); icon.textContent = "📄";
      const info = document.createElement("div");
      const nameEl = document.createElement("a");
      nameEl.className = "fname"; nameEl.href = url; nameEl.download = payload.name || "file";
      nameEl.textContent = payload.name || "file";
      const sizeEl = document.createElement("span");
      sizeEl.className = "fsize"; sizeEl.textContent = fmtSize(payload.size || bytes.length);
      info.append(nameEl, sizeEl); card.append(icon, info); wrap.appendChild(card);
    }
    if (payload.caption) {
      const cap = document.createElement("div"); cap.className = "cap"; cap.textContent = payload.caption;
      wrap.appendChild(cap);
    }
    add("b " + who, wrap);
  }
}

const err = txt => ($("msg").textContent = txt);

function tab(createTab) {
  $("pCreate").hidden = !createTab; $("pJoin").hidden = createTab;
  $("tCreate").classList.toggle("on", createTab); $("tJoin").classList.toggle("on", !createTab);
  err("");
}

async function enterRoom(room, pin) {
  if (!/^[A-Za-z0-9_-]{4,32}$/.test(room)) return err(t("room_invalid") || ERRMSG.room_invalid[LANG]);
  if (!/^\d{6}$/.test(pin)) return err(t("pinInvalid"));
  if (!window.crypto || !crypto.subtle) return err(t("needHttps"));
  err(t("connecting"));
  currentRoom = room;
  aesKey = await deriveKey(pin, room);
  socket = io({ transports: ["websocket", "polling"] });
  socket.on("connect", () => socket.emit("join", { room }));
  socket.on("err", d => err(ERRMSG[d.code] ? ERRMSG[d.code][LANG] : (d.text || "")));
  socket.on("joined", d => {
    $("joinBox").hidden = true; $("chatBox").hidden = false;
    $("status").textContent = statusRoomText(room);
    saveRoomToHistory(room);
    add("sys", d.count > 1 ? sysText("peer_joined") : sysText("waiting"));
  });
  socket.on("system", d => add("sys", sysText(d.code)));
  socket.on("msg", async d => {
    try { renderPayload(await decryptPayload(d.data), "other"); }
    catch { add("b other bad", t("wrongKeyMsg")); }
  });
}

async function sendMessage() {
  const text = $("text").value.trim();
  if (!socket) return;
  const from = googleProfile ? googleProfile.name : null;
  if (pendingFile) {
    const payload = { t: "file", mime: pendingFile.mime, name: pendingFile.name, size: pendingFile.size, data: pendingFile.b64, caption: text || null, from };
    socket.emit("msg", { data: await encryptPayload(payload) });
    renderPayload(payload, "me");
    clearFileChip(); $("text").value = "";
    return;
  }
  if (!text) return;
  const payload = { t: "text", v: text, from };
  socket.emit("msg", { data: await encryptPayload(payload) });
  renderPayload(payload, "me");
  $("text").value = "";
}

function clearFileChip() { pendingFile = null; $("fileChip").hidden = true; $("fileInput").value = ""; }

function leaveRoom() {
  if (socket) { socket.disconnect(); socket = null; }
  aesKey = null; currentRoom = null;
  clearFileChip(); $("log").innerHTML = "";
  objectUrls.splice(0).forEach(u => { try { URL.revokeObjectURL(u); } catch {} });
  $("chatBox").hidden = true; $("joinBox").hidden = false;
  renderRecent();
}

// ---------- دستیار هوش مصنوعی ----------
let supportHistory = [];
function addSupportMsg(who, text) {
  const d = document.createElement("div");
  d.className = "b " + (who === "me" ? "me" : "other");
  d.textContent = text;
  $("supportLog").appendChild(d);
  $("supportLog").scrollTop = $("supportLog").scrollHeight;
  return d;
}
function openSupport() {
  $("supportPanel").hidden = false;
  if (supportHistory.length === 0) addSupportMsg("other", t("supportIntro"));
}
function closeSupport() { $("supportPanel").hidden = true; }
async function sendSupport() {
  const val = $("supportInput").value.trim();
  if (!val) return;
  $("supportInput").value = "";
  addSupportMsg("me", val);
  supportHistory.push({ role: "user", content: val });
  const typing = addSupportMsg("other", "…");
  try {
    const res = await fetch("/api/assistant", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages: supportHistory, lang: LANG }),
    });
    const data = await res.json();
    typing.remove();
    if (!res.ok) { addSupportMsg("other", "⚠️ " + (data.error || t("supportError"))); return; }
    addSupportMsg("other", data.reply);
    supportHistory.push({ role: "assistant", content: data.reply });
    supportHistory = supportHistory.slice(-12);
  } catch {
    typing.remove();
    addSupportMsg("other", t("supportError"));
  }
}
$("supportToggle").onclick = () => { $("supportPanel").hidden ? openSupport() : closeSupport(); };
$("supportClose").onclick = closeSupport;
$("supportSend").onclick = sendSupport;
$("supportInput").addEventListener("keydown", e => { if (e.key === "Enter") sendSupport(); });

// ---------- ورود با گوگل ----------
async function onGoogleCredential(response) {
  try {
    const res = await fetch("/api/google-auth", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ credential: response.credential }),
    });
    const data = await res.json();
    if (!res.ok) return;
    googleProfile = data;
    $("googleAvatar").src = data.picture || "";
    $("googleName").textContent = data.name || data.email || "";
    $("googleProfileBadge").hidden = false;
    $("googleBtn").hidden = true;
  } catch {}
}
$("googleSignOut").onclick = () => {
  googleProfile = null;
  $("googleProfileBadge").hidden = true;
  $("googleBtn").hidden = false;
};
function waitForGoogle(retries = 20) {
  if (window.google && google.accounts && google.accounts.id) { initGoogle(); return; }
  if (retries <= 0) return;
  setTimeout(() => waitForGoogle(retries - 1), 250);
}
async function initGoogle() {
  try {
    const res = await fetch("/api/config");
    const cfg = await res.json();
    if (cfg.googleClientId) {
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogleCredential });
      google.accounts.id.renderButton($("googleBtn"), { theme: "outline", size: "medium", shape: "pill" });
      $("googleWrap").hidden = false;
    }
  } catch {}
}

// ---------- رویدادها ----------
$("tCreate").onclick = () => tab(true);
$("tJoin").onclick = () => tab(false);
$("regenRoom").onclick = () => { $("roomC").value = randomCode(); };
$("regenPin").onclick = () => { $("pinC").value = randomPin(); };
$("copyRoom").onclick = async () => { try { await navigator.clipboard.writeText($("roomC").value); err(t("copiedCode")); } catch {} };
$("copyPin").onclick = async () => { try { await navigator.clipboard.writeText($("pinC").value); err(t("copiedPin")); } catch {} };
$("createGo").onclick = () => enterRoom($("roomC").value, $("pinC").value);
$("joinGo").onclick = () => enterRoom($("roomJ").value.trim(), $("pinJ").value);
$("pinJ").addEventListener("input", e => e.target.value = e.target.value.replace(/\D/g, ""));
$("sendBtn").onclick = sendMessage;
$("text").addEventListener("keydown", e => { if (e.key === "Enter") sendMessage(); });
$("leave").onclick = leaveRoom;
$("clearRooms").onclick = clearAllRooms;
$("attachBtn").onclick = () => $("fileInput").click();
$("fileChipCancel").onclick = clearFileChip;
$("fileInput").addEventListener("change", e => {
  const file = e.target.files[0];
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) { err(t("fileTooBig")); $("fileInput").value = ""; return; }
  const reader = new FileReader();
  reader.onload = () => {
    const b64 = reader.result.split(",")[1];
    pendingFile = { mime: file.type || "application/octet-stream", name: file.name, size: file.size, b64 };
    $("fileChipName").textContent = "📎 " + file.name + " (" + fmtSize(file.size) + ")";
    $("fileChip").hidden = false;
  };
  reader.readAsDataURL(file);
});

// ---------- شروع ----------
applyLang();
fillCreateFields();
renderRecent();
window.addEventListener("load", () => waitForGoogle());
