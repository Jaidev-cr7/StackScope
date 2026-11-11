# The frontend image.
#
# The built bundle is served by nginx, which also proxies /api to the backend.
# That is what makes the application one origin: the session cookie is
# first-party, so `credentials: 'include'` behaves in production exactly as
# it does behind the Vite dev server.

FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
RUN npm --prefix frontend run build

FROM nginx:1.27-alpine AS runtime

COPY --from=build /app/frontend/dist /usr/share/nginx/html
COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --quiet --tries=1 --spider http://127.0.0.1/ || exit 1

CMD ["nginx", "-g", "daemon off;"]
