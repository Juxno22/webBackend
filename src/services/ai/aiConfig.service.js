import { boolFromEnv, cleanString, numberFromEnv } from "./aiText.service.js";

const DEFAULT_TIMEOUT_MS = 12000;

export function getAiConfig() {
  return {
    enabled: boolFromEnv(process.env.AI_ENABLED, false),
    provider: cleanString(process.env.AI_PROVIDER || "openrouter").toLowerCase(),
    apiKey: cleanString(process.env.OPENROUTER_API_KEY),
    apiUrl:
      cleanString(process.env.OPENROUTER_API_URL) ||
      "https://openrouter.ai/api/v1/chat/completions",
    model: cleanString(process.env.OPENROUTER_MODEL) || "openrouter/free",
    siteUrl:
      cleanString(process.env.OPENROUTER_SITE_URL) ||
      "http://localhost:3000",
    siteName:
      cleanString(process.env.OPENROUTER_SITE_NAME) ||
      "Andyfers Smart Catalog",
    timeoutMs: numberFromEnv(process.env.AI_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

export function getAiGatewayConfig() {
  return {
    enabled: boolFromEnv(process.env.AI_GATEWAY_ENABLED, false),
    url: cleanString(process.env.AI_GATEWAY_URL),
    timeoutMs: numberFromEnv(process.env.AI_GATEWAY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}
