import {
  Body,
  Controller,
  Get,
  Headers,
  Inject,
  Patch,
  Put,
  UnauthorizedException,
  UseGuards,
} from "@nestjs/common";
import { timingSafeEqual } from "node:crypto";

import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AuthUser } from "../auth/auth.service.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { SETTINGS, type Settings } from "../config/settings.js";
import {
  autoApproveRulesUpdateSchema,
  llmSettingsUpdateSchema,
  type ActiveModelResponse,
  type AutoApproveRulesResponse,
  type AutoApproveRulesUpdate,
  type AvailableModelsResponse,
  type LLMSettings,
  type LLMSettingsUpdate,
} from "./settings.schemas.js";
import { SettingsService } from "./settings.service.js";

function secretsMatch(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

@Controller("settings")
export class SettingsController {
  constructor(
    private readonly settingsService: SettingsService,
    @Inject(SETTINGS) private readonly settings: Settings,
  ) {}

  private requireSecret(provided: string | undefined): void {
    if (
      !this.settings.WEBHOOK_SECRET ||
      provided === undefined ||
      !secretsMatch(provided, this.settings.WEBHOOK_SECRET)
    ) {
      throw new UnauthorizedException("Bad secret");
    }
  }

  @Get("llm")
  @UseGuards(AuthGuard)
  async getLlmSettings(): Promise<LLMSettings> {
    return { model: await this.settingsService.getActiveModel() };
  }

  @Patch("llm")
  @UseGuards(AuthGuard)
  async updateLlmSettings(
    @Body(new ZodValidationPipe(llmSettingsUpdateSchema)) body: LLMSettingsUpdate,
  ): Promise<LLMSettings> {
    return { model: await this.settingsService.setActiveModel(body.model) };
  }

  @Get("answer-llm")
  @UseGuards(AuthGuard)
  async getAnswerLlmSettings(): Promise<LLMSettings> {
    return { model: await this.settingsService.getActiveAnswerModel() };
  }

  @Patch("answer-llm")
  @UseGuards(AuthGuard)
  async updateAnswerLlmSettings(
    @Body(new ZodValidationPipe(llmSettingsUpdateSchema)) body: LLMSettingsUpdate,
  ): Promise<LLMSettings> {
    return { model: await this.settingsService.setActiveAnswerModel(body.model) };
  }

  @Get("available-models")
  @UseGuards(AuthGuard)
  async getAvailableModels(): Promise<AvailableModelsResponse> {
    return { models: await this.settingsService.listAvailableModels() };
  }

  @Get("active-llm-model")
  async getActiveLlmModelInternal(
    @Headers("x-aktenraum-secret") secret?: string,
  ): Promise<ActiveModelResponse> {
    this.requireSecret(secret);
    return { ollama_model: await this.settingsService.getActiveModel() };
  }

  @Get("auto-approve")
  @UseGuards(AuthGuard)
  async getAutoApproveRules(): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.listRules() };
  }

  @Put("auto-approve")
  @UseGuards(AuthGuard)
  async updateAutoApproveRules(
    @Body(new ZodValidationPipe(autoApproveRulesUpdateSchema)) body: AutoApproveRulesUpdate,
    @CurrentUser() user: AuthUser,
  ): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.replaceRules(body, user.username) };
  }

  @Get("active-auto-approve-rules")
  async getActiveAutoApproveRulesInternal(
    @Headers("x-aktenraum-secret") secret?: string,
  ): Promise<AutoApproveRulesResponse> {
    this.requireSecret(secret);
    return { rules: await this.settingsService.listRules() };
  }
}
