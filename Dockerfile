FROM node:22-slim
WORKDIR /app
COPY container/package*.json ./
RUN npm install --production
COPY container/src/ ./src/
COPY relay-lib/ ./relay-lib/
EXPOSE 8080
CMD ["node", "src/server.js"]
