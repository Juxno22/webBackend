const PROVIDER_CONFIG = {
  groq: {
    name: "Groq",
    apiKeyEnv: "GROQ_API_KEY",
    url: "https://api.groq.com/openai/v1/chat/completions",
    modelEnv: "GROQ_MODEL",
    defaultModel: "llama-3.3-70b-versatile",
  },
  openrouter: {
    name: "OpenRouter",
    apiKeyEnv: "OPENROUTER_API_KEY",
    url: "https://openrouter.ai/api/v1/chat/completions",
    modelEnv: "OPENROUTER_MODEL",
    defaultModel: "openrouter/auto",
  },
};

function getProviderConfig() {
  const providerKey = String(process.env.IA_PROVIDER || "none").toLowerCase();

  if (providerKey === "none" || providerKey === "off") return null;

  return PROVIDER_CONFIG[providerKey] || null;
}

function extractTextFromChatCompletion(payload) {
  return payload?.choices?.[0]?.message?.content?.trim() || "";
}

export async function generateAiAnswer({ messages }) {
  const provider = getProviderConfig();

  if (!provider) {
    return {
      service: "LOCAL_CONTROLADO",
      response: "",
      skipped: true,
    };
  }

  const apiKey = process.env[provider.apiKeyEnv];

  if (!apiKey) {
    return {
      service: provider.name,
      response: "",
      skipped: true,
      warning: `Falta ${provider.apiKeyEnv}`,
    };
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    "Content-Type": "application/json",
  };

  if (provider.name === "OpenRouter") {
    headers["HTTP-Referer"] =
      process.env.PUBLIC_SITE_URL || "http://localhost:3000";
    headers["X-OpenRouter-Title"] = "Andyfers Smart Catalog";
  }

  const response = await fetch(provider.url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      model: process.env[provider.modelEnv] || provider.defaultModel,
      messages,
      temperature: 0.2,
      max_tokens: 700,
      stream: false,
    }),
  });

  const payload = await response.json().catch(() => null);

  if (!response.ok) {
    throw new Error(
      payload?.error?.message ||
        payload?.message ||
        `Error IA ${provider.name}: ${response.status}`
    );
  }

  return {
    service: provider.name,
    response: extractTextFromChatCompletion(payload),
    skipped: false,
  };
}