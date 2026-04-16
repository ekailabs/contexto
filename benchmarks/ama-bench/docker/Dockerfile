FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    git curl && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Clone AMA-Bench fork (contexto_method.py and configs already in repo)
ARG AMA_BENCH_REPO=https://github.com/ekailabs/AMA-Bench.git
RUN git clone ${AMA_BENCH_REPO} /app/AMA-Bench

# Install Python dependencies
RUN pip install --no-cache-dir -r /app/AMA-Bench/requirements.txt

# Download dataset
RUN pip install --no-cache-dir huggingface_hub && \
    huggingface-cli download AMA-bench/AMA-bench --repo-type dataset --local-dir /app/AMA-Bench/dataset

WORKDIR /app/AMA-Bench

ENTRYPOINT ["python", "src/run.py"]
