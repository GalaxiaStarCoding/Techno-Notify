# Docker build for the Techno-Notify TT5 bridge.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
        p7zip-full ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

RUN set -eux; \
    curl -fsSL --retry 3 --retry-delay 5 \
        -A "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36" \
        -o /tmp/tt5sdk.7z \
        "https://www.bearware.dk/teamtalksdk/v5.22a/tt5sdk_v5.22a_ubuntu22_x86_64.7z"; \
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
