import { logger } from "@aktenraum/core";
import {
  Body,
  Controller,
  ForbiddenException,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { AuthGuard } from "../auth/auth.guard.js";
import {
  CurrentPrincipal,
  RequireScope,
  type MemberPrincipal,
  type Principal,
} from "../auth/principal.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  answerRequestSchema,
  askRequestSchema,
  searchFilterSchema,
  type AnswerRequest,
  type AskRequest,
  type AskResponse,
} from "./ai.schemas.js";
import {
  AiService,
  ANSWER_LLM_FAILED_DE,
  extractInlineCitations,
  groupChunksByDoc,
  isDegenerateAnswer,
  isDenialAnswer,
  NO_MATCH_DE,
  resolveCitations,
} from "./ai.service.js";
import { buildStreamingAnswerMessages } from "./answer-prompt.js";
import { explainFilter } from "./explain.js";
import { explainParsed } from "./question-parser.js";
import { LlmBackendProvider } from "./llm-backend.provider.js";
import { buildMessages } from "./prompt.js";

/** Per-stage milliseconds of one Ask request (D7). Never holds the question text. */
class AskTiming {
  candidates = 0;
  private readonly start = performance.now();
  private readonly marks: Record<string, number> = {};

  mark(stage: string): void {
    this.marks[stage] = Math.round(performance.now() - this.start);
  }

  log(rerankerUsed: boolean): void {
    logger.info("ask_timing", {
      ...this.marks,
      total_ms: Math.round(performance.now() - this.start),
      candidates: this.candidates,
      reranker_used: rerankerUsed,
    });
  }
}

function sse(response: Response, event: string, payload: unknown): void {
  response.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}

@Controller("ai")
@UseGuards(AuthGuard)
export class AiController {
  constructor(
    private readonly aiService: AiService,
    private readonly llmBackends: LlmBackendProvider,
  ) {}

  @Post("find")
  @RequireScope("ai:ask")
  @HttpCode(HttpStatus.OK)
  async find(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(askRequestSchema)) body: AskRequest,
  ): Promise<AskResponse> {
    const llm = await this.llmBackends.build("filter");
    const searchFilter = await this.aiService.resolveFilter(principal, 
      body,
      llm,
      buildMessages,
      searchFilterSchema,
    );
    const [results, total] = await this.aiService.executeFilter(principal, searchFilter);
    return {
      filter: searchFilter,
      results,
      explanation: explainFilter(searchFilter),
      total,
    };
  }

  @Post("answer/stream")
  @RequireScope("ai:ask")
  async answerStream(
    @Body(new ZodValidationPipe(answerRequestSchema)) body: AnswerRequest,
    @CurrentPrincipal() principal: Principal,
    @Res() response: Response,
  ): Promise<void> {
    if (principal.kind !== "member") throw new ForbiddenException("Members only");
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    try {
      await this.streamAnswerEvents(body, principal, response);
    } catch (error: unknown) {
      logger.warn("ai_answer_stream_fatal", {
        error: error instanceof Error ? error.message : String(error),
      });
      sse(response, "error", { detail: "Antwort konnte nicht erzeugt werden." });
    } finally {
      response.end();
    }
  }

  /**
   * Retrieval first, one LLM call (fast-ask): parse (no LLM) → `meta` → semantic / full-text / structured in
   * parallel → batched candidate load → `sources` → streamed answer → `final`.
   */
  private async streamAnswerEvents(
    body: AnswerRequest,
    principal: MemberPrincipal,
    response: Response,
  ): Promise<void> {
    const timing = new AskTiming();
    try {
      await this.streamAnswerTimed(body, principal, response, timing);
    } finally {
      timing.log(this.aiService.rerankerEnabled());
    }
  }

  private async streamAnswerTimed(
    body: AnswerRequest,
    principal: MemberPrincipal,
    response: Response,
    timing: AskTiming,
  ): Promise<void> {
    const answerLlm = await this.llmBackends.build("answer");
    await this.aiService.expireSharesFor(principal);

    const parsed = await this.aiService.parseQuestionFor(principal, body.question);
    timing.mark("parse_ms");
    sse(response, "meta", {
      filter: this.aiService.parsedToFilter(parsed),
      explanation: explainParsed(parsed),
      total: null,
    });

    const [chunks, structured, fullText] = await Promise.all([
      this.aiService.retrieveChunks(body.question, principal),
      this.aiService.structuredSearch(principal, parsed),
      this.aiService.fullTextSearch(principal, parsed),
    ]);
    timing.mark("retrieve_ms");

    const loaded = await this.aiService.loadCandidates(principal, {
      chunks,
      structured: structured?.docs ?? [],
      fullText,
    });
    timing.mark("enrich_ms");
    timing.candidates = loaded.summaries.length;

    const total = structured?.total ?? loaded.summaries.length;
    sse(response, "sources", { sources: loaded.summaries, total });
    if (loaded.summaries.length === 0) {
      sse(response, "chunk", { text: NO_MATCH_DE });
      sse(response, "final", { answer_de: NO_MATCH_DE, citations: [], total: 0 });
      return;
    }

    const answerMessages = buildStreamingAnswerMessages(body.question, {
      candidates: loaded.candidates,
      chunksByDoc: groupChunksByDoc(chunks),
      totalMatches: total,
    });

    let streamed = "";
    try {
      for await (const delta of answerLlm.streamText(answerMessages)) {
        if (streamed === "") timing.mark("first_token_ms");
        streamed += delta;
        sse(response, "chunk", { text: delta });
      }
    } catch (error: unknown) {
      logger.warn("ai_answer_stream_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (streamed === "") {
        streamed = ANSWER_LLM_FAILED_DE;
        sse(response, "chunk", { text: streamed });
      }
    }

    let answerText = streamed.trim();
    if (isDegenerateAnswer(answerText)) {
      logger.warn("ai_answer_stream_degenerate", { text: answerText });
      streamed = ANSWER_LLM_FAILED_DE;
      answerText = streamed;
    }

    let citations = resolveCitations(extractInlineCitations(streamed), loaded.summaries);
    if (citations.length === 0 && !isDenialAnswer(answerText)) {
      citations = loaded.summaries;
    }

    await this.aiService.auditSharedCitations(principal, citations);
    sse(response, "final", { answer_de: answerText, citations, total });
  }
}
