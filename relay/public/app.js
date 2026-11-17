/* Alert SecurityPay · panel web (sin dependencias de build) */
const $ = (id) => document.getElementById(id);
const STORAGE_KEY = "securitypay.panel.v1";

const state = {
  server: localStorage.getItem("securitypay.server") || location.origin,
  token: localStorage.getItem("securitypay.token") || "",
  status: null,
  alerts: new Map(),
  filter: "all",
  ws: null,
  wsAttempts: 0,
  wsTimer: null,
  lastSeq: 0,
  helloSeq: 0,
  initialSyncDone: false,
  sound: false,
  notify: false,
  audioCtx: null,
  siren: null,
  sirenStop: null,
  livekitRoom: null,
  lastSpoken: 0,
  seen: new Set(),
};

const PRIORITY_LABEL = { critical: "Crítica", high: "Alta", normal: "Normal", low: "Baja" };
const PRIORITY_ORDER = { critical: 0, high: 1, normal: 2, low: 3 };

function api(path, options = {}) {
  const base = state.server.replace(/\/+$/, "");
  const headers = { ...(options.headers || {}) };
  if (state.token) headers.Authorization = `Bearer ${state.token}`;
  if (options.body && !headers["content-type"]) headers["content-type"] = "application/json";
  return fetch(base + path, { ...options, headers }).then(async (res) => {
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    if (!res.ok) {
      const message = data?.error?.message || `HTTP ${res.status}`;
      const err = new Error(message);
      err.status = res.status;
      throw err;
    }
    return data;
  });
}

function wsUrl(afterSeq = 0) {
  const base = state.server.replace(/\/+$/, "").replace(/^http/, "ws");
  return `${base}/ws/relay?token=${encodeURIComponent(state.token)}&after_seq=${afterSeq}`;
}

function fmtTime(ms) {
  try {
    return new Intl.DateTimeFormat("es-ES", {
      day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", second: "2-digit",
    }).format(new Date(ms));
  } catch { return new Date(ms).toLocaleString(); }
}

function ago(ms) {
  const s = Math.max(0, Math.floor((Date.now() - ms) / 1000));
  if (s < 60) return `hace ${s}s`;
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return `hace ${Math.floor(s / 86400)} d`;
}

