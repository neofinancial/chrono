FROM node:22-bookworm-slim AS build

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"

RUN corepack enable

WORKDIR /app
COPY . .

RUN pnpm install --frozen-lockfile
RUN pnpm --filter @neofinancial/chrono build \
  && pnpm --filter @neofinancial/chrono-mongo-datastore build \
  && pnpm --filter chrono-load-tester build

FROM mongo:8.0

COPY --from=build /usr/local /usr/local
COPY --from=build /app /app

WORKDIR /app
RUN chmod +x examples/chrono-load-tester/entrypoint.sh

ENTRYPOINT ["examples/chrono-load-tester/entrypoint.sh"]
