# Escritorio (Electron)

El escritorio usa **el mismo panel** que sirve el relay en `/panel/` (PWA con
sonido, notificaciones, historial, QR de emparejamiento y WebSocket en tiempo
real). Este envoltorio solo añade una ventana nativa, bandeja y notificaciones
del sistema para Windows, macOS y Linux.

## Uso

```bash
cd desktop
npm install
SECURITYPAY_PANEL_URL=https://alertas.midominio.com/panel/ npm start
```

Sin variable de entorno lee `config.json`:

```json
{ "panelUrl": "https://alertas.midominio.com/panel/" }
```

## Empaquetar

```bash
npm run dist
```

Genera el instalador en `dist/` (NSIS en Windows, AppImage en Linux, DMG en
macOS). Se puede publicar el panel como app de escritorio sin tocar el relay.

## Bandeja

Si añades un `tray.png` (32×32) junto a `main.js`, la app se queda en la
bandeja al cerrar la ventana y sigue recibiendo alertas. Sin icono, cerrar la
ventana cierra la app.

El panel pide permiso de notificaciones la primera vez. Si el navegador
incrustado no las muestra, el preload expone
`window.securitypayDesktop.notify(title, body)` para usar la notificación
nativa de Electron.
