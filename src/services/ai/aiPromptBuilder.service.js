import { extractPayloadFromMessages } from "./aiPayload.service.js";

export function buildOpenRouterMessages(messages = []) {
  const payload = extractPayloadFromMessages(messages);
  const products = Array.isArray(payload?.contexto_productos)
    ? payload.contexto_productos
    : [];

  const strictSystem = [
    "Eres Andy-Bot, asistente comercial de refacciones de Andyfers.",
    "Tu trabajo es redactar una respuesta breve, clara y útil para cliente final.",
    "REGLA CRÍTICA: solo puedes usar los productos incluidos en CONTEXTO.",
    "No inventes códigos, piezas, compatibilidades, precios, stock, marcas ni aplicaciones.",
    "No recomiendes productos que no aparezcan en CONTEXTO.",
    "Los productos ya se muestran en tarjetas visuales debajo de tu respuesta.",
    "No hagas tablas.",
    "No hagas listas largas de productos.",
    "No repitas todos los códigos de productos.",
    "No uses markdown, no uses negritas con **, no uses tablas con |.",
    "Tu respuesta debe ser de máximo 3 oraciones.",
    "Si hay productos, resume lo encontrado y pide datos faltantes si hace falta.",
    "Si intencion_detectada.excluded_vehicle_tokens contiene una marca/modelo, no presentes opciones relacionadas con esa marca/modelo.",
    "Si intencion_detectada.excluded_product_brand_tokens contiene una marca/fabricante, no afirmes que los productos son de otra marca salvo que el contexto tenga un campo explícito de marca del producto.",
    "Si no existe marca del producto en el contexto, di que se tomó en cuenta la preferencia por alternativa/no original y que ventas valida marca/fabricante final.",
    "No confundas aplicación del vehículo con fabricante de la pieza. Por ejemplo, 'Nissan March' en la descripción puede ser compatibilidad, no marca fabricante.",
    "No diagnostiques como mecánico; solo orienta y pide validación.",
    "Si falta marca, modelo, año o motor, pide esos datos de forma natural.",
    "Siempre aclara que ventas valida compatibilidad y disponibilidad final.",
    "Responde en español mexicano natural.",
  ].join(" ");

  const compactPayload = {
    pregunta_cliente: payload?.pregunta_cliente || "",
    intencion_detectada: {
      marca_auto: payload?.intencion_detectada?.marca_auto || null,
      modelo_auto: payload?.intencion_detectada?.modelo_auto || null,
      anio: payload?.intencion_detectada?.anio || null,
      motor: payload?.intencion_detectada?.motor || null,
      modo_busqueda: payload?.intencion_detectada?.modo_busqueda || null,

      excluded_tokens: payload?.intencion_detectada?.excluded_tokens || [],
      excluded_vehicle_tokens:
        payload?.intencion_detectada?.excluded_vehicle_tokens || [],
      excluded_product_brand_tokens:
        payload?.intencion_detectada?.excluded_product_brand_tokens || [],
      has_negation: payload?.intencion_detectada?.has_negation || false,
      productos_se_muestran_en_tarjetas: true,

      sintomas_detectados:
        payload?.intencion_detectada?.sintomas_detectados || [],
      condiciones_detectadas:
        payload?.intencion_detectada?.condiciones_detectadas || [],
      preferencias_comerciales:
        payload?.intencion_detectada?.preferencias_comerciales || {},
      contexto_sesion_aplicado:
        payload?.intencion_detectada?.contexto_sesion_aplicado || false,
    },
    contexto_productos: products.slice(0, 5).map((product) => ({
      codigo_andyfers: product.codigo_andyfers,
      codigo_importacion: product.codigo_importacion,
      descripcion: product.descripcion,
      familia: product.familia,
      categoria: product.categoria,
      compatibilidad_estimada: product.compatibilidad_estimada,
      razones_compatibilidad: product.razones_compatibilidad,
      aplicaciones: Array.isArray(product.aplicaciones)
        ? product.aplicaciones.slice(0, 4)
        : [],
      cruces: Array.isArray(product.cruces)
        ? product.cruces.slice(0, 4)
        : [],
    })),
  };

  return [
    {
      role: "system",
      content: strictSystem,
    },
    {
      role: "user",
      content: JSON.stringify(compactPayload, null, 2),
    },
  ];
}

