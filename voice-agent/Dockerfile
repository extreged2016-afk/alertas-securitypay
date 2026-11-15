# Agente de voz de Alert SecurityPay: escucha el relay y explica las alertas
# críticas en una sala de LiveKit.
FROM python:3.12-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt
COPY securitypay_voice.py ./

RUN useradd --system --uid 10001 voice
USER voice

ENV PYTHONUNBUFFERED=1
CMD ["python", "-u", "securitypay_voice.py"]
