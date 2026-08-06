import { randomBytes, randomUUID } from "node:crypto";

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

export function now(): string {
  return new Date().toISOString();
}
