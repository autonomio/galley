FROM node:24-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build:demo

FROM node:24-bookworm-slim
WORKDIR /app
COPY --from=build --chown=node:node /app /app
ENV GALLEY_DIR=/data/documents PORT=5174
RUN install -d -o node -g node /data/documents
USER node
VOLUME ["/data"]
EXPOSE 5174
CMD ["node", "node_modules/vite/bin/vite.js", "preview", "--host", "0.0.0.0"]
