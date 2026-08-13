FROM node:24-bookworm-slim

WORKDIR /app/arca-api
COPY arca-api/package.json arca-api/package-lock.json ./
RUN npm ci --ignore-scripts

COPY arca-api/src ./src
COPY arca-api/tsconfig.json ./

ENV NODE_ENV=production
EXPOSE 3001
CMD ["npm", "run", "start"]

