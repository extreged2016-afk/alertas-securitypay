# Alert SecurityPay — agente de voz
#
# Escucha el relay por WebSocket (`/ws/relay`), y cuando llega una alerta
# `critical` entra en su sala de LiveKit y la explica en voz alta con Edge TTS.
#
# Variables de entorno:
#   SECURITYPAY_RELAY_URL   URL del relay (http/https). Por defecto http://relay:8080
#   SECURITYPAY_API_KEY     API key del relay (obligatoria). Sale en el primer log del relay
#                           y está en /data/api_key. Los móviles NO pueden usarla.
#   SECURITYPAY_VOICE       Voz de Edge TTS. Por defecto es-ES-ElviraNeural
#   SECURITYPAY_LANG        Idioma de reserva para el texto. Por defecto es
#   SECURITYPAY_VERBOSE     "1" para logs detallados

import asyncio
import contextlib
import json
import os
import shutil
import tempfile
import urllib.parse

try:
    import edge_tts
    import httpx
    import websockets
    from livekit import rtc
except Exception as err:  # noqa: BLE001
    print(f"[voice-agent] dependencia faltante: {err}", flush=True)
    raise

RELAY_URL = os.environ.get("SECURITYPAY_RELAY_URL", "http://relay:8080").rstrip("/")
API_KEY = os.environ.get("SECURITYPAY_API_KEY", "").strip()
API_KEY_FILE = os.environ.get("SECURITYPAY_API_KEY_FILE", "")
if not API_KEY and API_KEY_FILE:
    try:
        with open(API_KEY_FILE, encoding="utf-8") as fh:
            API_KEY = fh.read().strip()
    except OSError as err:
        print(f"[voice-agent] no se pudo leer la API key de {API_KEY_FILE}: {err}", flush=True)
VOICE = os.environ.get("SECURITYPAY_VOICE", "es-ES-ElviraNeural")
VERBOSE = os.environ.get("SECURITYPAY_VERBOSE") == "1"

SAMPLE_RATE = 48_000
CHANNELS = 1
FRAME_MS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MS // 1000
BYTES_PER_FRAME = SAMPLES_PER_FRAME * 2 * CHANNELS

# Una alerta por id; se limpia al confirmarla o al terminar de hablar.
_rooms: dict[str, "rtc.Room"] = {}
_handled: set[str] = set()


def log(*args: object) -> None:
    print("[voice-agent]", *args, flush=True)


def ws_url() -> str:
    base = RELAY_URL.replace("https://", "wss://").replace("http://", "ws://")
    return f"{base}/ws/relay?token={urllib.parse.quote(API_KEY)}"


async def join_info(client: httpx.AsyncClient, alert_id: str) -> dict | None:
    try:
        res = await client.post(
            f"{RELAY_URL}/v1/alerts/{urllib.parse.quote(alert_id)}/voice-token",
            headers={"Authorization": f"Bearer {API_KEY}"},
            timeout=10,
        )
        res.raise_for_status()
        return res.json()
    except Exception as err:  # noqa: BLE001 - one alert failing must not stop the worker
        log(f"no se pudo obtener el token de voz para {alert_id}: {err}")
        return None


async def synthesize(text: str) -> bytes:
    """MP3 de Edge TTS, convertido a PCM s16le mono 48 kHz con ffmpeg."""
    ffmpeg = shutil.which("ffmpeg")
    if not ffmpeg:
        raise RuntimeError("ffmpeg no está instalado en la imagen")
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        path = tmp.name
    try:
        await edge_tts.Communicate(text, VOICE).save(path)
        proc = await asyncio.create_subprocess_exec(
            ffmpeg,
            "-v",
            "error",
            "-i",
            path,
            "-f",
            "s16le",
            "-acodec",
            "pcm_s16le",
            "-ac",
            str(CHANNELS),
            "-ar",
            str(SAMPLE_RATE),
            "pipe:1",
            stdout=asyncio.subprocess.PIPE,
        )
        assert proc.stdout is not None
        pcm = await proc.stdout.read()
        await proc.wait()
        return pcm
    finally:
        with contextlib.suppress(OSError):
            os.unlink(path)


async def announce(alert: dict, info: dict) -> None:
    alert_id = alert["alert_id"]
    text = alert.get("tts_text") or f"Alerta crítica. {alert['title']}. {alert['message']}"
    log(f"explicando {alert_id}: {text[:80]}")
    room = rtc.Room()
    _rooms[alert_id] = room
    try:
        await room.connect(info["livekit_url"], info["livekit_token"])
        source = rtc.AudioSource(SAMPLE_RATE, CHANNELS)
        track = rtc.LocalAudioTrack.create_audio_track("alerta", source)
        options = rtc.TrackPublishOptions()
        options.source = rtc.TrackSource.SOURCE_MICROPHONE
        await room.local_participant.publish_track(track, options)

        pcm = await synthesize(text)
        for start in range(0, len(pcm) - BYTES_PER_FRAME + 1, BYTES_PER_FRAME):
            if alert_id not in _rooms:
                return  # confirmada o sustituida mientras hablaba
            chunk = pcm[start : start + BYTES_PER_FRAME]
            frame = rtc.AudioFrame(chunk, SAMPLE_RATE, CHANNELS, SAMPLES_PER_FRAME)
            await source.capture_frame(frame)

        # Deja la sala unos segundos abiertos: si el móvil entra tarde, aún oye algo.
        await asyncio.sleep(3)
    except Exception as err:  # noqa: BLE001
        log(f"fallo explicando {alert_id}: {err}")
    finally:
        _rooms.pop(alert_id, None)
        with contextlib.suppress(Exception):
            await room.disconnect()


async def handle_alert(alert: dict) -> None:
    alert_id = alert.get("alert_id")
    if not alert_id or alert_id in _handled:
        return
    _handled.add(alert_id)
    if len(_handled) > 500:
        _handled.clear()
    if alert.get("priority") != "critical" or not alert.get("voice_room"):
        return
    async with httpx.AsyncClient() as client:
        info = await join_info(client, alert_id)
    if info:
        await announce(alert, info)


async def run_once() -> None:
    log(f"conectando a {RELAY_URL}")
    async with websockets.connect(ws_url(), ping_interval=20, ping_timeout=60) as ws:
        log("conectado al relay")
        async for raw in ws:
            try:
                event = json.loads(raw)
            except json.JSONDecodeError:
                continue
            kind = event.get("type")
            if kind == "alert.new":
                if VERBOSE:
                    log(f"alerta {event.get('alert_id')} prioridad {event.get('priority')}")
                asyncio.create_task(handle_alert(event))
            elif kind == "alert.ack":
                alert_id = event.get("alert_id")
                room = _rooms.pop(alert_id, None) if alert_id else None
                if room:
                    log(f"alerta {alert_id} confirmada: cerrando voz")
                    with contextlib.suppress(Exception):
                        await room.disconnect()


async def main() -> None:
    log(f"relay={RELAY_URL} voz={VOICE} api_key={'definida' if API_KEY else 'FALTANTE'}")
    if not API_KEY:
        raise SystemExit("SECURITYPAY_API_KEY no está definida (configúrala en el worker de Render)")
    delay = 1.0
    while True:
        try:
            await run_once()
            delay = 1.0
        except asyncio.CancelledError:
            raise
        except Exception as err:  # noqa: BLE001
            log(f"desconectado: {err}. Reintento en {delay:.0f}s")
            await asyncio.sleep(delay)
            delay = min(delay * 2, 30.0)


if __name__ == "__main__":
    asyncio.run(main())
