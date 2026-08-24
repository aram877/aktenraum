export interface EvalCase {
  id: string;
  question: string;
  expected: readonly number[];
  expectedInTopK: number;
  category?: string | null;
  language: string;
}

export interface EvalResult {
  caseId: string;
  question: string;
  expected: readonly number[];
  retrieved: readonly number[];
  hitAtK: boolean;
  reciprocalRank: number;
  rankOfFirstHit: number | null;
}

export interface EvalReport {
  totalCases: number;
  hits: number;
  misses: number;
  recallAtK: number;
  mrr: number;
  perCase: readonly EvalResult[];
}

export function scoreCase(evalCase: EvalCase, retrievedDocIds: readonly number[]): EvalResult {
  const expected = new Set(evalCase.expected);
  let rankOfFirstHit: number | null = null;
  for (let i = 0; i < retrievedDocIds.length; i += 1) {
    if (expected.has(retrievedDocIds[i] as number)) {
      rankOfFirstHit = i + 1;
      break;
    }
  }
  return {
    caseId: evalCase.id,
    question: evalCase.question,
    expected: evalCase.expected,
    retrieved: retrievedDocIds,
    hitAtK: rankOfFirstHit !== null && rankOfFirstHit <= evalCase.expectedInTopK,
    reciprocalRank: rankOfFirstHit !== null ? 1 / rankOfFirstHit : 0,
    rankOfFirstHit,
  };
}

export function aggregate(results: readonly EvalResult[]): EvalReport {
  const totalCases = results.length;
  if (totalCases === 0) {
    return { totalCases: 0, hits: 0, misses: 0, recallAtK: 0, mrr: 0, perCase: [] };
  }
  const hits = results.filter((r) => r.hitAtK).length;
  return {
    totalCases,
    hits,
    misses: totalCases - hits,
    recallAtK: hits / totalCases,
    mrr: results.reduce((sum, r) => sum + r.reciprocalRank, 0) / totalCases,
    perCase: results,
  };
}
