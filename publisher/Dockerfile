FROM node:latest

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src ./src

CMD ["node", "--experimental-strip-types", "src/index.ts"]
