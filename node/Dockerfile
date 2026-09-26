# Trail Blazer relay (protocol v1), Node version.
# Build:  docker build -t trailblazer-relay .
# Run:    docker run -d -p 8080:8080 -e RELAY_TOKEN=<your token> trailblazer-relay
# The container speaks plain ws:// on port 8080. Put HTTPS in front of it
# (see docker-compose.yml and Caddyfile): the app only connects to wss://.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production PORT=8080
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY relay.js ./
USER node
EXPOSE 8080
CMD ["node", "relay.js"]
