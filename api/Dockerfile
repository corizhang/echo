FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY package-lock.json ./
COPY node_modules ./node_modules
COPY server.js ./server.js
EXPOSE 3000
CMD ["node", "server.js"]
