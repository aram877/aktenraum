import { DEFAULT_COLLECTION, QdrantVectorStore } from "@aktenraum/core";

const url = process.env.QDRANT_URL;
if (!url) {
  process.stderr.write(
    "QDRANT_URL is not set in the container — RAG is disabled; nothing to re-embed.\n",
  );
  process.exit(1);
}

const dropped = await new QdrantVectorStore(url, { apiKey: process.env.QDRANT_API_KEY }).dropCollection();
process.stdout.write(
  dropped
    ? `Dropped Qdrant collection '${DEFAULT_COLLECTION}'.\n`
    : `Collection '${DEFAULT_COLLECTION}' did not exist — nothing to drop.\n`,
);
