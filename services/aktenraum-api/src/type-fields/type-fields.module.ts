import { Module } from "@nestjs/common";

import { AuthModule } from "../auth/auth.module.js";
import { TypeFieldsController } from "./type-fields.controller.js";
import { TypeFieldsService } from "./type-fields.service.js";

@Module({
  imports: [AuthModule],
  controllers: [TypeFieldsController],
  providers: [TypeFieldsService],
  exports: [TypeFieldsService],
})
export class TypeFieldsModule {}
