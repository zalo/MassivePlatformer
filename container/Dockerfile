FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
# v3: diagnostic healthcheck
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "src/server.js"]
