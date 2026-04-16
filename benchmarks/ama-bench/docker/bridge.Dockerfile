FROM oven/bun:1-slim

WORKDIR /app

COPY package.json ./
COPY src/ ./src/

# Install @ekai/mindmap from npm (swap workspace ref)
RUN sed -i 's/"workspace:\*"/"latest"/' package.json && \
    bun install

EXPOSE 3456

CMD ["bun", "src/server.ts"]
