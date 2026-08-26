FROM mcr.microsoft.com/playwright:v1.62.1-noble

WORKDIR /app

COPY package.json ./
RUN npm install

COPY . .
RUN npm run build
RUN npm prune --omit=dev

ENV NODE_ENV=production

CMD ["npm", "run", "start:control"]
