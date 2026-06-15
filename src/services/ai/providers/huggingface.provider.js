export const huggingFaceProvider = {
  id: "huggingface",
  name: "HuggingFace",

  isEnabled(config) {
    return Boolean(config?.huggingface?.apiKey);
  },

  async chat({ messages = [], config }) {
    const { InferenceClient } = await import("@huggingface/inference");

    const client = new InferenceClient(config.huggingface.apiKey);

    const response = await client.chatCompletion({
      model: config.huggingface.model,
      messages,
      max_tokens: config.maxTokens,
      temperature: config.temperature,
    });

    return (async function* () {
      yield response.choices?.[0]?.message?.content || "";
    })();
  },
};