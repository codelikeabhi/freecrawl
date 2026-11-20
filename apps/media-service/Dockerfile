# fork: media service (PLAN.md Phase 9) speaking avgrab's contract with yt-dlp.
# Backend network only. Deno solves YouTube's JavaScript challenges for yt-dlp.
FROM denoland/deno:bin-2.9.7 AS deno
FROM python:3.12-slim
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY --from=deno /deno /usr/local/bin/deno
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
