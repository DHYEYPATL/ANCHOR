FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 ANCHOR_RELAY_DB=/data/relay.sqlite3
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt && useradd --create-home --uid 10001 anchor
COPY anchor_relay ./anchor_relay
RUN mkdir -p /data && chown -R anchor:anchor /app /data
USER anchor
EXPOSE 8080
CMD ["uvicorn", "anchor_relay.app:app", "--host", "0.0.0.0", "--port", "8080"]
