FROM node:24-alpine AS build

WORKDIR /app
COPY arca-app/package.json arca-app/package-lock.json ./
RUN npm ci --ignore-scripts
COPY arca-app ./

ARG VITE_API_URL=/api
ENV VITE_API_URL=$VITE_API_URL
RUN npm run build

FROM caddy:2-alpine
COPY deploy/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80 443