/* ---------- login ---------- */
async function login() {
  const server = $("relay-url").value.trim().replace(/\/+$/, "");
  const token = $("api-key").value.trim();
  $("login-error").textContent = "";
  if (!server || !token) { $("login-error").textContent = "Escribe la URL y la clave de API."; return; }
  if (!/^https?:\/\//.test(server)) { $("login-error").textContent = "La URL debe empezar por https://"; return; }
  state.server = server;
  state.token = token;
  try {
    state.status = await api("/v1/status");
  } catch (e) {
    $("login-error").textContent = e.status === 401 ? "La clave de API no es válida." : `No se pudo conectar: ${e.message}`;
    return;
  }
  localStorage.setItem("securitypay.server", server);
  localStorage.setItem("securitypay.token", token);
  showApp();
}

function readHashAuth() {
  if (!location.hash || location.hash.length <= 1) return null;
  const params = new URLSearchParams(location.hash.slice(1));
  const token = (params.get("token") || "").trim();
  const server = (params.get("server") || "").trim().replace(/\/+$/, "");
  if (!token) return null;
  // Clear the token from the address bar and history immediately.
  try {
    history.replaceState(null, "", location.pathname + location.search);
  } catch {}
  return { token, server: /^https?:\/\//.test(server) ? server : "" };
}

function buildAccessLink() {
  const base = `${location.origin}${location.pathname}`;
  const params = new URLSearchParams();
  params.set("token", state.token);
  const currentOrigin = location.origin.replace(/\/+$/, "");
  if (state.server && state.server.replace(/\/+$/, "") !== currentOrigin) {
    params.set("server", state.server.replace(/\/+$/, ""));
  }
  return `${base}#${params.toString()}`;
}

async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  document.execCommand("copy");
  ta.remove();
}

function showApp() {
  $("login").classList.add("hidden");
  $("app").classList.remove("hidden");
  updateSnippet();
  refreshAll().finally(() => connectWs());
}

function logout() {
  stopSiren();
  clearTimeout(state.wsTimer);
  if (state.ws) { state.ws.onclose = null; state.ws.close(); state.ws = null; }
  if (state.livekitRoom) { try { state.livekitRoom.disconnect(); } catch {} state.livekitRoom = null; }
  localStorage.removeItem("securitypay.token");
  state.token = "";
  state.lastSeq = 0;
  state.helloSeq = 0;
  state.initialSyncDone = false;
  $("app").classList.add("hidden");
  $("login").classList.remove("hidden");
}

/* ---------- data ---------- */
async function refreshAll() {
  try {
    const [status, page] = await Promise.all([api("/v1/status"), api("/v1/alerts?limit=300")]);
    state.status = status;
    state.alerts.clear();
    for (const a of page.alerts || []) state.alerts.set(a.alert_id, a);
    render();
    updateStatus(status);
    updateSnippet();
  } catch (e) {
    if (e.status === 401) logout();
    console.warn("refresh failed", e);
  }
}

function updateStatus(status) {
  $("push-state").textContent = status.push_provider === "none" ? "No configurado" : status.push_provider.toUpperCase();
  $("voice-state").textContent = status.voice_enabled ? "LiveKit configurado" : "Voz local (TTS)";
  $("relay-version").textContent = `${status.version} · ${status.relay_id || ""}`;
  $("ws-url").textContent = wsUrl().replace(state.token, "ak_•••");
}

function updateSnippet() {
  const base = state.server.replace(/\/+$/, "");
  const snippet = `// Node.js / Render: envía una alerta al relay
await fetch("${base}/v1/alerts", {
  method: "POST",
  headers: {
    "Authorization": "Bearer TU_CLAVE_API",
    "Content-Type": "application/json"
  },
  body: JSON.stringify({
    type: "error",
    title: "La API se ha caído",
    message: "El healthcheck de Render falló 3 veces seguidas.",
    priority: "critical",   // low | normal | high | critical
    source: "render-api",
    data: { service: "api", region: "oregon" }
  })
});`;
  $("backend-snippet").textContent = snippet;
}

/* ---------- WebSocket ---------- */
function connectWs() {
  if (!state.token) return;
  clearTimeout(state.wsTimer);
  setWsState("connecting");
  let ws;
  try { ws = new WebSocket(wsUrl(state.lastSeq)); } catch (e) { scheduleReconnect(); return; }
  state.ws = ws;
  ws.onopen = () => {
    state.wsAttempts = 0;
    setWsState("online");
  };
  ws.onmessage = (event) => {
    let evt;
    try { evt = JSON.parse(event.data); } catch { return; }
    handleEvent(evt);
  };
  ws.onclose = () => {
    setWsState("offline");
    if (state.ws === ws) state.ws = null;
    scheduleReconnect();
  };
  ws.onerror = () => { try { ws.close(); } catch {} };
}

function scheduleReconnect() {
  if (!state.token) return;
  const delay = Math.min(30000, 1000 * 2 ** Math.min(state.wsAttempts, 5));
  state.wsAttempts++;
  clearTimeout(state.wsTimer);
  state.wsTimer = setTimeout(connectWs, delay);
}

function setWsState(kind) {
  const pill = $("ws-pill");
  pill.className = `pill ${kind}`;
  pill.querySelector("span").textContent = kind === "online" ? "En vivo" : kind === "connecting" ? "Conectando…" : "Reconectando…";
  $("stat-channel").textContent = kind === "online" ? "WebSocket" : kind === "connecting" ? "Conectando" : "Sin conexión";
}

function handleEvent(evt) {
  if (!evt || !evt.type) return;
  if (evt.type === "ws.hello") {
    const serverSeq = Number(evt.last_seq || 0);
    if (!state.initialSyncDone) {
      state.helloSeq = serverSeq;
      state.initialSyncDone = true;
    }
    return;
  }
  const isReplay = typeof evt.seq === "number" && evt.seq <= state.helloSeq;
  if (typeof evt.seq === "number" && evt.seq > state.lastSeq) {
    state.lastSeq = evt.seq;
  }
  if (evt.type === "alert.new") {
    const alert = {
      alert_id: evt.alert_id,
      type: evt.alert_type,
      title: evt.title,
      message: evt.message,
      priority: evt.priority,
      source: evt.source,
      data: evt.data,
      voice_room: evt.voice_room,
      voice_url: evt.voice_url,
      created_at: evt.created_at,
    };
    upsertAlert(alert, !isReplay);
  } else if (evt.type === "alert.ack") {
    const alert = state.alerts.get(evt.alert_id);
    if (alert) {
      alert.acked_at = evt.acked_at;
      alert.acked_by = evt.acked_by;
      state.alerts.set(alert.alert_id, alert);
      if (alert.priority === "critical" || alert.priority === "high") stopSiren();
      render();
    }
  }
}

function upsertAlert(alert, isNew) {
  const existing = state.alerts.get(alert.alert_id);
  state.alerts.set(alert.alert_id, {
    ...alert,
    ...(existing?.acked_at ? { acked_at: existing.acked_at, acked_by: existing.acked_by } : {}),
  });
  render();
  if (isNew && !existing) {
    if (alert.priority === "critical" || alert.priority === "high") {
      playSiren();
      notifyAlert(alert);
      if (alert.priority === "critical") speakAndVoice(alert);
    } else {
      notifyAlert(alert);
    }
  }
}

/* ---------- rendering ---------- */
function visibleAlerts() {
  let list = [...state.alerts.values()];
  if (state.filter !== "all") list = list.filter((a) => a.priority === state.filter);
  return list.sort((a, b) => (b.created_at || 0) - (a.created_at || 0));
}

function render() {
  const list = visibleAlerts();
  const wrap = $("alerts");
  wrap.textContent = "";
  $("empty").classList.toggle("hidden", list.length > 0);
  const template = $("alert-template");
  for (const alert of list) {
    const node = template.content.firstElementChild.cloneNode(true);
    node.classList.add(`priority-${alert.priority}`);
    if (alert.acked_at) node.classList.add("acked");
    node.querySelector(".alert-type").textContent = `${PRIORITY_LABEL[alert.priority] || alert.priority} · ${alert.type || "alerta"}`;
    node.querySelector(".alert-time").textContent = fmtTime(alert.created_at);
    node.querySelector(".alert-time").title = `${ago(alert.created_at)} · ${new Date(alert.created_at).toISOString()}`;
    node.querySelector(".alert-title").textContent = alert.title || "(sin título)";
    node.querySelector(".alert-message").textContent = alert.message || "";
    node.querySelector(".alert-source").textContent = alert.source ? `Origen: ${alert.source}` : "";
    node.querySelector(".alert-acked").textContent = alert.acked_at
      ? `Atendida ${ago(alert.acked_at)} por ${alert.acked_by === "agent" ? "el agente" : "el usuario"}`
      : "";
    const ack = node.querySelector(".ack");
    if (alert.acked_at) ack.remove();
    else ack.addEventListener("click", () => ackAlert(alert));
    const listen = node.querySelector(".listen");
    if (alert.priority === "critical" || alert.voice_room) {
      listen.classList.remove("hidden");
      listen.addEventListener("click", () => speakAndVoice(alert, true));
    }
    wrap.appendChild(node);
  }
  const all = [...state.alerts.values()];
  const now = Date.now();
  $("stat-total").textContent = String(all.length);
  $("stat-critical").textContent = String(all.filter((a) => a.priority === "critical" && !a.acked_at).length);
  $("stat-today").textContent = String(all.filter((a) => now - (a.created_at || 0) < 86400000).length);
}

async function ackAlert(alert) {
  try {
    const updated = await api(`/v1/alerts/${encodeURIComponent(alert.alert_id)}/ack`, { method: "POST" });
    state.alerts.set(updated.alert_id, updated);
    stopSiren();
    render();
  } catch (e) {
    console.warn("ack failed", e);
  }
}

/* ---------- alarm & voice ---------- */
function ensureAudio() {
  if (!state.audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    state.audioCtx = new Ctx();
  }
  if (state.audioCtx.state === "suspended") state.audioCtx.resume().catch(() => {});
  return state.audioCtx;
}

function playSiren() {
  if (!state.sound) return;
  stopSiren();
  const ctx = ensureAudio();
  if (!ctx) return;
  const master = ctx.createGain();
  master.gain.value = 0.12;
  master.connect(ctx.destination);
  const osc = ctx.createOscillator();
  osc.type = "sawtooth";
  const lfo = ctx.createOscillator();
  const lfoGain = ctx.createGain();
  lfo.frequency.value = 0.8;
  lfoGain.gain.value = 260;
  lfo.connect(lfoGain).connect(osc.frequency);
  osc.frequency.value = 720;
  osc.connect(master);
  osc.start();
  lfo.start();
  const timer = setTimeout(stopSiren, 30000);
  state.siren = { osc, lfo, master, timer };
  state.sirenStop = stopSiren;
}

function stopSiren() {
  const s = state.siren;
  if (!s) return;
  state.siren = null;
  clearTimeout(s.timer);
  try { s.osc.stop(); s.lfo.stop(); s.master.disconnect(); } catch {}
}

function browserSpeak(alert) {
  if (!("speechSynthesis" in window)) return;
  try {
    speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(
      `Alerta ${PRIORITY_LABEL[alert.priority] || ""} de SecurityPay. ${alert.title}. ${alert.message}`,
    );
    u.lang = "es-ES";
    u.rate = 1.02;
    u.pitch = 0.95;
    const voices = speechSynthesis.getVoices();
    const es = voices.find((v) => /es[-_]ES/i.test(v.lang)) || voices.find((v) => /^es/i.test(v.lang));
    if (es) u.voice = es;
    speechSynthesis.speak(u);
  } catch {}
}

async function speakAndVoice(alert, manual = false) {
  if (!manual && Date.now() - state.lastSpoken < 4000) return;
  state.lastSpoken = Date.now();
  browserSpeak(alert);
  if (!alert.voice_room) return;
  try {
    const info = await api(`/v1/alerts/${encodeURIComponent(alert.alert_id)}/voice-token`, { method: "POST" });
    const mod = await import("https://cdn.jsdelivr.net/npm/livekit-client@2/+esm");
    if (state.livekitRoom) {
      try { await state.livekitRoom.disconnect(); } catch {}
      state.livekitRoom = null;
    }
    const room = new mod.Room({ adaptiveStream: true, dynacast: true });
    state.livekitRoom = room;
    room.on(mod.RoomEvent.TrackSubscribed, (track) => {
      if (track.kind !== "audio") return;
      const el = track.attach();
      el.autoplay = true;
      el.style.display = "none";
      document.body.appendChild(el);
      el.play().catch(() => {});
      setTimeout(() => { try { el.remove(); } catch {} }, 120000);
    });
    await room.connect(info.livekit_url, info.livekit_token);
    await room.startAudio().catch(() => {});
    setTimeout(() => {
      if (state.livekitRoom === room) {
        try { room.disconnect(); } catch {}
        state.livekitRoom = null;
      }
    }, 90000);
  } catch (e) {
    console.warn("LiveKit voice unavailable; using browser TTS", e);
  }
}

function notifyAlert(alert) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const n = new Notification(`Alert SecurityPay · ${PRIORITY_LABEL[alert.priority] || alert.priority}`, {
      body: `${alert.title}\n${alert.message}`.slice(0, 240),
      tag: alert.alert_id,
      requireInteraction: alert.priority === "critical",
      icon: "/panel/icon.svg",
      badge: "/panel/icon.svg",
    });
    n.onclick = () => { window.focus(); n.close(); };
  } catch {}
}

