// Puente mínimo para la ventana: no expone Node al panel.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("securitypayDesktop", {
  notify: (title, body) => ipcRenderer.send("securitypay-notify", { title, body }),
  setPanelUrl: (url) => ipcRenderer.send("securitypay-set-url", url),
});