# AEON Delight — Secret Management (Node/Express)
FROM node:20-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    TZ=Asia/Hong_Kong

COPY package.json package-lock.json* ./
RUN npm install --omit=dev && npm cache clean --force

COPY server.js ./
COPY lib ./lib
COPY partials ./partials
COPY public ./public
COPY scripts ./scripts

USER node
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "require('http').get('http://127.0.0.1:8080/api/health',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["node", "server.js"]
