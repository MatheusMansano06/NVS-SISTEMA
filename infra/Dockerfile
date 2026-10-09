FROM python:3.12-slim
WORKDIR /app
COPY backend ./backend
COPY banco ./banco
RUN pip install --no-cache-dir ./backend && useradd -m nvs
USER nvs
CMD ["sh", "-c", "alembic -c banco/alembic.ini upgrade head && uvicorn app.main:app --host 0.0.0.0 --port ${PORT:-8000} --proxy-headers --forwarded-allow-ips='*'"]
