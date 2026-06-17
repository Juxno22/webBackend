import { normalizeText } from "../../utils/normalize.js";

const COOLING_PART_SUGGESTIONS = [
    "Termostato",
    "Bomba de agua",
    "Radiador",
    "Manguera",
    "Tapón",
    "Depósito",
    "Sensor de temperatura",
    "Ventilador",
];

const COOLING_SYMPTOM_QUICK_REPLIES = [
    "Se calienta en tráfico",
    "Se calienta en subida",
    "Se calienta con clima",
    "Tira anticongelante",
    "No prende el ventilador",
];

function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
}

function hasVehicle(intent = {}) {
    return Boolean(
        hasValue(intent.marca_auto) ||
        hasValue(intent.modelo_auto) ||
        hasValue(intent.anio) ||
        hasValue(intent.motor)
    );
}

function hasCompleteBasicVehicle(intent = {}) {
    return Boolean(
        hasValue(intent.marca_auto) &&
        hasValue(intent.modelo_auto) &&
        hasValue(intent.anio)
    );
}

function hasProductTerm(intent = {}) {
    return Boolean(
        (Array.isArray(intent.terminos_producto_detectados) &&
            intent.terminos_producto_detectados.length > 0) ||
        (Array.isArray(intent.product_query_tokens) &&
            intent.product_query_tokens.length > 0) ||
        (Array.isArray(intent.strict_product_family_tokens) &&
            intent.strict_product_family_tokens.length > 0)
    );
}

function hasPartNumber(intent = {}) {
    return (
        Array.isArray(intent.numero_parte_tokens) &&
        intent.numero_parte_tokens.length > 0
    );
}

function hasMeasurements(intent = {}) {
    return (
        Array.isArray(intent.medidas_detectadas) &&
        intent.medidas_detectadas.length > 0
    );
}

function getSymptomKeys(intent = {}) {
    return Array.isArray(intent.sintomas_detectados)
        ? intent.sintomas_detectados.map((item) => item.key).filter(Boolean)
        : [];
}

function getMode(intent = {}, mode = null) {
    return (
        mode ||
        intent.modo_conversacion ||
        intent.modo_busqueda ||
        intent.gate_reason ||
        "PRODUCT_SEARCH"
    );
}

function buildMissingVehicleFields(intent = {}, { includeMotor = false } = {}) {
    const missing = [];

    if (!hasValue(intent.marca_auto)) missing.push("marca_auto");
    if (!hasValue(intent.modelo_auto)) missing.push("modelo_auto");
    if (!hasValue(intent.anio)) missing.push("anio");

    if (includeMotor && !hasValue(intent.motor)) {
        missing.push("motor");
    }

    return missing;
}

function describeVehicleBase(intent = {}) {
    return [intent.marca_auto, intent.modelo_auto, intent.anio]
        .filter(Boolean)
        .join(" ")
        .trim();
}

function buildVehicleMissingQuestions(intent = {}, missing = []) {
    const missingSet = new Set(missing);
    const questions = [];
    const vehicleBase = describeVehicleBase(intent);
    const modelOrBrand = [intent.marca_auto, intent.modelo_auto].filter(Boolean).join(" ").trim();

    const needsMarca = missingSet.has("marca_auto");
    const needsModelo = missingSet.has("modelo_auto");
    const needsAnio = missingSet.has("anio");
    const needsMotor = missingSet.has("motor");

    if (needsMarca && needsModelo && needsAnio) {
        questions.push("¿Qué marca, modelo y año es tu vehículo?");
    } else if (needsMarca && needsModelo) {
        questions.push("¿Qué marca y modelo es tu vehículo?");
    } else if (needsModelo && needsAnio && intent.marca_auto) {
        questions.push(`¿Qué modelo y año es tu ${intent.marca_auto}?`);
    } else if (needsMarca && needsAnio && intent.modelo_auto) {
        questions.push(`¿Qué marca y año es tu ${intent.modelo_auto}?`);
    } else if (needsMarca) {
        questions.push("¿Qué marca es tu vehículo?");
    } else if (needsModelo) {
        questions.push(intent.marca_auto ? `¿Qué modelo es tu ${intent.marca_auto}?` : "¿Qué modelo es tu vehículo?");
    } else if (needsAnio) {
        questions.push(modelOrBrand ? `¿Qué año es tu ${modelOrBrand}?` : "¿Qué año es tu vehículo?");
    }

    if (needsMotor) {
        questions.push(vehicleBase ? `¿Qué motor trae tu ${vehicleBase}?` : "¿Qué motor trae?");
    }

    return questions;
}

