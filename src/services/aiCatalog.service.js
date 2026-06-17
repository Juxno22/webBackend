import {
  generateAiAdvisorAnswer,
  generateAiAnswer,
  normalizeUserIntentWithAi,
} from "./aiProvider.service.js";
import {
  getOrCreateSearchSession,
  mergeSessionContextWithIntent,
  updateSearchSessionContext,
  resetSearchSession,
  shouldResetSearchSession,
  hasVehicleContext,
} from "./aiSession.service.js";
import { cleanString } from "./catalog-ai/catalogUtils.service.js";
import {
  asksForBranchStock,
  asksForFutureStock,
  buildIntent,
  buildIntentGate,
  shouldUseSemanticIntentNormalizer,
  applySemanticIntentToLocalIntent,
} from "./catalog-ai/catalogIntent.service.js";
import {
  searchCandidates,
  getCandidateDetails,
} from "./catalog-ai/catalogSearch.service.js";
import {
  scoreCandidate,
  formatCandidate,
  compareCandidatesByIntent,
  productMatchesExcluded,
} from "./catalog-ai/catalogScoring.service.js";
import {
  buildLocalAnswer,
  buildAiMessages,
} from "./catalog-ai/catalogResponse.service.js";
import {
  buildAdvisorAiMessages,
  buildAdvisorLocalAnswer,
} from "./catalog-ai/catalogAdvisorResponse.service.js";
import {
  CATALOG_CONVERSATION_MODES,
  routeCatalogConversation,
} from "./catalog-ai/catalogConversationRouter.service.js";
import { logAiSearch } from "./catalog-ai/catalogLog.service.js";
import { shouldIgnoreSessionContextForQuestion } from "./catalog-ai/catalogSessionRules.service.js";
import {
  buildProductComparisonEvidence,
  buildProductComparisonLocalAnswer,
  buildCrossApplicationComparisonEvidence,
  buildCrossApplicationComparisonLocalAnswer,
} from "./catalog-ai/catalogProductComparison.service.js";
import {
  buildCompatibilityEvidence,
  buildCompatibilityExplanationLocalAnswer,
} from "./catalog-ai/catalogCompatibility.service.js";
import { detectAudienceLevel } from "./catalog-ai/catalogAudience.service.js";
import { addFollowupToCatalogResult } from "./catalog-ai/catalogFollowup.service.js";

function buildEmptyResult({
  intent,
  sessionId,
  context,
  answer,
  service,
  requiresMoreData = true,
  question = "",
  mode = null,
}) {
  const result = {
    intencion: intent,
    session_id: sessionId,
    contexto_corto: context || {},
    respuesta: answer,
    servicio_ia: service,
    total_candidatos: 0,
    total_recomendados: 0,
    productos: [],
    requiere_mas_datos: requiresMoreData,
  };

  if (!question) return result;

  return addFollowupToCatalogResult(result, {
    question,
    intent,
    mode: mode || intent?.modo_conversacion || intent?.modo_busqueda,
    products: [],
  });
}

async function buildIntentWithSemanticNormalizer(cleanQuestion) {
  let rawIntent = await buildIntent(cleanQuestion);

  if (shouldUseSemanticIntentNormalizer(cleanQuestion, rawIntent)) {
    const semanticResult = await normalizeUserIntentWithAi({
      question: cleanQuestion,
      localIntent: rawIntent,
    });

    if (semanticResult.intent) {
      rawIntent = applySemanticIntentToLocalIntent(
        rawIntent,
        semanticResult.intent
      );

      rawIntent.normalizador_ia_servicio = semanticResult.service;
    } else {
      rawIntent.normalizador_ia_servicio = semanticResult.service;
    }
  }

  return rawIntent;
}

function shouldForceLocalAdvisorResponse({ route, intent = {} } = {}) {
  return (
    route?.reason === "PRODUCT_CONCEPT_EXPLANATION" ||
    (
      route?.mode === CATALOG_CONVERSATION_MODES.DIAGNOSTIC_GUIDE &&
      intent.nivel_usuario === "PRINCIPIANTE"
    )
  );
}

