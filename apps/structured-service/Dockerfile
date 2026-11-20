# fork: product and menu extraction (PLAN.md Phase 13). Backend network only;
# talks to the host's Ollama for pages without structured data.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY server.py .
USER nobody
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