function compactMissingVehicle(missing = []) {
    const missingSet = new Set(missing);

    if (
        missingSet.has("marca_auto") ||
        missingSet.has("modelo_auto") ||
        missingSet.has("anio")
    ) {
        return [
            "vehiculo",
            ...(missingSet.has("motor") ? ["motor"] : []),
        ];
    }

    return missing;
}

function normalizeReplies(values = []) {
    return [...new Set(values.map((item) => String(item).trim()).filter(Boolean))]
        .slice(0, 6);
}

function isBeginner(intent = {}) {
    return intent.nivel_usuario === "PRINCIPIANTE";
}

function getAdvisorTurns(intent = {}) {
    return Number(
        intent.asesor_turnos ||
        intent.contexto_corto?.asesor_turnos ||
        0
    );
}

function hasIntentTerm(intent = {}, pattern) {
    const values = [
        intent.pregunta_normalizada,
        ...(Array.isArray(intent.terminos_producto_detectados)
            ? intent.terminos_producto_detectados
            : []),
        ...(Array.isArray(intent.product_query_tokens)
            ? intent.product_query_tokens
            : []),
    ];

    return values.some((value) => pattern.test(String(value || "").toUpperCase()));
}

function isUpperHoseSearchWithoutProducts({ intent = {}, products = [] } = {}) {
    return (
        (!Array.isArray(products) || products.length === 0) &&
        hasIntentTerm(intent, /\bMANGUERA\b/) &&
        Array.isArray(intent.posiciones_detectadas) &&
        intent.posiciones_detectadas.includes("SUPERIOR")
    );
}

function buildVehicleBaseText(intent = {}) {
    return [intent.marca_auto, intent.modelo_auto].filter(Boolean).join(" ");
}

function makeFollowup({
    requiereSeguimiento = false,
    bloqueante = false,
    siguienteAccion = "NONE",
    datosFaltantes = [],
    preguntas = [],
    respuestasRapidas = [],
    maxPreguntas = 2,
} = {}) {
    return {
        requiere_seguimiento: Boolean(requiereSeguimiento),
        bloqueante: Boolean(bloqueante),
        siguiente_accion: siguienteAccion,
        datos_faltantes: [...new Set(datosFaltantes)].filter(Boolean),
        preguntas_seguimiento: normalizeReplies(preguntas).slice(0, maxPreguntas),
        respuestas_rapidas: normalizeReplies(respuestasRapidas),
    };
}

