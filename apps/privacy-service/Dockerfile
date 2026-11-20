# fork: PII redaction service (PLAN.md Phase 11) speaking fire-privacy's
# /redact contract with Microsoft Presidio. Backend network only.
FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt \
    && python -m spacy download en_core_web_md
COPY server.py .
USER nobody
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080", "--no-access-log"]
