import type { RequestHandler } from "express";
import type { ZodType } from "zod";

/** Validates and normalizes req.body. Validation errors go to the error handler as ZodError. */
export function validateBody(schema: ZodType): RequestHandler {
  return (req, _res, next) => {
    req.body = schema.parse(req.body ?? {});
    next();
  };
}
