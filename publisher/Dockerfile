FROM node:latest

ENV NODE_ENV=production
WORKDIR /app

COPY package.json ./
COPY src ./src

CMD ["node", "--experimental-strip-types", "src/index.ts"]