function buildDiagnosticFollowup({ intent = {} } = {}) {
    const symptomKeys = getSymptomKeys(intent);
    const level = intent.nivel_usuario || "INTERMEDIO";
    const beginner = isBeginner(intent);
    const advisorTurns = getAdvisorTurns(intent);

    const hasFanNotWorking = symptomKeys.includes("FAN_NOT_WORKING");
    const hasOverheat = symptomKeys.includes("COOLING_OVERHEAT");
    const hasLeak = symptomKeys.includes("COOLING_LEAK");
    const hasNoStart = symptomKeys.includes("NO_START");

    const missingVehicleFields = buildMissingVehicleFields(intent, {
        includeMotor: level === "MECANICO",
    });

    const missingVehicle = compactMissingVehicle(missingVehicleFields);
    const vehicleQuestions = buildVehicleMissingQuestions(intent, missingVehicleFields);

    if (beginner && advisorTurns >= 2) {
        return makeFollowup({
            requiereSeguimiento: true,
            bloqueante: false,
            siguienteAccion: "SHOW_GUIDED_PART_OPTIONS",
            datosFaltantes: missingVehicle.length ? missingVehicle : [],
            preguntas: missingVehicle.length
                ? [
                    vehicleQuestions[0],
                    "Si no tienes ese dato, podemos validar con ventas usando foto o muestra física.",
                ]
                : [
                    "Puedo mostrar opciones comunes para validar con ventas.",
                ],
            respuestasRapidas: [
                "Buscar termostato",
                "Buscar bomba de agua",
                "Buscar tapón",
                "Buscar radiador",
                "Buscar manguera",
                "Buscar ventilador",
            ],
            maxPreguntas: 2,
        });
    }

    if (beginner) {
        return makeFollowup({
            requiereSeguimiento: true,
            bloqueante: missingVehicle.length > 0,
            siguienteAccion: "ASK_BASIC_VEHICLE",
            datosFaltantes: missingVehicle.length ? missingVehicle : ["detalle_sintoma"],
            preguntas: missingVehicle.length
                ? [
                    vehicleQuestions[0] || "¿Qué marca, modelo y año es tu vehículo?",
                ]
                : [
                    hasFanNotWorking
                        ? "¿El ventilador no prende nunca o prende muy tarde?"
                        : hasLeak
                            ? "¿Tira líquido por manguera, radiador, depósito o debajo del motor?"
                            : hasOverheat
                                ? "¿Se calienta en tráfico, carretera, subida o después de manejar?"
                                : hasNoStart
                                    ? "¿Da marcha o no hace nada?"
                                    : "¿Qué síntoma principal presenta?",
                ],
            respuestasRapidas: missingVehicle.length
                ? []
                : hasFanNotWorking
                    ? ["No prende nunca", "Prende muy tarde", "Se calienta en tráfico"]
                    : hasOverheat || hasLeak
                        ? COOLING_SYMPTOM_QUICK_REPLIES
                        : [],
            maxPreguntas: 1,
        });
    }

    const preguntas = [
        ...vehicleQuestions,
    ];

    if (hasFanNotWorking) {
        preguntas.push("¿El ventilador no prende nunca, solo prende con clima o prende muy tarde?");
    } else if (hasOverheat) {
        preguntas.push("¿Se calienta en tráfico, subida, carretera o con clima?");
    } else if (hasLeak) {
        preguntas.push("¿De dónde tira el líquido: frente, depósito, manguera o debajo del motor?");
    } else if (hasNoStart) {
        preguntas.push("¿Da marcha, prende y se apaga, o no hace nada?");
    } else {
        preguntas.push("¿Qué síntoma principal presenta?");
    }

    return makeFollowup({
        requiereSeguimiento: true,
        bloqueante: true,
        siguienteAccion: "ASK_DIAGNOSTIC_DETAILS",
        datosFaltantes: missingVehicle.length ? missingVehicle : ["detalle_sintoma"],
        preguntas,
        respuestasRapidas: hasFanNotWorking
            ? [
                "No prende nunca",
                "Prende con clima",
                "Prende muy tarde",
                "Se calienta en tráfico",
            ]
            : hasOverheat || hasLeak
                ? COOLING_SYMPTOM_QUICK_REPLIES
                : hasNoStart
                    ? [
                        "Da marcha pero no prende",
                        "No hace nada",
                        "Prende y se apaga",
                        "Hace ruido",
                    ]
                    : [
                        "Se calienta en tráfico",
                        "Tira anticongelante",
                        "Hace ruido",
                    ],
        maxPreguntas: 2,
    });
}

function buildVehicleWithoutPartFollowup({ intent = {} } = {}) {
    return makeFollowup({
        requiereSeguimiento: true,
        bloqueante: true,
        siguienteAccion: "ASK_PART",
        datosFaltantes: ["pieza"],
        preguntas: [
            "¿Qué pieza necesitas para ese vehículo?",
            "Puede ser termostato, bomba de agua, radiador, manguera, tapón o número de parte.",
        ],
        respuestasRapidas: COOLING_PART_SUGGESTIONS,
    });
}

function buildProductSearchFollowup({ intent = {}, products = [] } = {}) {

    if (isUpperHoseSearchWithoutProducts({ intent, products })) {
        const vehicleText = buildVehicleBaseText(intent);

        return makeFollowup({
            requiereSeguimiento: true,
            bloqueante: true,
            siguienteAccion: "ASK_YEAR_ONLY",
            datosFaltantes: ["anio"],
            preguntas: [
                vehicleText
                    ? `¿Qué año es tu ${vehicleText}?`
                    : "¿Qué año es tu vehículo?",
            ],
            respuestasRapidas: [],
            maxPreguntas: 1,
        });
    }
    
    if (products.length > 0) {
        return makeFollowup({
            requiereSeguimiento: false,
            bloqueante: false,
            siguienteAccion: "SHOW_PRODUCTS",
            datosFaltantes: [],
            preguntas: [],
            respuestasRapidas: [],
        });
    }

    const missingVehicleFields = buildMissingVehicleFields(intent, {
        includeMotor: intent.nivel_usuario === "MECANICO" || "INTERMEDIO",
    });

    const missingVehicle = compactMissingVehicle(missingVehicleFields);

    const missing = [];

    if (!hasProductTerm(intent) && !hasPartNumber(intent)) {
        missing.push("pieza");
    }

    missing.push(...missingVehicle);

    const vehicleQuestions = buildVehicleMissingQuestions(intent, missingVehicleFields);

    return makeFollowup({
        requiereSeguimiento: missing.length > 0,
        bloqueante: missing.length > 0,
        siguienteAccion: missing.includes("pieza")
            ? "ASK_PART"
            : "ASK_VEHICLE",
        datosFaltantes: missing,
        preguntas: [
            missing.includes("pieza")
                ? "¿Qué pieza necesitas buscar?"
                : null,
            ...vehicleQuestions,
        ].filter(Boolean),
        respuestasRapidas: missing.includes("pieza")
            ? COOLING_PART_SUGGESTIONS
            : [],
    });
}

