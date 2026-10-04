import type {} from "vitest";

declare module "vitest" {
  interface ProvidedContext {
    sidecarUrl: string;
    sidecarToken: string;
  }
}
