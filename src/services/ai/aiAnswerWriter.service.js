import { getAiConfig } from "./aiConfig.service.js";
import { callOpenRouter } from "./aiOpenRouterClient.service.js";
import { extractAllowedCodes, extractPayloadFromMessages } from "./aiPayload.service.js";
import { buildOpenRouterMessages } from "./aiPromptBuilder.service.js";
import {
  responseHasBadChatFormatting,
  responseLooksLikeProviderMetadata,
  responseMentionsUnknownCode,
} from "./aiResponseGuard.service.js";

export async function generateAiAnswer({ messages = [] } = {}) {
  const config = getAiConfig();

  if (!config.enabled) {
    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  if (config.provider !== "openrouter") {
    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  if (!config.apiKey) {
    console.warn("OPENROUTER_API_KEY no está configurada. Se usará respuesta local.");

    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }

  const payload = extractPayloadFromMessages(messages);
  const allowedCodes = extractAllowedCodes(payload);
  const openRouterMessages = buildOpenRouterMessages(messages);

  try {
    const response = await callOpenRouter({
      messages: openRouterMessages,
      config,
    });

    if (!response) {
      return {
        service: "LOCAL_CONTROLADO",
        response: null,
      };
    }

    if (responseLooksLikeProviderMetadata(response)) {
      console.warn("OpenRouter devolvió metadata/safety en vez de respuesta útil. Se usará respuesta local.");

      return {
        service: "LOCAL_CONTROLADO_AI_METADATA",
        response: null,
      };
    }

    if (responseHasBadChatFormatting(response)) {
      console.warn("OpenRouter devolvió formato no apto para chat. Se usará respuesta local.");

      return {
        service: "LOCAL_CONTROLADO_BAD_FORMAT",
        response: null,
      };
    }

    if (responseMentionsUnknownCode(response, allowedCodes)) {
      console.warn(
        "OpenRouter mencionó un código fuera del contexto. Se descartó la respuesta externa."
      );

      return {
        service: "LOCAL_CONTROLADO_VALIDATED",
        response: null,
      };
    }

    return {
      service: `OPENROUTER:${config.model}`,
      response,
    };
  } catch (error) {
    console.error("OpenRouter falló:", error.message);

    return {
      service: "LOCAL_CONTROLADO",
      response: null,
    };
  }
}
