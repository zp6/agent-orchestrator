FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* tsconfig.json ./
COPY src ./src
RUN npm install --no-audit --no-fund && npm run build

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/package.json ./
COPY --from=build /app/dist ./dist
RUN npm install --omit=dev --no-audit --no-fund

# Encrypted key envelope is bind-mounted read-only at runtime.
# Audit log is bind-mounted read-write so it survives container restarts.
VOLUME ["/keystore", "/audit"]
ENV FLEET_SIGNER_KEY_PATH=/keystore/key.enc
ENV FLEET_SIGNER_AUDIT_PATH=/audit/audit.log
ENV FLEET_SIGNER_BIND_HOST=0.0.0.0
ENV FLEET_SIGNER_PORT=7521

EXPOSE 7521
USER node
CMD ["node", "dist/cli.js", "start"]