function buildCompatibilityFollowup({ intent = {}, products = [] } = {}) {
    const missingVehicleFields = buildMissingVehicleFields(intent, {
        includeMotor: intent.nivel_usuario === "MECANICO" || "INTERMEDIO",
    });
    const missingVehicle = compactMissingVehicle(missingVehicleFields);
    const missing = [...missingVehicle];

    if (!hasPartNumber(intent) && !hasProductTerm(intent) && products.length === 0) {
        missing.push("pieza_o_codigo");
    }

    const vehicleQuestions = buildVehicleMissingQuestions(intent, missingVehicleFields);

    return makeFollowup({
        requiereSeguimiento: missing.length > 0,
        bloqueante: missing.length > 0,
        siguienteAccion: missing.includes("pieza_o_codigo")
            ? "ASK_PRODUCT_OR_CODE"
            : "ASK_COMPATIBILITY_DATA",
        datosFaltantes: missing,
        preguntas: [
            missing.includes("pieza_o_codigo")
                ? "¿Qué pieza o código quieres validar?"
                : null,
            ...vehicleQuestions,
        ].filter(Boolean),
        respuestasRapidas: [
            "Validar por aplicación",
            "Validar por código",
            "Validar por medida",
        ],
    });
}

function buildCrossApplicationFollowup({ intent = {} } = {}) {
    const crossData = intent.comparacion_aplicacion || {};
    const target = crossData.vehiculo_objetivo || {};
    const donor = crossData.vehiculo_donante || {};

    const targetText = [target.marca, target.modelo].filter(Boolean).join(" ");
    const donorText = [donor.marca, donor.modelo].filter(Boolean).join(" ");

    return makeFollowup({
        requiereSeguimiento: true,
        bloqueante: false,
        siguienteAccion: "ASK_CROSS_APPLICATION_DATA",
        datosFaltantes: ["anio_motor_codigo"],
        preguntas: [
            targetText
                ? `¿Qué año y motor es tu ${targetText}?`
                : "¿Qué año y motor es tu vehículo?",
            donorText
                ? `¿Tienes el código o foto de la pieza del ${donorText}?`
                : "¿Tienes el código o foto de la pieza que quieres comparar?",
        ],
        respuestasRapidas: [
            "Validar por código",
            "Validar por aplicación",
            "Validar por muestra física",
        ],
    });
}

function buildComparisonFollowup({ intent = {}, products = [] } = {}) {
    if (products.length >= 2) {
        return makeFollowup({
            requiereSeguimiento: false,
            bloqueante: false,
            siguienteAccion: "COMPARE_PRODUCTS",
            datosFaltantes: [],
            preguntas: [
                "¿Quieres que comparemos por aplicación, precio, marca o medidas?",
            ],
            respuestasRapidas: [
                "Comparar por aplicación",
                "Comparar por precio",
                "Comparar por marca",
                "Comparar por medidas",
            ],
        });
    }

    const missing = [];

    if (!hasPartNumber(intent) && !hasMeasurements(intent) && products.length < 2) {
        missing.push("productos_a_comparar");
    }

    return makeFollowup({
        requiereSeguimiento: true,
        bloqueante: true,
        siguienteAccion: "ASK_COMPARISON_ITEMS",
        datosFaltantes: missing,
        preguntas: [
            "¿Qué dos piezas, códigos o medidas quieres comparar?",
        ],
        respuestasRapidas: [
            "Comparar dos códigos",
            "Comparar por medida",
            "Comparar por aplicación",
        ],
    });
}

