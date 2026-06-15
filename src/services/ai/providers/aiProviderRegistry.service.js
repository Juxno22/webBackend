import { cerebrasProvider } from "./cerebras.provider.js";
import { geminiProvider } from "./gemini.provider.js";
import { groqProvider } from "./groq.provider.js";
import { huggingFaceProvider } from "./huggingface.provider.js";
import { mistralProvider } from "./mistral.provider.js";
import { openRouterProvider } from "./openrouter.provider.js";

const PROVIDERS = [
  groqProvider,
  cerebrasProvider,
  mistralProvider,
  openRouterProvider,
  geminiProvider,
  huggingFaceProvider,
];

export function getProviderById(id) {
  const cleanId = String(id || "").trim().toLowerCase();

  return PROVIDERS.find((provider) => provider.id === cleanId) || null;
}

export function getOrderedProviders(config) {
  const ordered = [];

  for (const id of config.order || []) {
    const provider = getProviderById(id);

    if (provider && provider.isEnabled(config)) {
      ordered.push(provider);
    }
  }

  for (const provider of PROVIDERS) {
    if (!ordered.includes(provider) && provider.isEnabled(config)) {
      ordered.push(provider);
    }
  }

  return ordered;
}