# WhatsApp Travel Bot Dockerfile
# Optimized for Railway deployment with Puppeteer/Chromium

FROM node:20-bullseye-slim

# Set environment variables
ENV NODE_ENV=production
ENV PUPPETEER_SKIP_CHROMIUM_DOWNLOAD=true
ENV PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium

# Install Chromium and dependencies
RUN apt-get update && apt-get install -y \
    chromium \
    chromium-sandbox \
    fonts-ipafont-gothic \
    fonts-wqy-zenhei \
    fonts-thai-tlwg \
    fonts-kacst \
    fonts-freefont-ttf \
    fonts-liberation \
    libxss1 \
    --no-install-recommends \
    && rm -rf /var/lib/apt/lists/* \
    && rm -rf /var/cache/apt/*

# Create app directory
WORKDIR /app

# Create data directory for persistent storage
RUN mkdir -p /app/data && chmod 777 /app/data

# Copy package files
COPY package*.json ./

# Install production dependencies only
RUN npm ci --omit=dev && npm cache clean --force

# Copy application source
COPY src/ ./src/

# Create non-root user for security
RUN groupadd -r botuser && useradd -r -g botuser botuser \
    && chown -R botuser:botuser /app

# Switch to non-root user
USER botuser

# Expose port for health endpoint
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=60s --retries=3 \
    CMD node -e "require('http').get('http://localhost:3000/health', (r) => process.exit(r.statusCode === 200 ? 0 : 1))"

# Start the bot
CMD ["npm", "start"]
