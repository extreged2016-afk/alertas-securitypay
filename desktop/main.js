// Wrapper de escritorio (Windows/macOS/Linux) del panel de Alert SecurityPay.
// El panel es la misma PWA que sirve el relay en /panel/, así que aquí no hay
// lógica de alertas: solo una ventana, notificaciones nativas y bandeja.
//
//   npm install
//   npm start
//
// La URL se toma de (en orden):
//   1. SECURITYPAY_PANEL_URL
//   2. config.json → panelUrl
//   3. http://localhost:8080/panel/

const { app, BrowserWindow, Menu, Notification, shell, Tray, nativeImage, ipcMain } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

function panelUrl() {
  if (process.env.SECURITYPAY_PANEL_URL) return process.env.SECURITYPAY_PANEL_URL;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, "config.json"), "utf8"));
    if (cfg.panelUrl) return cfg.panelUrl;
  } catch {
    // Sin config.json: modo local.
  }
  return "http://localhost:8080/panel/";
}

const URL_BASE = panelUrl();
let mainWindow = null;
let tray = null;

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

  mainWindow.loadURL(URL_BASE);

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
      { label: "Recargar", click: () => mainWindow?.reload() },
      { type: "separator" },
      { label: "Salir", click: () => app.quit() },
    ]),
  );
  tray.on("click", () => (mainWindow ? mainWindow.show() : createWindow()));
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

// Notificación nativa de respaldo: si el panel no puede usar la API del
// navegador (por ejemplo, con la ventana minimizada y sin permiso), aquí al
// menos se ve el aviso.
ipcMain.on("securitypay-notify", (_event, { title, body } = {}) => {
  if (!title) return;
  new Notification({ title: String(title), body: String(body ?? ""), urgency: "critical" }).show();
});
