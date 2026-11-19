import { Body, Controller, Get, Patch, Put, UseGuards } from "@nestjs/common";

import { AuthGuard, CurrentUser } from "../auth/auth.guard.js";
import type { AuthUser } from "../auth/auth.service.js";
import { InternalGuard } from "../auth/internal.guard.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
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

@Controller("settings")
export class SettingsController {
  constructor(private readonly settingsService: SettingsService) {}

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
  @UseGuards(InternalGuard)
  async getActiveLlmModelInternal(): Promise<ActiveModelResponse> {
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
  @UseGuards(InternalGuard)
  async getActiveAutoApproveRulesInternal(): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.listRules() };
  }
}
