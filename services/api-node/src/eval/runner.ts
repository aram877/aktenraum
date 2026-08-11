import { LocalReranker, OllamaEmbedder, QdrantVectorStore } from "@aktenraum/core-ts";
import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";

import { loadSettings } from "../config/settings.js";
import { retrieveChunksForQuestion } from "../ai/retrieval.js";
import { aggregate, scoreCase, type EvalCase, type EvalReport } from "./metrics.js";

export function parseCases(raw: string): EvalCase[] {
  const cases: EvalCase[] = [];
  let current: Record<string, unknown> | null = null;
  const push = (): void => {
    if (current === null) return;
    cases.push({
      id: String(current.id ?? ""),
      question: String(current.question ?? ""),
      expected: (current.expected_doc_ids as number[] | undefined) ?? [],
      expectedInTopK: Number(current.expected_in_top_k ?? 5),
      category: (current.category as string | undefined) ?? null,
      language: String(current.language ?? "de"),
    });
    current = null;
  };
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (trimmed.startsWith("- ")) {
      push();
      current = {};
    }
    if (current === null) continue;
    const body = trimmed.startsWith("- ") ? trimmed.slice(2) : trimmed;
    const sep = body.indexOf(":");
    if (sep === -1) continue;
    const key = body.slice(0, sep).trim();
    let value = body.slice(sep + 1).trim();
    if (value.startsWith('"') && value.endsWith('"')) value = value.slice(1, -1);
    if (value.startsWith("[") && value.endsWith("]")) {
      current[key] = value
        .slice(1, -1)
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((n) => Number.isFinite(n));
      continue;
    }
    current[key] = value;
  }
  push();
  return cases.filter((c) => c.id !== "" && c.question !== "");
}

export function formatReport(report: EvalReport): string {
  const lines: string[] = [];
  for (const result of report.perCase) {
    const mark = result.hitAtK ? "HIT " : "MISS";
    const rank = result.rankOfFirstHit === null ? "—" : `rank ${result.rankOfFirstHit}`;
    lines.push(
      `  ${mark} ${result.caseId.padEnd(36)} ${rank.padEnd(9)} expected=${JSON.stringify(result.expected)} retrieved=${JSON.stringify(result.retrieved.slice(0, 5))}`,
    );
  }
  lines.push("");
  lines.push(`  cases      ${report.totalCases}`);
  lines.push(`  hits       ${report.hits}`);
  lines.push(`  misses     ${report.misses}`);
  lines.push(`  recall@K   ${report.recallAtK.toFixed(3)}`);
  lines.push(`  MRR        ${report.mrr.toFixed(3)}`);
  return lines.join("\n");
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const { values } = parseArgs({
    args: argv,
    options: {
      cases: { type: "string", default: "evals/golden-questions.yaml" },
      json: { type: "boolean", default: false },
    },
    allowPositionals: false,
  });

  const settings = loadSettings();
  if (!settings.QDRANT_URL) {
    process.stderr.write("QDRANT_URL is unset — RAG is disabled, nothing to evaluate.\n");
    return 1;
  }

  const cases = parseCases(readFileSync(values.cases as string, "utf8"));
  if (cases.length === 0) {
    process.stderr.write(`No cases found in ${String(values.cases)}.\n`);
    return 1;
  }

  const vectorStore = new QdrantVectorStore(settings.QDRANT_URL);
  const deps = {
    embedder: new OllamaEmbedder(settings.OLLAMA_BASE_URL, settings.EMBEDDING_MODEL),
    vectorStore,
    reranker: new LocalReranker(settings.RERANKER_MODEL),
  };

  const results = [];
  for (const evalCase of cases) {
    const chunks = await retrieveChunksForQuestion(evalCase.question, {
      deps,
      fetchTopK: settings.RAG_RETRIEVAL_TOP_K,
      rerankTopK: Math.max(settings.RAG_RERANK_TOP_K, evalCase.expectedInTopK),
    });
    const seen = new Set<number>();
    const docIds: number[] = [];
    for (const chunk of chunks) {
      if (seen.has(chunk.docId)) continue;
      seen.add(chunk.docId);
      docIds.push(chunk.docId);
    }
    results.push(scoreCase(evalCase, docIds));
  }

  const report = aggregate(results);
  if (values.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(`${formatReport(report)}\n`);
  }
  return 0;
}

const isEntrypoint =
  process.argv[1] !== undefined && process.argv[1].endsWith("eval/runner.js");
if (isEntrypoint) {
  main()
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exit(1);
    });
}
