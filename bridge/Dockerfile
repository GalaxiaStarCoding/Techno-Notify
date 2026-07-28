F# Docker build for the Techno-Notify TT5 bridge.
#
# bearware.dk refuses Render's cloud IPs (HTTP 454 / curl exit code 22),
# so we can't fetch the TeamTalk5 SDK from there during the Render build.
# Instead you host the SDK .7z once on catbox.moe (or any host that gives a
# direct download link) and point the build at it via the TTSDK_URL env
# var. Render auto-converts environment variables into Docker build args.
#
# Deploy as a Render "Docker" web service.
#
# One-time setup:
#   1. Go to https://catbox.moe/main.php , upload tt5sdk.7z, copy the
#      direct link it returns (looks like https://files.catbox.moe/xxxx.7z).
#   2. In Render -> Environment, add a variable TTSDK_URL = that link.
FROM python:3.11-slim

ARG TTSDK_URL

RUN apt-get update && apt-get install -y --no-install-recommends \
        p7zip-full ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Fetch the SDK .7z from TTSDK_URL (your catbox link) and inject
# Library/TeamTalk_DLL + Library/TeamTalkPy into the installed teamtalk.py
# package — exactly where its __init__ looks — so the import-time download
# never runs.
RUN set -eux; \
    test -n "$TTSDK_URL"; \
    curl -fsSL \
        -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        -o /tmp/tt5sdk.7z "$TTSDK_URL"; \
    mkdir -p /tmp/ttsdk; \
    7z x /tmp/tt5sdk.7z -o/tmp/ttsdk >/dev/null; \
    SDKROOT="/tmp/ttsdk/$(ls /tmp/ttsdk | head -n1)"; \
    IMPL="/usr/local/lib/python3.11/site-packages/teamtalk/implementation"; \
    rm -rf "$IMPL"; \
    mkdir -p "$IMPL"; \
    cp -a "$SDKROOT/Library/TeamTalk_DLL" "$IMPL/TeamTalk_DLL"; \
    cp -a "$SDKROOT/Library/TeamTalkPy" "$IMPL/TeamTalkPy"; \
    : > "$IMPL/__init__.py"; \
    rm -rf "$IMPL/TeamTalkPy/test" /tmp/ttsdk /tmp/tt5sdk.7z

COPY . .

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
