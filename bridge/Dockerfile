# Docker build for the Techno-Notify TT5 bridge.
#
# teamtalk.py downloads the TeamTalk5 SDK at RUNTIME by scraping
# https://bearware.dk/teamtalksdk. That host returns HTTP 454 to Render's
# IPs (its scraper is also outdated — the listing no longer contains the
# "5.15" folder it searches for). To make deploys reliable we instead bake
# the SDK into the image ourselves, so teamtalk.py finds the local libs on
# import and never triggers a download.
#
# You MUST deploy this as a Render "Docker" web service (Render's native
# Python runtime can't apt-install 7z).
FROM python:3.11-slim

# 7z to extract the committed SDK archive; ca-certs for HTTPS.
RUN apt-get update && apt-get install -y --no-install-recommends \
        p7zip-full ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# --- Inject the TeamTalk5 SDK into the installed teamtalk.py package ---
# Put tt5sdk.7z (downloaded once from bearware.dk on a normal network) in
# this folder and commit it. We extract it and drop Library/TeamTalk_DLL
# and Library/TeamTalkPy into teamtalk/implementation/, exactly where
# teamtalk.py's __init__ looks, so import-time download_sdk() never runs.
COPY tt5sdk.7z /tmp/tt5sdk.7z
RUN set -eux; \
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
