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
    timeoutMs: numberFromEnv(
      process.env.AI_GATEWAY_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
  };
}

export function getAiAdvisorConfig() {
  const provider = cleanString(process.env.AI_ADVISOR_PROVIDER || "auto")
    .toLowerCase();

  return {
    provider: ["auto", "multi", "openrouter", "local"].includes(provider)
      ? provider
      : "auto",
  };
}

export function getAiMultiProviderConfig() {
  const order = cleanString(
    process.env.AI_MULTI_PROVIDER_ORDER ||
      "groq,cerebras,mistral,openrouter,gemini,huggingface"
  )
    .split(",")
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return {
    enabled: boolFromEnv(process.env.AI_MULTI_PROVIDER_ENABLED, false),
    order,
    timeoutMs: numberFromEnv(
      process.env.AI_MULTI_PROVIDER_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS
    ),
    maxTokens: numberFromEnv(process.env.AI_MULTI_PROVIDER_MAX_TOKENS, 700),
    temperature: Number.isFinite(Number(process.env.AI_MULTI_PROVIDER_TEMPERATURE))
      ? Number(process.env.AI_MULTI_PROVIDER_TEMPERATURE)
      : 0.35,

    groq: {
      apiKey: cleanString(process.env.GROQ_API_KEY),
      model: cleanString(process.env.GROQ_MODEL) || "llama-3.3-70b-versatile",
    },

    cerebras: {
      apiKey: cleanString(process.env.CEREBRAS_API_KEY),
      model: cleanString(process.env.CEREBRAS_MODEL) || "gpt-oss-120b",
    },

    mistral: {
      apiKey: cleanString(process.env.MISTRAL_API_KEY),
      model: cleanString(process.env.MISTRAL_MODEL) || "mistral-small-latest",
    },

    openrouter: {
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
    },

    gemini: {
      apiKey: cleanString(process.env.GEMINI_API_KEY),
      model: cleanString(process.env.GEMINI_MODEL) || "gemini-2.5-flash",
    },

    huggingface: {
      apiKey: cleanString(process.env.HF_TOKEN),
      model:
        cleanString(process.env.HUGGINGFACE_MODEL) ||
        "mistralai/Mistral-7B-Instruct-v0.3",
    },
  };
}