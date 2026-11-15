# Backend Node.js de ejemplo (Render)

Servicio mínimo, sin dependencias, que recibe un `POST /alert` y lo reenvía al
relay como alerta. Úsalo como plantilla para tu backend real: cualquier cosa que
pueda hacer un `fetch` puede crear alertas.

```bash
cd examples/node-alerts
RELAY_URL=https://alertas.midominio.com \
RELAY_API_KEY=ak_... \
ALERT_WEBHOOK_SECRET=super-secreto \
npm start
```

```bash
curl -X POST http://localhost:3000/alert \
  -H "authorization: Bearer super-secreto" \
  -H "content-type: application/json" \
  -d '{"title":"Disco lleno","message":"Queda un 3%","priority":"critical"}'
```

## Variables

| Variable | Descripción |
| --- | --- |
| `RELAY_URL` | URL pública del relay |
| `RELAY_API_KEY` | API key del relay (`/data/api_key`) |
| `ALERT_WEBHOOK_SECRET` | Secreto que deben enviar tus sistemas; vacío = sin auth |
| `PORT` | Render lo inyecta solo |

## Desplegar en Render

1. Sube este proyecto a GitHub.
2. Render → **New → Web Service** → Dockerfile **no** hace falta: *Runtime* Node,
   *Build Command* `npm install`, *Start Command* `npm start`.
3. Añade las variables de entorno del cuadro de arriba.
4. Health check: `/healthz`.

También puedes desplegarlo con el `render.yaml` de la raíz del repositorio.

## Enviar una alerta desde tu código

```js
await fetch("https://tu-backend.onrender.com/alert", {
  method: "POST",
  headers: { authorization: `Bearer ${process.env.ALERT_WEBHOOK_SECRET}`, "content-type": "application/json" },
  body: JSON.stringify({
    title: "El job de precios ha fallado",
    message: "Tres reintentos agotados. Revisa la cola.",
    priority: "critical",
  }),
});
```

Prioridades: `low`, `normal`, `high` (sirena) y `critical` (sirena + voz).
