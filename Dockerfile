FROM node:18-slim
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js schema.sql ./
EXPOSE 3001
CMD ["node", "server.js"]
