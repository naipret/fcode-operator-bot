FROM node:24-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:24-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=builder /app/dist ./dist
COPY config.example.yaml ./config.yaml

RUN mkdir -p /app/data /app/logs && chown -R node:node /app
USER node

CMD ["node", "--env-file-if-exists=.env", "dist/index.js"]
