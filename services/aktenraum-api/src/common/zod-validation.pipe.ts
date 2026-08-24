import { HttpException, HttpStatus, type PipeTransform } from "@nestjs/common";
import type { ZodSchema } from "zod";

export class ZodValidationPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: ZodSchema<T>) {}

  transform(value: unknown): T {
    const parsed = this.schema.safeParse(value);
    if (!parsed.success) {
      throw new HttpException(
        {
          detail: parsed.error.issues.map((issue) => ({
            loc: issue.path,
            msg: issue.message,
            type: issue.code,
          })),
        },
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    return parsed.data;
  }
}
