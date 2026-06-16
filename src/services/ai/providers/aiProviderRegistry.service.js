import { cerebrasProvider } from "./cerebras.provider.js";
import { deepseekProvider } from "./deepseek.provider.js";
import { groqProvider } from "./groq.provider.js";
import { mistralProvider } from "./mistral.provider.js";
import { openRouterProvider } from "./openrouter.provider.js";

const PROVIDERS = [
  groqProvider,
  deepseekProvider,
  cerebrasProvider,
  mistralProvider,
  openRouterProvider,
];

export function getProviderById(id) {
  const cleanId = String(id || "").trim().toLowerCase();

  return PROVIDERS.find((provider) => provider.id === cleanId) || null;
}

export function getOrderedProviders(config) {
  const ordered = [];

  for (const id of config.order || []) {
    const provider = getProviderById(id);

    if (provider && provider.isEnabled(config) && !ordered.includes(provider)) {
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