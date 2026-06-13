import { getAiGatewayConfig } from "./aiConfig.service.js";
import { cleanAiText } from "./aiText.service.js";

export async function callAiGatewayJson({ messages = [] } = {}) {
  const config = getAiGatewayConfig();

  if (!config.enabled || !config.url) {
    return {
      ok: false,
      service: "AI_GATEWAY_DISABLED",
      response: null,
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.timeoutMs);

  try {
    const response = await fetch(config.url, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ messages }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data?.ok) {
      return {
        ok: false,
        service: data?.service || "AI_GATEWAY_FAILED",
        response: null,
        error: data?.error || data?.details || `Gateway HTTP ${response.status}`,
      };
    }

    return {
      ok: true,
      service: data.service || "AI_GATEWAY",
      response: cleanAiText(data.response),
    };
  } catch (error) {
    return {
      ok: false,
      service: "AI_GATEWAY_FAILED",
      response: null,
      error: error.message,
    };
  } finally {
    clearTimeout(timeout);
  }
}
