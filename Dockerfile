# Stylish Care App — runs as a Hugging Face Space (Docker SDK).
# Single Node process: Express serves the built React client + the API.
FROM node:20-slim

WORKDIR /app

# Copy everything (node_modules/.env/dist are excluded via .dockerignore),
# install server deps, then build the client (the build step installs the
# client's dev deps — vite — and outputs client/dist).
COPY . .
RUN npm install && npm run build

# HF Spaces route traffic to app_port (see README frontmatter). The server
# reads process.env.PORT.
ENV NODE_ENV=production
ENV PORT=7860
EXPOSE 7860

CMD ["npm", "start"]
