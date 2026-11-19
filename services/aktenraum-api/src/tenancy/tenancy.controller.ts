import { Body, Controller, HttpCode, HttpStatus, Post, UseGuards } from "@nestjs/common";
import { z } from "zod";

import { InternalGuard } from "../auth/internal.guard.js";
import { RequireScope } from "../auth/principal.js";
import { ZodValidationPipe } from "../common/zod-validation.pipe.js";
import { HomeSpaceService, type HomeSpaceAssignment } from "./home-space.service.js";

const assignHomeSpaceSchema = z.object({ document_id: z.number().int().positive() });
type AssignHomeSpaceRequest = z.infer<typeof assignHomeSpaceSchema>;

@Controller("tenancy")
export class TenancyController {
  constructor(private readonly homeSpaces: HomeSpaceService) {}

  /**
   * Worker → api, before extraction: give the document its home space and
   * mirror it into Paperless. Idempotent. 409 = an upload is still running,
   * retry later.
   */
  @Post("assign-home-space")
  @RequireScope("internal:tenancy-write")
  @UseGuards(InternalGuard)
  @HttpCode(HttpStatus.OK)
  assignHomeSpace(
    @Body(new ZodValidationPipe(assignHomeSpaceSchema)) body: AssignHomeSpaceRequest,
  ): Promise<HomeSpaceAssignment> {
    return this.homeSpaces.assign(body.document_id);
  }
}
