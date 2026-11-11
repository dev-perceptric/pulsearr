# The PulseARR app (app.pulsearr.com): build Next.js, then serve it on port 3000.
# At runtime it only needs the build (.next), public/, next.config.ts and the packages. Nothing reads src/, worker/,
# docs/ or supabase/ at runtime. The worker has its own image (Dockerfile.worker).
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
# Read at build time. Empty means PostHog is off. build-images.yml passes the repo variable NEXT_PUBLIC_POSTHOG_KEY.
ARG NEXT_PUBLIC_POSTHOG_KEY=""
ENV NEXT_PUBLIC_POSTHOG_KEY=$NEXT_PUBLIC_POSTHOG_KEY
# The commit this image is built from. next.config.ts turns it into NEXT_PUBLIC_BUILD for /api/version.
ARG GIT_SHA=""
ENV GIT_SHA=$GIT_SHA
# public/ is optional in the repo; make sure it exists so the copy below never fails.
RUN mkdir -p public && npm run build

FROM node:22-bookworm-slim
ARG GIT_SHA=""
ENV NODE_ENV=production PORT=3000 NEXT_TELEMETRY_DISABLED=1 GIT_SHA=$GIT_SHA
WORKDIR /app
RUN useradd --create-home web
COPY --from=build /app/package.json /app/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && rm -rf /root/.npm
# The app writes only to .next (its image cache), so only .next belongs to the web user.
# This skips a chown of node_modules, which would copy it into a second layer and double the image.
COPY --from=build --chown=web /app/.next ./.next
COPY --from=build /app/public ./public
COPY --from=build /app/next.config.ts ./
USER web
EXPOSE 3000
CMD ["npx", "next", "start", "-p", "3000"]
