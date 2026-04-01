FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
# Pre-warm numba JIT compilation so it's baked into the image layer.
# This avoids the 20-40s cold JIT penalty on first real request.
RUN python -c "import umap; import numpy as np; umap.UMAP(n_neighbors=5).fit_transform(np.random.rand(20, 50))"
COPY app.py .
EXPOSE 8080
CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8080"]
