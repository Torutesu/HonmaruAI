FROM node:22-alpine

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY index.js agentTools.js persistence.js ./

ENV PORT=8080
# Persist cards across restarts by mounting a volume at /app/data
ENV CARDS_STORE_PATH=/app/data/cards.json

EXPOSE 8080

CMD ["node", "index.js"]
