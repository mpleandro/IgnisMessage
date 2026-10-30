FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data && chown node:node /app/data
ENV NODE_ENV=production DATA_DIR=/app/data
VOLUME /app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
