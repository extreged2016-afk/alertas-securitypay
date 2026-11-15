# Agente de voz (LiveKit + Edge TTS)

Escucha el relay por WebSocket (`/ws/relay`) y, cuando llega una alerta
`critical` con `voice_room`, entra en esa sala de LiveKit y la explica en voz
alta. El móvil entra como oyente y oye la explicación; si el worker no está,
el teléfono usa su TTS local, así que una alerta crítica nunca queda muda.

## Variables

| Variable | Obligatoria | Descripción |
| --- | --- | --- |
| `SECURITYPAY_RELAY_URL` | no | `https://tu-relay` (por defecto `http://relay:8080`) |
| `SECURITYPAY_API_KEY` | sí | API key del relay (`/data/api_key` o el log de arranque) |
| `SECURITYPAY_VOICE` | no | Voz de Edge TTS (`es-ES-ElviraNeural`, `es-ES-AlvaroNeural`, …) |
| `SECURITYPAY_VERBOSE` | no | `1` para más logs |

No necesita claves de LiveKit: pide un token de publicación al relay con la
API key, igual que el daemon.

## Docker

```bash
cd voice-agent
docker build -t securitypay-voice .
docker run --rm --env-file .env securitypay-voice
```

En `deploy/docker-compose.yml` ya hay un servicio `voice-agent` (perfil
`voice`):

```bash
SECURITYPAY_API_KEY=ak_... docker compose --profile voice up -d --build
```

## Sin Docker

Necesita Python 3.11+ y `ffmpeg` en el `PATH`:

```bash
pip install -r requirements.txt
SECURITYPAY_RELAY_URL=https://alertas.midominio.com \
SECURITYPAY_API_KEY=ak_... \
python securitypay_voice.py
```

## Cómo saber si funciona

```bash
SECURITYPAY_API_KEY=ak_... python scripts/send-alert.mjs \
  --type test --title "Prueba" --message "Hola" --priority critical
```

El log del worker muestra `explicando alert_...` y el móvil entra solo en la
sala (o pulsa **Escuchar explicación** en la alerta).
