FROM node:24-bookworm-slim

WORKDIR /app/arca-api
COPY arca-api/package.json arca-api/package-lock.json ./
RUN npm ci --ignore-scripts

COPY arca-api/src ./src
COPY arca-api/tsconfig.json ./

# El servicio `mantenimiento` de compose.production.yml reutiliza esta misma
# imagen con otro comando: necesita node y node:sqlite, que ya están acá.
COPY deploy/scripts/mantenimiento.mjs ./mantenimiento.mjs

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start"]

