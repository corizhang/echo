FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
RUN npm ci --omit=dev
COPY server.js ./server.js
COPY game-relay.js ./game-relay.js
COPY migrations ./migrations
EXPOSE 3000
CMD ["node", "server.js"]