/* ---------- dialogs ---------- */
async function openPair() {
  const dialog = $("pair-dialog");
  $("qr-wrap").innerHTML = '<div class="spinner"></div>';
  dialog.showModal();
  try {
    const token = await api("/v1/pairing-tokens", { method: "POST", body: JSON.stringify({ ttl_s: 600 }) });
    const res = await fetch(`${state.server.replace(/\/+$/, "")}/v1/pairing-qr`, {
      method: "POST",
      headers: { Authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ data: token.qr_payload }),
    });
    if (!res.ok) throw new Error(`QR HTTP ${res.status}`);
    const svg = await res.text();
    const url = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
    $("qr-wrap").innerHTML = "";
    const img = document.createElement("img");
    img.src = url;
    img.alt = "Código QR de emparejamiento";
    $("qr-wrap").appendChild(img);
  } catch (e) {
    $("qr-wrap").innerHTML = "";
    const p = document.createElement("p");
    p.className = "error";
    p.textContent = `No se pudo crear el código: ${e.message}`;
    $("qr-wrap").appendChild(p);
  }
}

async function sendTest() {
  const body = {
    type: "test",
    title: $("test-title").value.trim() || "Prueba de Alert SecurityPay",
    message: $("test-message").value.trim() || "Todo funciona.",
    priority: $("test-priority").value,
    source: "panel-web",
  };
  $("test-send").disabled = true;
  try {
    const alert = await api("/v1/alerts", { method: "POST", body: JSON.stringify(body) });
    state.alerts.set(alert.alert_id, alert);
    render();
    $("test-dialog").close();
    if (body.priority === "critical") {
      // The WebSocket event normally does this; this covers a slow socket.
      setTimeout(() => { if (!state.alerts.get(alert.alert_id)?.acked_at) speakAndVoice(alert); }, 600);
    }
  } catch (e) {
    alert(`No se pudo enviar: ${e.message}`);
  } finally {
    $("test-send").disabled = false;
  }
}

