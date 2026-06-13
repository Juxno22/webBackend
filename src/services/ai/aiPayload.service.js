import { cleanString, safeJsonParse } from "./aiText.service.js";

export function extractPayloadFromMessages(messages = []) {
  const userMessage = [...messages]
    .reverse()
    .find((message) => message.role === "user");

  return safeJsonParse(userMessage?.content);
}

export function extractAllowedCodes(payload) {
  const products = Array.isArray(payload?.contexto_productos)
    ? payload.contexto_productos
    : [];

  return products
    .flatMap((product) => [
      product.codigo_andyfers,
      product.codigo_importacion,
      ...(Array.isArray(product.cruces)
        ? product.cruces.map((cruce) => cruce.numero_parte)
        : []),
    ])
    .map((code) => cleanString(code).toUpperCase())
    .filter(Boolean);
}
