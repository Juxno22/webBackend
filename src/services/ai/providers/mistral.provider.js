export const mistralProvider = {
  id: "mistral",
  name: "Mistral",

  isEnabled(config) {
    return Boolean(config?.mistral?.apiKey);
  },

  async chat({ messages = [], config }) {
    const { Mistral } = await import("@mistralai/mistralai");

    const client = new Mistral({
      apiKey: config.mistral.apiKey,
    });

    const stream = await client.chat.stream({
      model: config.mistral.model,
      messages,
      temperature: config.temperature,
      maxTokens: config.maxTokens,
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield chunk.data?.choices?.[0]?.delta?.content || "";
      }
    })();
  },
};