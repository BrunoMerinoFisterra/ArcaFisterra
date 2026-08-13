FROM node:24-bookworm-slim

WORKDIR /app
COPY arca-api/package.json arca-api/package-lock.json ./arca-api/
COPY arca-worker/package.json arca-worker/package-lock.json ./arca-worker/

RUN cd arca-api && npm ci --ignore-scripts \
    && cd ../arca-worker && npm ci --ignore-scripts \
    && npx playwright install --with-deps chromium

COPY arca-api/src ./arca-api/src
COPY arca-api/tsconfig.json ./arca-api/
COPY arca-worker/src ./arca-worker/src
COPY arca-worker/tsconfig.json ./arca-worker/

WORKDIR /app/arca-worker
ENV NODE_ENV=production
CMD ["npm", "run", "start"]

