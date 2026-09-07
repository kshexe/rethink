# Declared before the first FROM so it's in scope for both stages' FROM lines below - an ARG
# declared later (e.g. right before the second FROM) is not recognized the same way.
ARG BUILD_FROM

# Build stage: compile TypeScript. A plain node image is used here (not the HA base) since it's
# never shipped - only dist/ and node_modules/ are copied out of it below.
FROM node:20-alpine AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build && npm prune --omit=dev

# Runtime stage: the Home Assistant add-on base (Alpine + bashio + s6-overlay).
FROM $BUILD_FROM
WORKDIR /app

RUN apk add --no-cache nodejs openssl

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist

COPY rootfs /

RUN chmod +x /etc/cont-init.d/*.sh /etc/services.d/rethink/run
