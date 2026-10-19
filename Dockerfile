# Kaiva Postgres MCP as a container, for the Docker MCP Catalog and Docker's MCP Toolkit.
# The server speaks MCP over stdio; the database URL arrives as DATABASE_URL.
FROM node:22-alpine
WORKDIR /app
COPY package.json npm-shrinkwrap.json LICENSE README.md ./
COPY bin ./bin
COPY lib ./lib
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force
USER node
ENTRYPOINT ["node", "/app/bin/kaiva-postgres-mcp.js"]
