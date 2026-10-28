# EagleEye backend — serves both the API and the dashboard. Zero npm deps.
FROM node:24-alpine
WORKDIR /app
COPY server.js package.json ./
COPY public ./public
ENV PORT=4000
# For persistent data, mount a volume and set DB_PATH, e.g. -e DB_PATH=/data/eagleeye.db
EXPOSE 4000
CMD ["node", "server.js"]