function buildStockFollowup({ intent = {} } = {}) {
    const missing = [];

    if (!hasProductTerm(intent) && !hasPartNumber(intent)) {
        missing.push("pieza");
    }

    const missingVehicleFields = buildMissingVehicleFields(intent, {
        includeMotor: false,
    });
    const missingVehicle = compactMissingVehicle(missingVehicleFields);

    missing.push(...missingVehicle);

    const vehicleQuestions = buildVehicleMissingQuestions(intent, missingVehicleFields);

    return makeFollowup({
        requiereSeguimiento: true,
        bloqueante: missing.length > 0,
        siguienteAccion: "ASK_STOCK_DATA",
        datosFaltantes: missing,
        preguntas: [
            missing.includes("pieza")
                ? "¿Qué pieza quieres validar?"
                : null,
            ...vehicleQuestions,
        ].filter(Boolean),
        respuestasRapidas: [
            "Validar disponibilidad",
            "Agregar datos del vehículo",
            "Buscar por código",
        ],
    });
}

export function buildCatalogFollowup({
    question,
    intent = {},
    mode = null,
    products = [],
} = {}) {
    const detectedMode = getMode(intent, mode);
    const gateReason = intent.gate_reason || "";
    const normalizedQuestion = normalizeText(question);
    const hasProducts = Array.isArray(products) && products.length > 0;

    if (gateReason === "PRODUCT_CONCEPT_EXPLANATION") {
        return makeFollowup({
            requiereSeguimiento: false,
            bloqueante: false,
            siguienteAccion: "NONE",
            datosFaltantes: [],
            preguntas: [],
            respuestasRapidas: [],
        });
    }

    if (hasProducts) {
        return makeFollowup({
            requiereSeguimiento: false,
            bloqueante: false,
            siguienteAccion: "SHOW_PRODUCTS",
            datosFaltantes: [],
            preguntas: [],
            respuestasRapidas: [],
        });
    }

    if (gateReason === "SESSION_CONTEXT_RESET") {
        return makeFollowup({
            requiereSeguimiento: true,
            bloqueante: true,
            siguienteAccion: "ASK_NEW_CONTEXT",
            datosFaltantes: ["vehiculo_o_pieza"],
            preguntas: [
                "¿Qué nuevo vehículo o pieza quieres buscar?",
            ],
            respuestasRapidas: COOLING_PART_SUGGESTIONS,
        });
    }

    if (
        detectedMode === "DIAGNOSTIC_GUIDE" ||
        gateReason === "DIAGNOSTIC_SYMPTOM_WITHOUT_VEHICLE" ||
        gateReason === "TOO_BROAD_SYMPTOM"
    ) {
        return buildDiagnosticFollowup({ intent });
    }

    if (gateReason === "VEHICLE_WITHOUT_PART") {
        return buildVehicleWithoutPartFollowup({ intent });
    }

    if (
        detectedMode === "COMPATIBILITY_EXPLANATION" ||
        normalizedQuestion.includes("COMPATIBLE") ||
        normalizedQuestion.includes("APLICA") ||
        normalizedQuestion.includes("LE QUEDA")
    ) {
        return buildCompatibilityFollowup({ intent, products });
    }

    if (
        intent.comparacion_aplicacion?.activa ||
        intent.conversation_route?.reason === "CROSS_APPLICATION_COMPARISON"
    ) {
        return buildCrossApplicationFollowup({ intent });
    }

    if (
        detectedMode === "PRODUCT_COMPARISON" ||
        detectedMode === "COMPARISON_GUIDE"
    ) {
        return buildComparisonFollowup({ intent, products });
    }

    if (
        detectedMode === "STOCK_QUERY" ||
        gateReason === "BRANCH_STOCK_NOT_AVAILABLE" ||
        gateReason === "FUTURE_STOCK_NOT_AVAILABLE"
    ) {
        return buildStockFollowup({ intent });
    }

    return buildProductSearchFollowup({ intent, products });
}

export function addFollowupToCatalogResult(
    result = {},
    { question, intent = {}, mode = null, products = [] } = {}
) {
    const context = result.contexto_corto || {};
    const intentWithContext = {
        ...context,
        ...intent,
        marca_auto: intent.marca_auto || context.marca_auto,
        modelo_auto: intent.modelo_auto || context.modelo_auto,
        anio: intent.anio || context.anio,
        motor: intent.motor || context.motor,
    };

    const finalProducts = products.length ? products : result.productos || [];

    const followup = buildCatalogFollowup({
        question,
        intent: intentWithContext,
        mode,
        products: finalProducts,
    });

    return {
        ...result,
        intencion: {
            ...(result.intencion || intent),
            contexto_corto: context,
        },
        seguimiento: followup,
        requiere_mas_datos: Boolean(
            result.requiere_mas_datos || followup.bloqueante
        ),
    };
}