async function answerAdvisorMode({
  cleanQuestion,
  intent,
  route,
  session,
  ignoreSessionContext,
  origen,
}) {
  const advisoryIntent = {
    ...intent,
    gate_reason: route.reason,
    modo_busqueda: route.mode,
    modo_conversacion: route.mode,
    conversation_route: route,
    session_id: session.session_id,
  };

  const updatedContext = ignoreSessionContext
    ? {}
    : await updateSearchSessionContext({
      sessionId: session.session_id,
      previousContext: session.contexto,
      intent: advisoryIntent,
      question: cleanQuestion,
      origen,
    });

  const effectiveIntent = {
    ...advisoryIntent,
    contexto_corto: updatedContext,
  };

  let service = "LOCAL_ASESOR_CONTROLADO";
  let answer = buildAdvisorLocalAnswer({
    mode: route.mode,
    intent: effectiveIntent,
    sessionContext: updatedContext,
  });

  const forceLocalAdvisor = shouldForceLocalAdvisorResponse({
    route,
    intent: effectiveIntent,
  });

  if (!forceLocalAdvisor) {
    try {
      const aiResult = await generateAiAdvisorAnswer({
        messages: buildAdvisorAiMessages({
          question: cleanQuestion,
          mode: route.mode,
          route,
          intent: effectiveIntent,
          sessionContext: updatedContext,
        }),
      });

      service = aiResult.service || service;

      if (aiResult.response) {
        answer = aiResult.response;
      }
    } catch (error) {
      service = "LOCAL_ASESOR_CONTROLADO";
      console.error("IA asesora falló, se usó respuesta local:", error.message);
    }
  }

  await logAiSearch({
    question: cleanQuestion,
    intent: effectiveIntent,
    candidates: [],
    recommended: [],
    service,
    response: answer,
    origen,
  });

  return buildEmptyResult({
    intent: effectiveIntent,
    sessionId: session.session_id,
    context: updatedContext,
    answer,
    service,
    requiresMoreData: route.requiresMoreData !== false,
    question: cleanQuestion,
    mode: route.mode,
  });
}

async function runProductSearch({ cleanQuestion, effectiveIntent, origen }) {
  const rows = await searchCandidates(effectiveIntent);
  const ids = rows.map((row) => row.id);
  const related = await getCandidateDetails(ids);

  const scored = rows
    .map((row) => {
      const details = {
        aplicaciones: related.aplicacionesByProduct.get(row.id) || [],
        cruces: related.crucesByProduct.get(row.id) || [],
        atributos: related.atributosByProduct.get(row.id) || [],
      };

      const scoreData = scoreCandidate(row, effectiveIntent, details);

      return formatCandidate(row, scoreData, details);
    })
    .filter((product) => !productMatchesExcluded(product, effectiveIntent))
    .sort(compareCandidatesByIntent(effectiveIntent));

  const recommended = scored.slice(0, 6);

  let service = "LOCAL_CONTROLADO";
  let answer = buildLocalAnswer({
    question: cleanQuestion,
    intent: effectiveIntent,
    products: recommended,
  });

  const conversationMode = effectiveIntent.modo_conversacion;
  let useAdvisorWriter = false;
  let advisorEvidence = null;

  if (conversationMode === CATALOG_CONVERSATION_MODES.PRODUCT_COMPARISON) {
    const isCrossApplicationComparison =
      effectiveIntent.conversation_route?.reason === "CROSS_APPLICATION_COMPARISON" ||
      effectiveIntent.comparacion_aplicacion?.activa;

    service = isCrossApplicationComparison
      ? "LOCAL_COMPARADOR_APLICACIONES_CONTROLADO"
      : "LOCAL_COMPARADOR_CONTROLADO";

    advisorEvidence = isCrossApplicationComparison
      ? buildCrossApplicationComparisonEvidence({
        products: recommended,
        intent: effectiveIntent,
      })
      : buildProductComparisonEvidence({
        products: recommended,
        intent: effectiveIntent,
      });

    answer = isCrossApplicationComparison
      ? buildCrossApplicationComparisonLocalAnswer({
        products: recommended,
        intent: effectiveIntent,
      })
      : buildProductComparisonLocalAnswer({
        products: recommended,
        intent: effectiveIntent,
      });

    useAdvisorWriter = recommended.length > 0 || isCrossApplicationComparison;
  }

  if (conversationMode === CATALOG_CONVERSATION_MODES.COMPATIBILITY_EXPLANATION) {
    service = "LOCAL_COMPATIBILIDAD_CONTROLADA";
    advisorEvidence = buildCompatibilityEvidence({
      products: recommended,
      intent: effectiveIntent,
    });

    answer = buildCompatibilityExplanationLocalAnswer({
      products: recommended,
      intent: effectiveIntent,
    });

    useAdvisorWriter = recommended.length > 0;
  }

  if (recommended.length > 0 || useAdvisorWriter) {
    try {
      const aiResult = useAdvisorWriter
        ? await generateAiAdvisorAnswer({
          messages: buildAdvisorAiMessages({
            question: cleanQuestion,
            mode: conversationMode,
            route: effectiveIntent.conversation_route,
            intent: effectiveIntent,
            sessionContext: effectiveIntent.contexto_corto || {},
            products: recommended,
            evidence: advisorEvidence,
          }),
        })
        : await generateAiAnswer({
          messages: buildAiMessages({
            question: cleanQuestion,
            intent: effectiveIntent,
            products: recommended,
          }),
        });

      service = aiResult.service || service;

      if (aiResult.response) {
        answer = aiResult.response;
      }
    } catch (error) {
      console.error("IA externa falló, se usó respuesta local:", error.message);
    }
  }

  await logAiSearch({
    question: cleanQuestion,
    intent: effectiveIntent,
    candidates: scored,
    recommended,
    service,
    response: answer,
    origen,
  });

  return addFollowupToCatalogResult(
    {
      intencion: effectiveIntent,
      session_id: effectiveIntent.session_id,
      contexto_corto: effectiveIntent.contexto_corto || {},
      respuesta: answer,
      servicio_ia: service,
      total_candidatos: scored.length,
      total_recomendados: recommended.length,
      productos: recommended,
    },
    {
      question: cleanQuestion,
      intent: effectiveIntent,
      mode: effectiveIntent.modo_conversacion || effectiveIntent.modo_busqueda,
      products: recommended,
    }
  );
}

