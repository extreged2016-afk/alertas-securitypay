// Wrapper de escritorio (Windows/macOS/Linux) del panel de Alert SecurityPay.
// El panel es la misma PWA que sirve el relay en /panel/, así que aquí no hay
// lógica de alertas: solo una ventana, notificaciones nativas y bandeja.
//
//   npm install
//   npm start
//
// La URL se toma de (en orden):
//   1. SECURITYPAY_PANEL_URL
//   2. config.json del usuario (userData/config.json) → panelUrl
//   3. config.json junto al ejecutable → panelUrl
//   4. http://localhost:8080/panel/

const { app, BrowserWindow, Menu, Notification, shell, Tray, nativeImage, ipcMain, dialog } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const USER_CONFIG = path.join(app.getPath("userData"), "config.json");

function readConfig(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function panelUrl() {
  if (process.env.SECURITYPAY_PANEL_URL) return process.env.SECURITYPAY_PANEL_URL;
  const userCfg = readConfig(USER_CONFIG);
  if (userCfg?.panelUrl) return userCfg.panelUrl;
  try {
    const cfg = readConfig(path.join(__dirname, "config.json"));
    if (cfg?.panelUrl) return cfg.panelUrl;
  } catch {}
  return "http://localhost:8080/panel/";
}

function savePanelUrl(url) {
  try {
    fs.mkdirSync(path.dirname(USER_CONFIG), { recursive: true });
    fs.writeFileSync(USER_CONFIG, JSON.stringify({ panelUrl: url }, null, 2), "utf8");
  } catch (e) {
    console.error("No se pudo guardar la URL:", e);
  }
}

const URL_BASE = panelUrl();
let mainWindow = null;
let tray = null;

function errorPage(url, reason) {
  const safeUrl = String(url).replace(/</g, "&lt;");
  const safeReason = String(reason || "").replace(/</g, "&lt;");
  return `data:text/html;charset=utf-8,` + encodeURIComponent(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><title>Alert SecurityPay</title>
<style>body{font-family:system-ui,sans-serif;background:#0b0c10;color:#e5e7eb;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{max-width:520px;background:#111827;border:1px solid #1f2937;border-radius:12px;padding:24px}
h1{margin:0 0 8px;font-size:20px}p{color:#9ca3af;line-height:1.5}input{width:100%;padding:10px;border-radius:8px;border:1px solid #374151;background:#0b1220;color:#fff;margin:8px 0}button{padding:10px 16px;border-radius:8px;border:0;background:#2563eb;color:#fff;cursor:pointer;font-weight:600}small{color:#6b7280}</style></head>
<body><div class="card">
<h1>No se pudo abrir el panel</h1>
<p>La aplicación intentó cargar <code>${safeUrl}</code> y falló${safeReason ? ": " + safeReason : ""}.</p>
<p>Introduce la URL de tu Relay (la misma que abres en el navegador, terminada en <code>/panel/</code>) y pulsa Conectar.</p>
<input id="u" value="${safeUrl}" autofocus>
<button id="b">Conectar</button>
<p><small>Consejo: si el Relay está en Render, usa <code>https://tu-servicio.onrender.com/panel/</code>.</small></p>
<script>
  const inp=document.getElementById('u'), btn=document.getElementById('b');
  btn.onclick=()=>{ const v=inp.value.trim(); if(!v) return; window.securitypayDesktop.setPanelUrl(v); };
  inp.addEventListener('keydown',e=>{ if(e.key==='Enter') btn.click(); });
</script>
</div></body></html>`);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 720,
    minHeight: 560,
    title: "Alert SecurityPay",
    backgroundColor: "#0b0c10",
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  const load = () => {
    mainWindow.loadURL(URL_BASE).catch((err) => {
      mainWindow.loadURL(errorPage(URL_BASE, err?.message));
    });
  };
  load();

  mainWindow.webContents.on("did-fail-load", (_e, _code, desc, url) => {
    if (String(url).startsWith("data:")) return;
    mainWindow.loadURL(errorPage(URL_BASE, desc));
  });

  // Los enlaces externos se abren en el navegador, no dentro de la app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith(URL_BASE)) return { action: "allow" };
    shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  // El panel pide permiso de notificaciones; un clic abre la alerta.
  mainWindow.webContents.session.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(permission === "notifications" || permission === "media");
  });
}

function buildTray() {
  // Sin icono empaquetado, la bandeja solo aparece si existe tray.png.
  const iconPath = path.join(__dirname, "tray.png");
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(nativeImage.createFromPath(iconPath));
  tray.setToolTip("Alert SecurityPay");
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: "Abrir", click: () => (mainWindow ? mainWindow.show() : createWindow()) },
      { label: "Cambiar URL del panel", click: () => promptUrl() },
      { label: "Recargar", click: () => mainWindow?.reload() },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => (mainWindow ? mainWindow.show() : createWindow()));
}

function promptUrl() {
  const win = mainWindow;
  if (!win) return;
  const current = panelUrl();
  // Usamos un diálogo simple basado en prompt vía executeJavaScript.
  win.webContents.executeJavaScript(`prompt("URL del panel:", ${JSON.stringify(current)})`).then((v) => {
    if (v && v.trim()) {
      savePanelUrl(v.trim());
      app.relaunch();
      app.exit(0);
    }
  }).catch(() => {});
}

// Cerrar la ventana no cierra la app si hay bandeja: las alertas siguen sonando.
app.on("window-all-closed", () => {
  if (!tray && process.platform !== "darwin") app.quit();
});

app.whenReady().then(() => {
  if (process.platform === "win32") app.setAppUserModelId("com.securitypay.alerts.desktop");
  createWindow();
  buildTray();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Puente con preload: guardar URL y recargar.
ipcMain.on("securitypay-set-url", (_event, url) => {
  if (!url) return;
  savePanelUrl(String(url));
  app.relaunch();
  app.exit(0);
});

// Notificación nativa de respaldo.
ipcMain.on("securitypay-notify", (_event, { title, body } = {}) => {
  if (!title) return;
  new Notification({ title: String(title), body: String(body ?? ""), urgency: "critical" }).show();
});