import { Body, Controller, Get, Patch, Put, UseGuards } from "@nestjs/common";

import { AuthGuard } from "../auth/auth.guard.js";
import { InternalGuard } from "../auth/internal.guard.js";
import { CurrentPrincipal, RequireScope, type Principal } from "../auth/principal.js";
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
  @RequireScope("settings:read")
  @UseGuards(AuthGuard)
  async getLlmSettings(): Promise<LLMSettings> {
    return { model: await this.settingsService.getActiveModel() };
  }

  @Patch("llm")
  @RequireScope("settings:write")
  @UseGuards(AuthGuard)
  async updateLlmSettings(
    @Body(new ZodValidationPipe(llmSettingsUpdateSchema)) body: LLMSettingsUpdate,
  ): Promise<LLMSettings> {
    return { model: await this.settingsService.setActiveModel(body.model) };
  }

  @Get("answer-llm")
  @RequireScope("settings:read")
  @UseGuards(AuthGuard)
  async getAnswerLlmSettings(): Promise<LLMSettings> {
    return { model: await this.settingsService.getActiveAnswerModel() };
  }

  @Patch("answer-llm")
  @RequireScope("settings:write")
  @UseGuards(AuthGuard)
  async updateAnswerLlmSettings(
    @Body(new ZodValidationPipe(llmSettingsUpdateSchema)) body: LLMSettingsUpdate,
  ): Promise<LLMSettings> {
    return { model: await this.settingsService.setActiveAnswerModel(body.model) };
  }

  @Get("available-models")
  @RequireScope("settings:read")
  @UseGuards(AuthGuard)
  async getAvailableModels(): Promise<AvailableModelsResponse> {
    return { models: await this.settingsService.listAvailableModels() };
  }

  @Get("active-llm-model")
  @RequireScope("internal:settings-read")
  @UseGuards(InternalGuard)
  async getActiveLlmModelInternal(): Promise<ActiveModelResponse> {
    return { ollama_model: await this.settingsService.getActiveModel() };
  }

  @Get("auto-approve")
  @RequireScope("settings:read")
  @UseGuards(AuthGuard)
  async getAutoApproveRules(): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.listRules() };
  }

  @Put("auto-approve")
  @RequireScope("settings:write")
  @UseGuards(AuthGuard)
  async updateAutoApproveRules(
    @Body(new ZodValidationPipe(autoApproveRulesUpdateSchema)) body: AutoApproveRulesUpdate,
    @CurrentPrincipal() principal: Principal,
  ): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.replaceRules(body, principal.kind === "member" ? principal.username : principal.service) };
  }

  @Get("active-auto-approve-rules")
  @RequireScope("internal:settings-read")
  @UseGuards(InternalGuard)
  async getActiveAutoApproveRulesInternal(): Promise<AutoApproveRulesResponse> {
    return { rules: await this.settingsService.listRules() };
  }
}
