import { cleanAiText } from "../aiText.service.js";

export const openRouterProvider = {
  id: "openrouter",
  name: "OpenRouter",

  isEnabled(config) {
    return Boolean(config?.openrouter?.apiKey);
  },

  async chat({ messages = [], config }) {
    const response = await fetch(config.openrouter.apiUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.openrouter.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.openrouter.siteUrl,
        "X-Title": config.openrouter.siteName,
      },
      body: JSON.stringify({
        model: config.openrouter.model,
        messages,
        temperature: config.temperature,
        max_tokens: config.maxTokens,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `OpenRouter respondió HTTP ${response.status}`;

      throw new Error(message);
    }

    const content = cleanAiText(data?.choices?.[0]?.message?.content);

    return (async function* () {
      yield content;
    })();
  },
};