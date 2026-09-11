"""Эмбеддер: текст -> вектор. Живёт РЯДОМ с Evi на том же Ampere, своим
контейнером, своим томом и своим портом -- Evi он не касается.

Наружу не смотрит: порт привязан к 127.0.0.1, ходить сюда можно только через
туннель, и только с токеном. Вектор -- это смысл фразы сотрудника, он не
публичный.
"""
import os
import threading
import time

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel
from fastembed import TextEmbedding

# По умолчанию -- MiniLM: 384 измерения, 14 мс на фразу на двух ядрах Ampere,
# русский держит. multilingual-e5-small и LaBSE в реестре fastembed 0.5.1
# ОТСУТСТВУЮТ (проверено на самой машине), поэтому когда понадобится узбекский,
# менять надо на intfloat/multilingual-e5-large -- он есть, но весит 2.24 ГБ и
# считает втрое медленнее.
MODEL = os.environ.get("EMBED_MODEL", "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2")
TOKEN = os.environ.get("EMBED_TOKEN", "")
# e5 обучена с префиксами; для коротких фраз обе стороны кладём как query.
PREFIX = os.environ.get("EMBED_PREFIX", "query: " if "e5" in MODEL.lower() else "")

app = FastAPI()
_model: TextEmbedding | None = None


def model() -> TextEmbedding:
    """Ленивая загрузка: контейнер стартует мгновенно, вес тянется на первый запрос."""
    global _model
    if _model is None:
        _model = TextEmbedding(model_name=MODEL, cache_dir="/data")
    return _model


@app.on_event("startup")
def warmup() -> None:
    """Вес тянется в фоне: холодная загрузка -- 45 секунд, и первый живой
    запрос не должен её ждать. Контейнер при этом стартует сразу."""
    threading.Thread(target=lambda: model().embed(["прогрев"]).__next__(), daemon=True).start()


class In(BaseModel):
    texts: list[str]


@app.get("/health")
def health() -> dict:
    return {"ok": True, "model": MODEL, "loaded": _model is not None}


@app.post("/embed")
def embed(body: In, authorization: str = Header(default="")) -> dict:
    if TOKEN and authorization != f"Bearer {TOKEN}":
        raise HTTPException(status_code=401, detail="no")
    if not body.texts or len(body.texts) > 64:
        raise HTTPException(status_code=400, detail="1..64 texts")
    started = time.perf_counter()
    vectors = [v.tolist() for v in model().embed([PREFIX + t for t in body.texts])]
    return {
        "model": MODEL,
        "dim": len(vectors[0]),
        "ms": round((time.perf_counter() - started) * 1000, 1),
        "vectors": vectors,
    }
