FROM node:22-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --production
COPY src/ ./src/
EXPOSE 8080
CMD ["node", "src/server.js"]