export async function searchCatalogWithAi({
  question,
  origen = "CHAT_PUBLICO",
  sessionId: rawSessionId = null,
}) {
  const cleanQuestion = cleanString(question);

  if (cleanQuestion.length < 3) {
    const error = new Error("Escribe una búsqueda más específica.");
    error.status = 400;
    throw error;
  }

  if (shouldResetSearchSession(cleanQuestion)) {
    const sessionId = await resetSearchSession(rawSessionId);

    const answer =
      "Listo, borré el vehículo guardado para esta búsqueda. Dime el nuevo vehículo o la pieza que necesitas.";

    await logAiSearch({
      question: cleanQuestion,
      intent: {
        gate_reason: "SESSION_CONTEXT_RESET",
      },
      candidates: [],
      recommended: [],
      service: "LOCAL_CONTROLADO",
      response: answer,
      origen,
    });

    return addFollowupToCatalogResult(
      {
        ok: true,
        session_id: sessionId,
        intencion: {
          gate_reason: "SESSION_CONTEXT_RESET",
        },
        respuesta: answer,
        servicio_ia: "LOCAL_CONTROLADO",
        total_candidatos: 0,
        total_recomendados: 0,
        productos: [],
        requiere_mas_datos: true,
        contexto_corto: {},
      },
      {
        question: cleanQuestion,
        intent: {
          gate_reason: "SESSION_CONTEXT_RESET",
        },
        mode: "SESSION_CONTEXT_RESET",
        products: [],
      }
    );
  }

  if (asksForFutureStock(cleanQuestion)) {
    const answer =
      "Por ahora no tengo información confiable sobre fechas futuras de reabastecimiento. Puedo ayudarte a ubicar la pieza en el catálogo y ventas puede validar disponibilidad actual o próxima llegada.";

    await logAiSearch({
      question: cleanQuestion,
      intent: {
        gate_reason: "FUTURE_STOCK_NOT_AVAILABLE",
        modo_conversacion: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
      },
      candidates: [],
      recommended: [],
      service: "LOCAL_CONTROLADO",
      response: answer,
      origen,
    });

    return buildEmptyResult({
      intent: {
        gate_reason: "FUTURE_STOCK_NOT_AVAILABLE",
        modo_conversacion: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
      },
      sessionId: null,
      context: {},
      answer,
      service: "LOCAL_CONTROLADO",
      requiresMoreData: true,
      question: cleanQuestion,
      mode: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
    });
  }

  if (asksForBranchStock(cleanQuestion)) {
    const answer =
      "Puedo ayudarte a buscar la pieza en el catálogo, pero la disponibilidad final por sucursal debe validarla ventas. Escríbeme la pieza, código, marca, modelo, año y motor para ubicar el producto correcto.";

    await logAiSearch({
      question: cleanQuestion,
      intent: {
        gate_reason: "BRANCH_STOCK_NOT_AVAILABLE",
        modo_conversacion: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
      },
      candidates: [],
      recommended: [],
      service: "LOCAL_CONTROLADO",
      response: answer,
      origen,
    });

    return buildEmptyResult({
      intent: {
        gate_reason: "BRANCH_STOCK_NOT_AVAILABLE",
        modo_conversacion: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
      },
      sessionId: null,
      context: {},
      answer,
      service: "LOCAL_CONTROLADO",
      requiresMoreData: true,
      uestion: cleanQuestion,
      mode: CATALOG_CONVERSATION_MODES.STOCK_QUERY,
    });
  }

  const session = await getOrCreateSearchSession(rawSessionId);
  const rawIntent = await buildIntentWithSemanticNormalizer(cleanQuestion);
  const audience = detectAudienceLevel({
    question: cleanQuestion,
    intent: rawIntent,
  });
  rawIntent.nivel_usuario = audience.nivel_usuario;
  rawIntent.tono_respuesta = audience.tono_respuesta;
  rawIntent.audience_score = audience.score;
  const ignoreSessionContext = shouldIgnoreSessionContextForQuestion(rawIntent);

  const intent = ignoreSessionContext
    ? {
      ...rawIntent,
      contexto_sesion_aplicado: false,
      contexto_sesion_campos: [],
      contexto_sesion_previo: session.contexto,
      contexto_sesion_ignorado_por_exclusion: true,
    }
    : mergeSessionContextWithIntent(rawIntent, session.contexto);

  const route = routeCatalogConversation({
    question: cleanQuestion,
    intent,
    sessionContext: session.contexto,
  });

  if (route.mode !== CATALOG_CONVERSATION_MODES.PRODUCT_SEARCH && !route.shouldSearchCatalog) {
    return answerAdvisorMode({
      cleanQuestion,
      intent,
      route,
      session,
      ignoreSessionContext,
      origen,
    });
  }

  const gate = buildIntentGate({
    question: cleanQuestion,
    intent,
  });

  const sessionIntentForUpdate = {
    ...intent,
    modo_conversacion: CATALOG_CONVERSATION_MODES.PRODUCT_SEARCH,
    limpiar_pendiente_asesoria: gate.allowed,
  };

  const updatedContext = ignoreSessionContext
    ? {}
    : await updateSearchSessionContext({
      sessionId: session.session_id,
      previousContext: session.contexto,
      intent: sessionIntentForUpdate,
      question: cleanQuestion,
      origen,
    });

  const effectiveIntent = {
    ...intent,
    gate_reason: gate.reason,
    modo_busqueda: gate.mode || "COMPATIBILITY",
    modo_conversacion: route.mode,
    conversation_route: route,
    session_id: session.session_id,
    contexto_corto: updatedContext,
  };

  if (!gate.allowed) {
    let service = "LOCAL_CONTROLADO";
    let answer = gate.message;

    if (
      gate.reason === "VEHICLE_WITHOUT_PART" &&
      hasVehicleContext(updatedContext) &&
      Array.isArray(updatedContext.pendiente_sintomas) &&
      updatedContext.pendiente_sintomas.length
    ) {
      const advisorRoute = {
        mode: CATALOG_CONVERSATION_MODES.DIAGNOSTIC_GUIDE,
        reason: "PENDING_DIAGNOSTIC_CONTEXT",
        shouldSearchCatalog: false,
        requiresMoreData: true,
      };

      const advisorIntent = {
        ...effectiveIntent,
        gate_reason: advisorRoute.reason,
        modo_busqueda: advisorRoute.mode,
        modo_conversacion: advisorRoute.mode,
        conversation_route: advisorRoute,
      };

      answer = buildAdvisorLocalAnswer({
        mode: advisorRoute.mode,
        intent: advisorIntent,
        sessionContext: updatedContext,
      });
      service = "LOCAL_ASESOR_CONTROLADO";
    }

    await logAiSearch({
      question: cleanQuestion,
      intent: {
        ...effectiveIntent,
        gate_reason: gate.reason,
      },
      candidates: [],
      recommended: [],
      service,
      response: answer,
      origen,
    });

    const blockedIntent = {
      ...intent,
      gate_reason: gate.reason,
      modo_conversacion: route.mode,
      conversation_route: route,
    };

    return buildEmptyResult({
      intent: blockedIntent,
      sessionId: session.session_id,
      context: updatedContext,
      answer,
      service,
      requiresMoreData: true,
      question: cleanQuestion,
      mode: route.mode,
    });
  }

  return runProductSearch({
    cleanQuestion,
    effectiveIntent,
    origen,
  });
}