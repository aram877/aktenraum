import { logger } from "@aktenraum/core";
import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import { AuthGuard } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import {
  answerOutputSchema,
  answerRequestSchema,
  askRequestSchema,
  searchFilterSchema,
  type AnswerRequest,
  type AnswerResponse,
  type AskRequest,
  type AskResponse,
  type SearchFilter,
} from "./ai.schemas.js";
import {
  AiService,
  ANSWER_CONTEXT_SIZE,
  ANSWER_LLM_FAILED_DE,
  broadenForAnswer,
  extractInlineCitations,
  groupChunksByDoc,
  isDegenerateAnswer,
  isDenialAnswer,
  NO_MATCH_DE,
  resolveCitations,
} from "./ai.service.js";
import { buildAnswerMessages, buildStreamingAnswerMessages } from "./answer-prompt.js";
import { explainFilter } from "./explain.js";
import { LlmBackendProvider } from "./llm-backend.provider.js";
import { buildMessages } from "./prompt.js";

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
  @HttpCode(HttpStatus.OK)
  async find(
    @Body(new ZodValidationPipe(askRequestSchema)) body: AskRequest,
  ): Promise<AskResponse> {
    const llm = await this.llmBackends.build("filter");
    const searchFilter = await this.aiService.resolveFilter(
      body,
      llm,
      buildMessages,
      searchFilterSchema,
    );
    const [results, total] = await this.aiService.executeFilter(searchFilter);
    return {
      filter: searchFilter,
      results,
      explanation: explainFilter(searchFilter),
      total,
    };
  }

  @Post("answer/stream")
  async answerStream(
    @Body(new ZodValidationPipe(answerRequestSchema)) body: AnswerRequest,
    @Res() response: Response,
  ): Promise<void> {
    response.setHeader("Content-Type", "text/event-stream");
    response.setHeader("Cache-Control", "no-cache");
    response.setHeader("X-Accel-Buffering", "no");
    response.flushHeaders();

    try {
      await this.streamAnswerEvents(body, response);
    } catch (error: unknown) {
      logger.warn("ai_answer_stream_fatal", {
        error: error instanceof Error ? error.message : String(error),
      });
      sse(response, "error", { detail: "Antwort konnte nicht erzeugt werden." });
    } finally {
      response.end();
    }
  }

  private async streamAnswerEvents(body: AnswerRequest, response: Response): Promise<void> {
    const llm = await this.llmBackends.build("filter");
    const answerLlm = await this.llmBackends.build("answer");

    let searchFilter: SearchFilter;
    try {
      const context = await this.aiService.promptContext();
      const messages = buildMessages(body.question, context);
      searchFilter = (await llm.complete(messages, searchFilterSchema)) as SearchFilter;
    } catch (error: unknown) {
      logger.warn("ai_filter_validation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      sse(response, "error", { detail: "Filter konnte nicht extrahiert werden." });
      return;
    }

    const retrievalFilter = broadenForAnswer(searchFilter);
    const [results, total] = await this.aiService.executeFilter(retrievalFilter);

    sse(response, "meta", {
      filter: searchFilter,
      explanation: explainFilter(searchFilter),
      total,
    });

    const ragChunks = await this.aiService.retrieveChunks(body.question, searchFilter);
    if (results.length === 0 && ragChunks.length === 0) {
      sse(response, "chunk", { text: NO_MATCH_DE });
      sse(response, "final", { answer_de: NO_MATCH_DE, citations: [], total: 0 });
      return;
    }

    const promptResults = await this.aiService.promotePromptResults(results, ragChunks);
    const candidates = await this.aiService.enrichWithAiFields(promptResults);
    const chunksByDoc = groupChunksByDoc(ragChunks);
    const answerMessages = buildStreamingAnswerMessages(body.question, {
      candidates,
      chunksByDoc,
      totalMatches: total,
    });

    let fullText = "";
    try {
      for await (const delta of answerLlm.streamText(answerMessages)) {
        fullText += delta;
        sse(response, "chunk", { text: delta });
      }
    } catch (error: unknown) {
      logger.warn("ai_answer_stream_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      if (fullText === "") {
        fullText = ANSWER_LLM_FAILED_DE;
        sse(response, "chunk", { text: fullText });
      }
    }

    let answerText = fullText.trim();
    if (isDegenerateAnswer(answerText)) {
      logger.warn("ai_answer_stream_degenerate", { text: answerText });
      fullText = ANSWER_LLM_FAILED_DE;
      answerText = fullText;
    }

    const citedIds = extractInlineCitations(fullText);
    let citations = resolveCitations(citedIds, promptResults);
    if (citations.length === 0 && !isDenialAnswer(answerText)) {
      citations = promptResults;
    }

    sse(response, "final", { answer_de: answerText, citations, total });
  }

  @Post("answer")
  @HttpCode(HttpStatus.OK)
  async answer(
    @Body(new ZodValidationPipe(answerRequestSchema)) body: AnswerRequest,
  ): Promise<AnswerResponse> {
    const llm = await this.llmBackends.build("filter");
    const context = await this.aiService.promptContext();
    const searchFilter = (await llm.complete(
      buildMessages(body.question, context),
      searchFilterSchema,
    )) as SearchFilter;

    const retrievalFilter = broadenForAnswer(searchFilter);
    const [results, total] = await this.aiService.executeFilter(retrievalFilter);
    if (results.length === 0) {
      return {
        question: body.question,
        answer_de: NO_MATCH_DE,
        citations: [],
        filter: searchFilter,
        total: 0,
      };
    }

    const candidates = await this.aiService.enrichWithAiFields(
      results.slice(0, ANSWER_CONTEXT_SIZE),
    );
    const answerLlm = await this.llmBackends.build("answer");

    let answerDe: string;
    let citedIds: number[];
    try {
      const output = await answerLlm.complete(
        buildAnswerMessages(body.question, { candidates }),
        answerOutputSchema,
      );
      answerDe = output.answer_de;
      citedIds = output.cited_ids ?? [];
    } catch (error: unknown) {
      logger.warn("ai_answer_validation_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      return {
        question: body.question,
        answer_de: ANSWER_LLM_FAILED_DE,
        citations: results.slice(0, ANSWER_CONTEXT_SIZE),
        filter: searchFilter,
        total,
      };
    }

    const answerText = answerDe.trim();
    if (isDegenerateAnswer(answerText)) {
      logger.warn("ai_answer_degenerate", { answer_de: answerText, cited_ids: citedIds });
      return {
        question: body.question,
        answer_de: ANSWER_LLM_FAILED_DE,
        citations: results.slice(0, ANSWER_CONTEXT_SIZE),
        filter: searchFilter,
        total,
      };
    }

    let citations = resolveCitations(citedIds, results);
    if (citations.length === 0 && !isDenialAnswer(answerText)) {
      citations = results.slice(0, ANSWER_CONTEXT_SIZE);
    }

    return {
      question: body.question,
      answer_de: answerText || NO_MATCH_DE,
      citations,
      filter: searchFilter,
      total,
    };
  }
}
