# fork: the OCR service as a container, for machines without the macOS host
# agent (scripts/fork/ocr.sh, which uses the Apple GPU). MinerU on the CPU
# here, so a page takes several seconds. Backend network only, no published
# port; the API calls http://ocr:3020 (FIRE_PDF_BASE_URL).
FROM python:3.12-slim

RUN apt-get update \
  && apt-get install -y --no-install-recommends libgl1 libglib2.0-0 \
  && rm -rf /var/lib/apt/lists/*

# YOLO_CONFIG_DIR: the layout model writes its settings file at import.
ENV HOME=/opt/mineru MINERU_DEVICE_MODE=cpu PIP_NO_CACHE_DIR=1 YOLO_CONFIG_DIR=/tmp/yolo
WORKDIR /app
COPY requirements.txt .
# CPU builds of torch: PyPI's Linux x86 wheel bundles gigabytes of CUDA.
RUN pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu \
  && pip install --extra-index-url https://download.pytorch.org/whl/cpu -r requirements.txt
# Models (about 2 GB) go into the image, so the first request does not wait.
RUN mineru-models-download -s huggingface -m pipeline \
  && chown -R nobody:nogroup /opt/mineru
COPY server.py .

USER nobody
EXPOSE 3020
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "3020", "--no-access-log"]
