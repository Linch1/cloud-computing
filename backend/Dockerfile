# Production image per il backend Fastify.
# Pensata per essere pushata su ECR e servita da ECS Express Mode.

FROM node:20-alpine

# Populated at `docker build` time — compare with CloudWatch on every deploy.
ARG GIT_SHA=unknown
ARG BUILD_TIME=unknown
ENV GIT_SHA=$GIT_SHA \
    BUILD_TIME=$BUILD_TIME

WORKDIR /app

# Solo dipendenze di runtime (niente devDependencies)
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Sorgenti
COPY src ./src

ENV NODE_ENV=production \
    PORT=3001 \
    HOST=0.0.0.0

EXPOSE 3001

# Esegui come utente non-root (l'immagine node:alpine include l'utente "node")
USER node

CMD ["node", "src/server.js"]
