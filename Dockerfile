# WhatsApp Travel Bot Dockerfile (Baileys - lightweight)
FROM node:20-alpine

ENV NODE_ENV=production

WORKDIR /app

# Create persistent data directory
RUN mkdir -p /app/data && chmod 777 /app/data

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy source code
COPY src/ ./src/

EXPOSE 3000

CMD ["npm", "start"]
