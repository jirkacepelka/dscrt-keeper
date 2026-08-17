# The keeper, as a long-running container.
#
# No build step: the source is TypeScript run directly through Node's type stripping, and
# the console is hand-written HTML, CSS and one ES module. What runs is what you can read in
# `src/` and `web/`. That matters more here than a few megabytes — anyone can check the thing
# holding a hot key against the repository without trusting a compiler or a bundler.
FROM node:22-alpine

# `su-exec` is the whole reason this image starts as root. See the entrypoint: ZimaOS creates
# `/DATA/AppData/<app>` owned by root, so a container that ran as `node` from the first
# instruction would find its own volume unwritable and silently keep no history at all.
RUN apk add --no-cache su-exec

WORKDIR /keeper

# `npm ci` against a committed lockfile, not `npm install`. This container holds a signing
# key, so the dependency tree it runs should be the one that was reviewed rather than
# whatever the registry resolved on the day somebody happened to rebuild the image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY web ./web
COPY tsconfig.json ./tsconfig.json
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
# Set here rather than relied on from git, which does not carry the bit on every platform.
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

ENV KEEPER_DATA_DIR=/data \
    KEEPER_PORT=8787 \
    KEEPER_BIND=0.0.0.0

# The one writable path. Everything else can be mounted read-only.
VOLUME /data
EXPOSE 8787

# Ask the console, rather than starting a second keeper.
#
# This used to run `--check-only`, which spawned a whole Node process every ten minutes to
# re-query the chain. `/healthz` reports the verdict of the last pass the running process
# already made, so the probe is a socket connection and the answer is never more than the
# loop interval old. `--check-only` still exists and still works; it is just not the right
# tool for a probe that fires on a schedule.
HEALTHCHECK --interval=2m --timeout=10s --start-period=45s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.KEEPER_PORT||8787)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--experimental-strip-types", "src/index.ts"]
