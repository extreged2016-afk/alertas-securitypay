# Centro de alertas

Alert SecurityPay añade un centro de alertas ilimitado sobre el relay y la app.
Este documento describe el flujo completo y cómo desplegarlo.

## Flujo

```
POST /v1/alerts ──▶ SQLite ──▶ evento alert.new ──▶ /ws/relay ──▶ móvil/panel
                        │
                        └──▶ FCM data-only (si está configurado) ──▶ móvil dormido
```

1. Tu backend crea la alerta con `POST /v1/alerts` (API key de agente).
2. El relay la guarda y emite `alert.new` por el WebSocket.
3. Si el móvil está suscrito a FCM, el relay manda además un push data-only con
   el mismo evento (recortado al límite de FCM).
4. La app deduplica por `alert_id`: da igual que lleguen el push y el socket, la
   sirena suena una sola vez.
5. En `critical`, el relay crea la sala `alert-<id>` en LiveKit y el agente de
   voz la explica. El móvil entra como oyente.

## Modelo

| Campo | Tipo | Notas |
| --- | --- | --- |
| `alert_id` | string | `alert_...` |
| `type` | string | libre (60 chars): `backup`, `deploy`, `test`… |
| `title` | string | 200 chars |
| `message` | string | 4.000 chars |
| `priority` | `low` \| `normal` \| `high` \| `critical` | `high` suena; `critical` suena y habla |
| `source` | string | quién la creó |
| `data` | objeto | JSON libre |
| `voice` | bool | `false` no crea sala de voz |
| `tts_text` | string | lo que lee el agente de voz (por defecto título + mensaje) |
| `created_at` | ms | |
| `acked_at` / `acked_by` | ms / `agent` \| `user` | |

## Eventos

`alert.new` (resumen; el mismo que el push):

```json
{
  "type": "alert.new",
  "id": "evt_...",
  "ts": 1760000000000,
  "seq": 42,
  "alert_id": "alert_...",
  "alert_type": "backup",
  "title": "Backup fallido",
  "message": "3 reintentos agotados",
  "priority": "critical",
  "source": "nightly",
  "voice_room": "alert-alert_...",
  "voice_url": "wss://livekit.midominio.com",
  "created_at": 1760000000000
}
```

`alert.ack`:

```json
{ "type": "alert.ack", "alert_id": "alert_...", "acked_at": 1760000001000, "acked_by": "user" }
```

## FCM

Sin FCM la app sigue recibiendo por el servicio en primer plano. Con FCM:

1. Cuenta de servicio de Firebase en `FCM_SERVICE_ACCOUNT_JSON` (Render) o
   `FCM_SERVICE_ACCOUNT_FILE` (Docker).
2. La app configura Firebase con los datos del emparejamiento
   (`PushRegistrar.initFirebase`): no hace falta `google-services.json`.
3. Los pushes son **data-only** (`type`, `message`, `priority` y el JSON del
   evento). La app decide sonido, pantalla completa y voz.

## Batería

- El WebSocket del servicio en primer plano es event-driven: ping cada 20 s.
- La notificación del servicio es de importancia baja.
- La sirena usa `PARTIAL_WAKE_LOCK` solo mientras suena (20 s altas, 60 s
  críticas).
- En ajustes se puede desactivar la escucha en tiempo real y quedarse solo con
  FCM.
- En móviles con ahorro agresivo (Xiaomi, Samsung, Huawei), activa «sin
  restricciones» y el inicio automático: ver `docs/troubleshooting-oem.md`.

## Render

`render.yaml` define:

- `alert-securitypay-relay` (Docker, `/data` persistente, `/healthz`).
- `alert-securitypay-voice` (worker, Edge TTS + LiveKit).

El relay usa `RENDER_EXTERNAL_URL` como URL pública si no defines
`SECURITYPAY_PUBLIC_URL`. Sin disco persistente el SQLite y la API key se
pierden en cada despliegue: usa plan *starter* o superior.

LiveKit en Render no es práctico (necesita UDP). Usa LiveKit Cloud o un VPS
aparte y apunta `LIVEKIT_URL` / `LIVEKIT_API_URL` allí.

## Límites

Ninguno impuesto por la app ni por el relay: historial de 1.000 alertas en el
móvil, todas en el relay, y sin cuotas de mensajes ni minutos. El único límite
real es el tamaño por alerta (4 KB de mensaje, 8 KB de `data`).
