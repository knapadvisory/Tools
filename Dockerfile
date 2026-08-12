# Hub page + tool downloads + hosted Marketplace Fee Register parser,
# served by a small Node/Express app on :80.
# Built and run on the TeamHub VPS by deploy/tools-setup.sh.
FROM node:22-slim

# python3 runs the fee parser (parser/amazon_invoice_parser.py),
# which needs pdfplumber + openpyxl — same recipe TeamHub's image uses.
RUN apt-get update && apt-get install -y --no-install-recommends python3 python3-pip \
    && pip3 install --no-cache-dir --break-system-packages pdfplumber openpyxl \
    && apt-get clean && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY server.js ./
COPY parser/ ./parser/
COPY index.html gate.html session.js ./
COPY fee-parser/ ./fee-parser/
COPY downloads/ ./downloads/

ENV PORT=80
EXPOSE 80
CMD ["node", "server.js"]
