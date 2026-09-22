# --- frontend build stage ---
FROM node:20-alpine AS frontend
WORKDIR /build/frontend
COPY frontend/package.json ./
RUN npm install
COPY frontend/ ./
RUN npm run build

# --- backend runtime stage ---
FROM python:3.12-slim
WORKDIR /app

COPY backend/requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY backend/ ./
# pre-built bundle (app.js) lands in backend/static via esbuild output
COPY --from=frontend /build/backend/static/app.js ./static/app.js

ENV DATA_DIR=/data \
    DB_PATH=/data/seismic_review.db \
    PYTHONUNBUFFERED=1

VOLUME ["/data"]
EXPOSE 8000

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
