FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

COPY src/ ./src/

# Build metadata is baked in so the running container can report which commit it came from.
ARG IMAGE_TAG=dev
ARG GIT_SHA=unknown
ARG GIT_REF=unknown
ENV IMAGE_TAG=$IMAGE_TAG \
    GIT_SHA=$GIT_SHA \
    GIT_REF=$GIT_REF

USER node
EXPOSE 3000

HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "src/server.js"]
