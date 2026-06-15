import {
  getAiAdvisorConfig,
  getAiConfig,
} from "./aiConfig.service.js";
import { callOpenRouter } from "./aiOpenRouterClient.service.js";
import {
  extractAllowedCodes,
  extractPayloadFromMessages,
} from "./aiPayload.service.js";
import {
  buildAdvisorMessages,
  buildOpenRouterMessages,
} from "./aiPromptBuilder.service.js";
import {
  responseHasBadChatFormatting,
  responseLooksLikeProviderMetadata,
  responseMentionsUnknownCode,
} from "./aiResponseGuard.service.js";
import { runMultiProviderChat } from "./providers/aiProviderRunner.service.js";

function validateAiResponse({
  response,
  allowedCodes = [],
  validateCodes = true,
  localService = "LOCAL_CONTROLADO",
}) {
  if (!response) {
    return {
      ok: false,
      service: localService,
      response: null,
    };
  }

  if (responseLooksLikeProviderMetadata(response)) {
    return {
      ok: false,
      service: `${localService}_AI_METADATA`,
      response: null,
    };
  }

  if (responseHasBadChatFormatting(response)) {
    return {
      ok: false,
      service: `${localService}_BAD_FORMAT`,
      response: null,
    };
  }

  if (validateCodes && responseMentionsUnknownCode(response, allowedCodes)) {
    return {
      ok: false,
      service: `${localService}_VALIDATED`,
      response: null,
    };
  }

  return {
    ok: true,
    service: null,
    response,
  };
}

async function tryOpenRouterAnswer({
  messages = [],
  promptBuilder,
  temperature = 0.25,
  maxTokens = 450,
  localService = "LOCAL_CONTROLADO",
  externalPrefix = "OPENROUTER",
  validateCodes = true,
}) {
  const config = getAiConfig();

  if (!config.enabled || config.provider !== "openrouter" || !config.apiKey) {
    return {
      service: localService,
      response: null,
    };
  }

  const payload = extractPayloadFromMessages(messages);
  const allowedCodes = extractAllowedCodes(payload);

  try {
    const response = await callOpenRouter({
      messages: promptBuilder(messages),
      config,
      temperature,
      maxTokens,
    });

    const validation = validateAiResponse({
      response,
      allowedCodes,
      validateCodes,
      localService,
    });

    if (!validation.ok) {
      return {
        service: validation.service,
        response: null,
      };
    }

    return {
      service: `${externalPrefix}:${config.model}`,
      response: validation.response,
    };
  } catch (error) {
    console.error(`${externalPrefix} falló:`, error.message);

    return {
      service: localService,
      response: null,
    };
  }
}

async function tryMultiProviderAdvisorAnswer({ messages = [] } = {}) {
  const advisorMessages = buildAdvisorMessages(messages);
  const payload = extractPayloadFromMessages(messages);
  const allowedCodes = extractAllowedCodes(payload);

  const result = await runMultiProviderChat({
    messages: advisorMessages,
  });

  if (!result.ok || !result.response) {
    return {
      service: result.service || "MULTI_PROVIDER_FAILED",
      response: null,
    };
  }

  const validation = validateAiResponse({
    response: result.response,
    allowedCodes,
    validateCodes: true,
    localService: "LOCAL_ASESOR_CONTROLADO",
  });

  if (!validation.ok) {
    return {
      service: validation.service,
      response: null,
    };
  }

  return {
    service: `MULTI_ASESOR:${result.service}`,
    response: validation.response,
  };
}

export async function generateAiAnswer({ messages = [] } = {}) {
  return tryOpenRouterAnswer({
    messages,
    promptBuilder: buildOpenRouterMessages,
    temperature: 0.25,
    maxTokens: 450,
    localService: "LOCAL_CONTROLADO",
    externalPrefix: "OPENROUTER",
    validateCodes: true,
  });
}

export async function generateAiAdvisorAnswer({ messages = [] } = {}) {
  const advisorConfig = getAiAdvisorConfig();

  if (advisorConfig.provider === "local") {
    return {
      service: "LOCAL_ASESOR_CONTROLADO",
      response: null,
    };
  }

  if (advisorConfig.provider === "multi") {
    const multiResult = await tryMultiProviderAdvisorAnswer({ messages });

    return multiResult.response
      ? multiResult
      : {
          service: multiResult.service || "LOCAL_ASESOR_CONTROLADO",
          response: null,
        };
  }

  if (advisorConfig.provider === "openrouter") {
    return tryOpenRouterAnswer({
      messages,
      promptBuilder: buildAdvisorMessages,
      temperature: 0.35,
      maxTokens: 520,
      localService: "LOCAL_ASESOR_CONTROLADO",
      externalPrefix: "OPENROUTER_ASESOR",
      validateCodes: true,
    });
  }

  /**
   * AUTO:
   * 1. Intenta multi-provider interno.
   * 2. Si falla, intenta OpenRouter directo.
   * 3. Si falla, respuesta local controlada.
   */
  const multiResult = await tryMultiProviderAdvisorAnswer({ messages });

  if (multiResult.response) {
    return multiResult;
  }

  const openRouterResult = await tryOpenRouterAnswer({
    messages,
    promptBuilder: buildAdvisorMessages,
    temperature: 0.35,
    maxTokens: 520,
    localService: "LOCAL_ASESOR_CONTROLADO",
    externalPrefix: "OPENROUTER_ASESOR",
    validateCodes: true,
  });

  if (openRouterResult.response) {
    return openRouterResult;
  }

  return {
    service:
      multiResult.service && multiResult.service !== "MULTI_PROVIDER_DISABLED"
        ? multiResult.service
        : "LOCAL_ASESOR_CONTROLADO",
    response: null,
  };
}