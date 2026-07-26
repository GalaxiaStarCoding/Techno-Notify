# Docker build for the Techno-Notify TT5 bridge.
# Use this Render service type if teamtalk.py's prebuilt wheel doesn't match
# Render's native Python runtime — "New > Web Service > Docker" with this
# Dockerfile gives you a controlled Linux environment.
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

EXPOSE 8000
CMD ["sh", "-c", "uvicorn main:app --host 0.0.0.0 --port ${PORT:-8000}"]
