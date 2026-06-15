import { getAiMultiProviderConfig } from "../aiConfig.service.js";
import {
  assertMessages,
  collectProviderStream,
  withTimeout,
} from "./providerUtils.service.js";
import { getOrderedProviders } from "./aiProviderRegistry.service.js";

let currentProviderIndex = 0;

function rotateProviders(providers = []) {
  if (!providers.length) return [];

  const start = currentProviderIndex % providers.length;

  currentProviderIndex = (currentProviderIndex + 1) % providers.length;

  return [
    ...providers.slice(start),
    ...providers.slice(0, start),
  ];
}

export async function runMultiProviderChat({ messages = [] } = {}) {
  assertMessages(messages);

  const config = getAiMultiProviderConfig();

  if (!config.enabled) {
    return {
      ok: false,
      service: "MULTI_PROVIDER_DISABLED",
      response: null,
      errors: [],
    };
  }

  const providers = getOrderedProviders(config);

  if (!providers.length) {
    return {
      ok: false,
      service: "MULTI_PROVIDER_NO_KEYS",
      response: null,
      errors: [],
    };
  }

  const errors = [];
  const queue = rotateProviders(providers);

  for (const provider of queue) {
    try {
      console.log(`Probando proveedor IA interno: ${provider.name}`);

      const response = await withTimeout(
        (async () => {
          const stream = await provider.chat({
            messages,
            config,
          });

          return collectProviderStream(stream);
        })(),
        config.timeoutMs,
        provider.name
      );

      if (!response) {
        throw new Error("Respuesta vacía.");
      }

      return {
        ok: true,
        service: provider.name,
        response,
        errors,
      };
    } catch (error) {
      console.error(`Falló proveedor IA ${provider.name}:`, error.message);

      errors.push({
        provider: provider.name,
        error: error.message,
      });
    }
  }

  return {
    ok: false,
    service: "MULTI_PROVIDER_ALL_FAILED",
    response: null,
    errors,
  };
}