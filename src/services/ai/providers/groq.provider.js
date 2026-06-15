export const groqProvider = {
  id: "groq",
  name: "Groq",

  isEnabled(config) {
    return Boolean(config?.groq?.apiKey);
  },

  async chat({ messages = [], config }) {
    const { Groq } = await import("groq-sdk");

    const client = new Groq({
      apiKey: config.groq.apiKey,
    });

    const stream = await client.chat.completions.create({
      messages,
      model: config.groq.model,
      temperature: config.temperature,
      max_completion_tokens: config.maxTokens,
      top_p: 1,
      stream: true,
      stop: null,
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield chunk.choices?.[0]?.delta?.content || "";
      }
    })();
  },
};