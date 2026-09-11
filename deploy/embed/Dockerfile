FROM python:3.11-slim
RUN pip install --no-cache-dir "fastapi==0.115.*" "uvicorn[standard]==0.34.*" "fastembed==0.5.1"
WORKDIR /app
COPY app.py .
EXPOSE 8088
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8088"]
