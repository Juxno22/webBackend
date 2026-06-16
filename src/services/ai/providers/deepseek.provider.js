export const deepseekProvider = {
  id: "deepseek",
  name: "DeepSeek",

  isEnabled(config) {
    return Boolean(config?.deepseek?.apiKey);
  },

  async chat({ messages = [], config }) {
    const { default: OpenAI } = await import("openai");

    const client = new OpenAI({
      baseURL: config.deepseek.apiUrl,
      apiKey: config.deepseek.apiKey,
    });

    const completion = await client.chat.completions.create({
      model: config.deepseek.model,
      messages,
      temperature: config.temperature,
      max_tokens: config.maxTokens,

      // Parámetros especiales que pasaste para DeepSeek.
      // Si el modelo no los soporta, DeepSeek devolverá error y el runner brincará al siguiente provider.
      thinking: config.deepseek.thinkingEnabled
        ? { type: "enabled" }
        : undefined,
      reasoning_effort: config.deepseek.reasoningEffort || undefined,

      stream: false,
    });

    const content = completion?.choices?.[0]?.message?.content || "";

    return (async function* () {
      yield content;
    })();
  },
};