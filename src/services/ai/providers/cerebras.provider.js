export const cerebrasProvider = {
  id: "cerebras",
  name: "Cerebras",

  isEnabled(config) {
    return Boolean(config?.cerebras?.apiKey);
  },

  async chat({ messages = [], config }) {
    const mod = await import("@cerebras/cerebras_cloud_sdk/index.mjs");
    const Cerebras = mod.default || mod.Cerebras;

    const client = new Cerebras({
      apiKey: config.cerebras.apiKey,
    });

    const stream = await client.chat.completions.create({
      messages,
      model: config.cerebras.model,
      stream: true,
      max_completion_tokens: config.maxTokens,
      temperature: config.temperature,
      top_p: 1,
      reasoning_effort: "medium",
    });

    return (async function* () {
      for await (const chunk of stream) {
        yield chunk.choices?.[0]?.delta?.content || "";
      }
    })();
  },
};