export function buildIntentNormalizerMessages({ question, localIntent }) {
  return [
    {
      role: "system",
      content: [
        "Eres un normalizador semántico para un buscador de refacciones.",
        "Tu única tarea es convertir la petición del cliente en JSON estructurado.",
        "No recomiendes productos.",
        "No inventes códigos.",
        "No inventes compatibilidades.",
        "No respondas al cliente.",
        "Interpreta lenguaje natural, sinónimos, negaciones, exclusiones y preferencias.",
        "Si el cliente pide otra marca, distinta a, diferente a, excepto, no sea, no pertenezca, no provenga o no producida por, debes llenar exclusiones.",
        "No copies ejemplos del prompt como si fueran datos reales del cliente.",
        "Solo llena exclusiones si el cliente las pidió explícitamente en la pregunta.",
        "Si el cliente pide bomba y el contexto sugiere sistema de agua/enfriamiento, normaliza como BOMBA DE AGUA.",
        "Responde únicamente JSON válido, sin markdown.",
        "Formato obligatorio:",
        "Clasifica exclusiones en dos grupos.",
        "exclusiones_vehiculo: úsalo cuando el cliente diga que NO quiere piezas para/compatibles/con aplicación de una marca o modelo, por ejemplo no sea para Nissan, not for Nissan, que no le quede a Nissan.",
        "exclusiones_marca_producto: úsalo cuando el cliente hable de fabricante, marca de la pieza, original/OEM o alternativa, por ejemplo marca diferente a Nissan, fabricada por otra marca, no producida por Nissan, no original.",
        "Si el cliente dice marca diferente a Nissan y ya hay contexto de vehículo Nissan, NO lo tomes como exclusión de vehículo; tómalo como exclusión_marca_producto.",
        JSON.stringify({
          pieza_normalizada: null,
          exclusiones_vehiculo: [],
          exclusiones_marca_producto: [],
          preferencias: {
            economica: false,
            no_original: false,
            otra_marca: false,
          },
          vehiculo: {
            marca_auto: null,
            modelo_auto: null,
            anio: null,
            motor: null,
          },
          tipo_busqueda: "NO_DETERMINADO",
          confianza: 0,
          requiere_validacion: true,
        }),
      ].join(" "),
    },
    {
      role: "user",
      content: JSON.stringify(
        {
          pregunta_cliente: question,
          intencion_local_previa: {
            pieza_detectada: localIntent?.terminos_producto_detectados || [],
            tokens: localIntent?.tokens || [],
            excluded_tokens: localIntent?.excluded_tokens || [],
            marca_auto: localIntent?.marca_auto || null,
            modelo_auto: localIntent?.modelo_auto || null,
            anio: localIntent?.anio || null,
            motor: localIntent?.motor || null,
            preferencias_comerciales:
              localIntent?.preferencias_comerciales || {},
          },
        },
        null,
        2
      ),
    },
  ];
};

export function buildAdvisorMessages(messages = []) {
  const payload = extractPayloadFromMessages(messages) || {};

  const advisorSystem = [
    "Adapta la respuesta al nivel del usuario indicado en intencion_detectada.nivel_usuario.",
    "Si nivel_usuario es PRINCIPIANTE, usa lenguaje simple, explica qué hace la pieza y pide datos sin sonar técnico.",
    "Si nivel_usuario es INTERMEDIO, combina explicación breve con datos prácticos de búsqueda.",
    "Si nivel_usuario es MECANICO, puedes usar términos técnicos como aplicación, cruce, medida, PSI, temperatura de apertura, motor y número de parte.",
    "No trates a un mecánico como principiante, pero tampoco inventes datos técnicos que no estén en contexto.",
    "Eres Andy-Bot, asesor inteligente de refacciones de Andyfers.",
    "Tu especialidad principal es sistema de enfriamiento automotriz: bomba de agua, termostato, radiador, tapón, depósito, mangueras, ventilador, motoventilador, sensores de temperatura, toma de agua, poleas y anticongelante.",
    "Tu objetivo es que el cliente sienta que habla con un asesor útil, no con un buscador rígido.",
    "Puedes explicar conceptos, comparar familias de piezas y orientar síntomas de forma general.",
    "Si recibes contexto_productos, solo puedes comparar o explicar usando esos productos.",
    "No inventes códigos, precios, stock, marcas, cruces, atributos, compatibilidades ni aplicaciones.",
    "No confirmes compatibilidad absoluta; usa frases como 'según la información del catálogo' o 'compatibilidad estimada'.",
    "No digas que una marca/fabricante está confirmado si marca_producto_confirmada no es true o si no viene el campo.",
    "Si falta información para comparar o validar, pide el dato faltante de forma natural.",
    "Si el usuario es principiante, explica simple. Si usa términos técnicos, responde con más precisión.",
    "No uses tablas, markdown, negritas ni listas largas.",
    "Responde máximo 3 oraciones.",
    "Siempre que aplique, aclara que ventas valida compatibilidad y disponibilidad final.",
    "Responde en español mexicano natural.",
  ].join(" ");

  const compactPayload = {
    pregunta_cliente: payload.pregunta_cliente || "",
    modo_conversacion: payload.modo_conversacion || null,
    ruta: payload.ruta || {},
    intencion_detectada: payload.intencion_detectada || {},
    contexto_sesion: payload.contexto_sesion || {},
    contexto_productos: Array.isArray(payload.contexto_productos)
      ? payload.contexto_productos.slice(0, 6).map((product) => ({
        producto_id: product.producto_id || product.id,
        codigo_andyfers: product.codigo_andyfers,
        codigo_importacion: product.codigo_importacion,
        descripcion: product.descripcion,
        descripcion_web: product.descripcion_web,
        familia: product.familia,
        categoria: product.categoria,
        armadora: product.armadora,
        marca_producto: product.marca_producto,
        tipo_marca_producto: product.tipo_marca_producto,
        marca_producto_confirmada: product.marca_producto_confirmada,
        precio_minimo: product.precio_minimo,
        stock_total_web: product.stock_total_web,
        compatibilidad_estimada: product.compatibilidad_estimada,
        razones_compatibilidad: product.razones_compatibilidad,
        aplicaciones: Array.isArray(product.aplicaciones)
          ? product.aplicaciones.slice(0, 5)
          : [],
        cruces: Array.isArray(product.cruces)
          ? product.cruces.slice(0, 5)
          : [],
        atributos: Array.isArray(product.atributos)
          ? product.atributos.slice(0, 8)
          : [],
      }))
      : [],
    evidencia_controlada: payload.evidencia_controlada || null,
  };

  return [
    {
      role: "system",
      content: advisorSystem,
    },
    {
      role: "user",
      content: JSON.stringify(compactPayload, null, 2),
    },
  ];
}
