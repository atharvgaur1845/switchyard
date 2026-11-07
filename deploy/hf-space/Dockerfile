# Switchyard's offline demo as a Hugging Face Space (Docker SDK).
# It builds from the public GitHub repo, so this folder is the whole Space:
# copy this Dockerfile and README.md into a new Space and push.
FROM node:24-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends git ca-certificates \
 && rm -rf /var/lib/apt/lists/*

# Spaces run the container as user 1000, which is "node" in this image.
USER node
WORKDIR /home/node

# The branch or tag to build. A new commit is picked up by a factory rebuild.
ARG REF=main
RUN git clone --depth 1 --branch "${REF}" https://github.com/atharvgaur1845/switchyard app

WORKDIR /home/node/app
RUN npm ci --omit=dev --no-audit --no-fund

ENV PORT=7860 NO_COLOR=1
EXPOSE 7860

# The real engine, flows and checks, with fixture agents, scripted clicks and
# a sandbox bank in this process. --public opens the console to visitors and
# makes it read-only; its proofs are signed with a key made at each start.
CMD ["node", "--disable-warning=ExperimentalWarning", "src/cli.ts", "demo", "offline", "--serve", "--public"]
