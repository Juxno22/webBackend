import { cleanAiText } from "./aiText.service.js";

export async function callOpenRouter({
  messages,
  config,
  temperature = 0.25,
  maxTokens = 450,
}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.apiUrl, {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": config.siteUrl,
        "X-Title": config.siteName,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message =
        data?.error?.message ||
        data?.message ||
        `OpenRouter respondió HTTP ${response.status}`;

      const error = new Error(message);
      error.status = response.status;
      throw error;
    }

    const content = data?.choices?.[0]?.message?.content;

    return cleanAiText(content);
  } finally {
    clearTimeout(timeout);
  }
}
