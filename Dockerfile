FROM python:3.10-slim-bookworm

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 MPLBACKEND=Agg
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg libgl1 libglib2.0-0 fonts-dejavu-core ca-certificates \
    && rm -rf /var/lib/apt/lists/*
COPY backend/requirements.txt /tmp/requirements.txt
RUN sed '/^nvidia-/d' /tmp/requirements.txt > /tmp/requirements-cpu.txt \
    && python -m pip install --no-cache-dir --prefer-binary -r /tmp/requirements-cpu.txt \
    && python -m pip check
COPY backend/ ./backend/
CMD ["python", "backend/cli.py", "serve", "--host", "0.0.0.0", "--port", "8000"]
