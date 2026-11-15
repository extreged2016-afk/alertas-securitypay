# Alert SecurityPay

**Tu centro de alertas, ilimitado y en español.** Recibe avisos de tus agentes
de IA, scripts o backend y haz que suenen como una alarma en el móvil —también
bloqueado y en segundo plano— y en el escritorio. Si la alerta es **crítica**,
el teléfono entra en una sala de voz y un agente te explica qué ha pasado.

- **Ilimitado de verdad**: sin planes, cuotas ni límites de mensajes o alertas.
  Todo corre en tu servidor.
- **Android nativo** (Kotlin/Compose) + **escritorio** (panel web/PWA y
  envoltorio Electron).
- **FCM + WebSocket** (`/ws/relay`): las alertas llegan al instante y la app las
  muestra aunque esté cerrada.
- **Voz automática** en críticas: LiveKit + Edge TTS, con TTS local como red de
  seguridad.
- **Historial** persistente en el móvil y en el relay, con confirmación (ack)
  desde la notificación.

> Proyecto derivado de [securitypay](https://github.com/mutonby/securitypay)
> (Apache-2.0), rebautizado y ampliado con el centro de alertas.

## Arquitectura

```
  tu backend / agente / script
        │  POST /v1/alerts (API key)
        ▼
  ┌──────────────┐   FCM (data-only)    ┌──────────────────┐
  │ relay (Node) │ ───────────────────▶ │ Android          │
  │ Fastify +    │   /ws/relay (WSS)    │ alerta + sirena  │
  │ SQLite       │ ───────────────────▶ │ + voz LiveKit    │
  │ panel /panel │                      └──────────────────┘
  └──────┬───────┘
         │ alert.new (critical)
         ▼
  ┌──────────────┐   LiveKit (audio)    ┌──────────────────┐
  │ voice-agent  │ ───────────────────▶ │ móvil (oyente)   │
  │ Edge TTS     │                      │ panel (oyente)   │
  └──────────────┘                      └──────────────────┘
```

- **Relay**: API REST, WebSocket, push, panel web y salas de voz. Una sola
  instancia con SQLite.
- **Android**: servicio en primer plano con el WebSocket, alarma con stream de
  alarma y pantalla completa, historial SQLite y voz LiveKit/TTS.
- **Panel**: login con la API key, dashboard, historial, alerta de prueba, QR de
  emparejamiento, sonido y notificaciones del navegador.
- **voice-agent**: escucha el relay y explica las críticas con Edge TTS.

## Inicio rápido

### 1. Relay en Render

El repositorio incluye `render.yaml` (relay + agente de voz). Sube el proyecto a
GitHub, crea un **Blueprint** en Render y rellena los secretos. Necesitas un
disco persistente (plan *starter* o superior): el SQLite, la API key y el
historial viven en `/data`.

Si prefieres Docker en tu servidor:

```bash
cd deploy
cp .env.example .env      # pon SECURITYPAY_DOMAIN
docker compose up -d --build
docker compose logs relay | grep -A2 "API key"
```

En local, sin TLS:

```bash
cd relay
npm install
SECURITYPAY_INSECURE_DEV=1 SECURITYPAY_PUBLIC_URL=http://localhost:8080 npm run dev
```

La API key se imprime una vez al arrancar y queda en `data/api_key`.

### 2. Empareja el móvil

1. Abre `https://TU-RELAY/panel/` e inicia sesión con la API key.
2. Pulsa **Mostrar QR de emparejamiento**.
3. Instala el APK (`app-android/app/build/outputs/apk/debug/app-debug.apk`) y
   escanea el QR desde **Alert SecurityPay**.

El móvil queda suscrito a FCM (si configuras Firebase) y abre el WebSocket
persistente.

### 3. Envía la primera alerta

```bash
curl -X POST https://TU-RELAY/v1/alerts \
  -H "authorization: Bearer ak_..." \
  -H "content-type: application/json" \
  -d '{"type":"backup","title":"Backup fallido","message":"3 reintentos agotados","priority":"critical"}'
```

O con el script incluido:

```bash
SECURITYPAY_RELAY_URL=https://TU-RELAY SECURITYPAY_API_KEY=ak_... \
node scripts/send-alert.mjs --title "Disco lleno" --message "Queda 3%" --priority critical
```

Prioridades: `low`, `normal`, `high` (sirena) y `critical` (sirena + voz).

## Firebase (FCM)

Sin Firebase, las alertas siguen llegando mientras el servicio en primer plano
tenga red. Para que suenen con la app cerrada:

1. Crea un proyecto en Firebase y añade una app Android con el paquete
   `com.securitypay.alerts`.
2. Descarga la **cuenta de servicio** (Configuración → Cuentas de servicio).
3. En Render pega el JSON completo en `FCM_SERVICE_ACCOUNT_JSON`; en Docker
   monta el archivo y usa `FCM_SERVICE_ACCOUNT_FILE`.
4. Vuelve a emparejar el móvil. La app configura Firebase en tiempo de
   ejecución con los datos del relay: no hay `google-services.json` compilado.

Detalles en [docs/firebase.md](docs/firebase.md).

## Voz en alertas críticas

1. Configura LiveKit en el relay (`LIVEKIT_URL`, `LIVEKIT_API_URL`,
   `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET`). El `docker-compose.yml` ya trae
   LiveKit y Caddy.
2. Arranca el agente de voz:

   ```bash
   SECURITYPAY_API_KEY=ak_... docker compose --profile voice up -d --build
   ```

3. Envía una alerta `critical`. El relay crea `alert-<id>`, el worker pide un
   token de publicación, sintetiza el texto con Edge TTS y lo publica. El móvil
   entra como oyente automáticamente.

Si el worker no está, el móvil habla la alerta con su TTS en español; nunca se
queda en silencio. Ver [voice-agent/README.md](voice-agent/README.md).

## Escritorio

El panel es una PWA: ábrelo en el navegador y usa **Instalar**. Para una app de
escritorio nativa:

```bash
cd desktop
npm install
npm start
```

Lee `desktop/README.md` para la bandeja y el empaquetado con Electron Builder.

## Android

```bash
cd app-android
./gradlew :app:assembleDebug      # APK de depuración
./gradlew :core:test              # tests del protocolo
```

- `compileSdk`/`targetSdk` 35, `minSdk` 26 (Android 8+).
- Permisos: notificaciones, pantalla completa, batería sin restricciones y
  (opcional) micrófono para las llamadas.
- Ajustes → Alertas: escucha en tiempo real, sirena y voz automática.

## API de alertas

| Método | Ruta | Descripción |
| --- | --- | --- |
| `POST` | `/v1/alerts` | Crea una alerta (`type`, `title`, `message`, `priority`, `data`, `voice`) |
| `GET` | `/v1/alerts?limit=&priority=` | Historial |
| `GET` | `/v1/alerts/:id` | Una alerta |
| `POST` | `/v1/alerts/:id/ack` | Confirma (dispara `alert.ack`) |
| `POST` | `/v1/alerts/:id/voice-token` | Token de LiveKit (oyente; agente = publica) |
| `GET` | `/ws/relay?token=` | WebSocket de eventos (`alert.new`, `alert.ack`, …) |

Contrato completo en [protocol/relay.openapi.yaml](protocol/relay.openapi.yaml).

## Seguridad

- La API key es de agente: **no la metas en el móvil ni en el navegador de
  terceros**. El panel la guarda en `localStorage` de tu propio equipo.
- Cada dispositivo recibe su propio JWT y su secreto de push.
- Las alertas críticas requieren `USE_FULL_SCREEN_INTENT`; Android puede pedir
  confirmación la primera vez.
- No hay cuotas: protege el relay con TLS y una API key larga.

## Documentación

- [docs/](docs/) — arquitectura, despliegue, Firebase y Android Auto.
- [voice-agent/README.md](voice-agent/README.md) — agente de voz.
- [examples/node-alerts](examples/node-alerts) — backend Node.js de ejemplo.
- [desktop/README.md](desktop/README.md) — app de escritorio.

## Licencia

Apache-2.0. Ver [LICENSE](LICENSE).
