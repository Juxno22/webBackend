import { messagesToGeminiPrompt } from "./providerUtils.service.js";

export const geminiProvider = {
  id: "gemini",
  name: "Gemini",

  isEnabled(config) {
    return Boolean(config?.gemini?.apiKey);
  },

  async chat({ messages = [], config }) {
    const { GoogleGenAI } = await import("@google/genai");

    const client = new GoogleGenAI({
      apiKey: config.gemini.apiKey,
    });

    const prompt = messagesToGeminiPrompt(messages);

    const stream = await client.models.generateContentStream({
      model: config.gemini.model,
      contents: prompt,
      generationConfig: {
        temperature: config.temperature,
        maxOutputTokens: config.maxTokens,
      },
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield chunk.text || "";
      }
    })();
  },
};