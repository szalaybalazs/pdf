# Remote index server image. Build from the PROJECT ROOT so the pdf_qa package
# (whose store.py the server reuses) is in the build context:
#     docker build -f index_server/Dockerfile -t pdf-qa-index .
FROM python:3.12-slim

WORKDIR /app

# Install deps first for layer caching.
COPY index_server/requirements.txt ./requirements.txt
RUN pip install --no-cache-dir -r requirements.txt

# The server code and the shared store implementation. Only pdf_qa/store.py is
# imported at runtime; the rest of the package is inert (never imported) but
# copied so the package resolves cleanly.
COPY index_server/server.py ./server.py
COPY pdf_qa/ ./pdf_qa/

# Library indexes persist here — mount a volume so data survives restarts.
ENV INDEX_SERVER_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8000

# INDEX_SERVER_SECRET is unset by default => open server. Set it to require auth.
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]