/* ---------- boot ---------- */
function boot() {
  const hashAuth = readHashAuth();
  if (hashAuth) {
    if (hashAuth.server) state.server = hashAuth.server;
    state.token = hashAuth.token;
  }
  $("relay-url").value = state.server;
  if (state.token) {
    api("/v1/status").then((status) => {
      state.status = status;
      localStorage.setItem("securitypay.server", state.server);
      localStorage.setItem("securitypay.token", state.token);
      showApp();
    }).catch((e) => {
      $("relay-url").value = state.server;
      if (hashAuth) {
        state.token = "";
        $("login-error").textContent =
          e.status === 401
            ? "La clave de API del enlace no es válida."
            : `No se pudo conectar con el enlace: ${e.message}`;
      }
    });
  }
  $("login-btn").addEventListener("click", login);
  $("api-key").addEventListener("keydown", (e) => { if (e.key === "Enter") login(); });
  $("logout-btn").addEventListener("click", logout);
  $("copy-access-link")?.addEventListener("click", async () => {
    if (!state.token) return;
    const btn = $("copy-access-link");
    try {
      await copyText(buildAccessLink());
      const prev = btn.textContent;
      btn.textContent = "¡Enlace copiado!";
      setTimeout(() => { btn.textContent = prev; }, 2000);
    } catch {
      alert("No se pudo copiar el enlace al portapapeles.");
    }
  });
  $("refresh-btn").addEventListener("click", refreshAll);
  $("pair-btn").addEventListener("click", openPair);
  $("pair-close").addEventListener("click", () => $("pair-dialog").close());
  $("test-btn").addEventListener("click", () => $("test-dialog").showModal());
  $("test-close").addEventListener("click", () => $("test-dialog").close());
  $("test-cancel").addEventListener("click", () => $("test-dialog").close());
  $("test-send").addEventListener("click", sendTest);
  $("sound-btn").addEventListener("click", async () => {
    state.sound = !state.sound;
    $("sound-btn").textContent = state.sound ? "🔕 Silenciar alarma" : "🔔 Activar sonido";
    if (state.sound) {
      ensureAudio();
      const ctx = state.audioCtx;
      if (ctx) {
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.value = 0.04;
        o.frequency.value = 880;
        o.connect(g).connect(ctx.destination);
        o.start();
        setTimeout(() => { try { o.stop(); g.disconnect(); } catch {} }, 160);
      }
    } else stopSiren();
  });
  $("notify-btn").addEventListener("click", async () => {
    if (!("Notification" in window)) return alert("Este navegador no soporta notificaciones.");
    const p = await Notification.requestPermission();
    state.notify = p === "granted";
    $("notify-btn").textContent = state.notify ? "Avisos activados" : "Permitir avisos";
  });
  $("copy-snippet").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("backend-snippet").textContent); $("copy-snippet").textContent = "¡Copiado!"; setTimeout(() => ($("copy-snippet").textContent = "Copiar ejemplo"), 1500); } catch {}
  });
  for (const chip of document.querySelectorAll("[data-filter]")) {
    chip.addEventListener("click", () => {
      state.filter = chip.dataset.filter;
      document.querySelectorAll("[data-filter]").forEach((c) => c.classList.toggle("active", c === chip));
      render();
    });
  }
  setInterval(render, 30000);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("/panel/sw.js").catch(() => {});
  }
}

boot();
