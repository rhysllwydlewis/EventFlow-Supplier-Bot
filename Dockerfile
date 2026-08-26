FROM node:22-bookworm

WORKDIR /app

ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

COPY package.json ./
RUN npm install
RUN npx playwright install --with-deps chromium \
    && chmod -R a+rX /ms-playwright

COPY . .
RUN npm run build
RUN npm prune --omit=dev \
    && chown -R node:node /app

ENV NODE_ENV=production

USER node

CMD ["npm", "run", "start:control"]
