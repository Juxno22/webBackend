import { cleanAiText, cleanString } from "../aiText.service.js";

export function assertMessages(messages = []) {
  if (!Array.isArray(messages)) {
    throw new Error("messages debe ser un arreglo.");
  }

  for (const message of messages) {
    if (!message || !message.role || !message.content) {
      throw new Error("Cada mensaje debe tener role y content.");
    }

    if (!["system", "user", "assistant"].includes(message.role)) {
      throw new Error("role inválido. Usa system, user o assistant.");
    }
  }
}

export async function collectProviderStream(stream) {
  let response = "";

  for await (const chunk of stream) {
    if (chunk === undefined || chunk === null) continue;

    response += String(chunk);
  }

  return cleanAiText(response);
}

export async function withTimeout(promise, timeoutMs, label = "provider") {
  let timeoutId = null;

  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`${label} excedió timeout de ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export function messagesToGeminiPrompt(messages = []) {
  return messages
    .map((message) => {
      const role =
        message.role === "system"
          ? "instrucciones"
          : message.role === "assistant"
            ? "asistente"
            : "usuario";

      return `${role}: ${message.content}`;
    })
    .join("\n\n");
}