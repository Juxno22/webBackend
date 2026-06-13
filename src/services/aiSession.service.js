import crypto from "crypto";
import { pool } from "../config/db.js";
import { normalizeText } from "../utils/normalize.js";

const SESSION_TTL_DAYS = 7;

function cleanString(value) {
    if (value === undefined || value === null) return "";
    return String(value).trim();
}

function generateSessionId() {
    return crypto.randomUUID();
}

function sanitizeSessionId(value) {
    const clean = cleanString(value);

    if (!clean) return generateSessionId();

    const safe = clean.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);

    return safe || generateSessionId();
}

function buildExpiresAt() {
    const expires = new Date(Date.now() + SESSION_TTL_DAYS * 24 * 60 * 60 * 1000);

    return expires.toISOString().slice(0, 19).replace("T", " ");
}

function safeJsonParse(value) {
    try {
        if (!value) return {};
        if (typeof value === "object") return value;

        return JSON.parse(value);
    } catch {
        return {};
    }
}

function hasValue(value) {
    return value !== undefined && value !== null && String(value).trim() !== "";
}

function normalizeYear(value) {
    const year = Number(value);

    if (!Number.isFinite(year)) return null;
    if (year < 1900 || year > 2049) return null;

    return year;
}

export function shouldResetSearchSession(question) {
    const text = normalizeText(question);

    return (
        /\bOLVIDA\b.*\bAUTO\b/.test(text) ||
        /\bOLVIDA\b.*\bCARRO\b/.test(text) ||
        /\bBORRA\b.*\bAUTO\b/.test(text) ||
        /\bBORRA\b.*\bCARRO\b/.test(text) ||
        /\bCAMBIAR\b.*\bVEHICULO\b/.test(text) ||
        /\bCAMBIAR\b.*\bVEHÍCULO\b/.test(text) ||
        /\bNUEVO\b.*\bAUTO\b/.test(text) ||
        /\bNUEVO\b.*\bCARRO\b/.test(text)
    );
}

export async function resetSearchSession(rawSessionId) {
    const sessionId = sanitizeSessionId(rawSessionId);

    await pool.query(
        `
    DELETE FROM ia_sesiones_busqueda
    WHERE session_id = ?
    `,
        [sessionId]
    );

    return sessionId;
}

export async function getOrCreateSearchSession(rawSessionId) {
    const sessionId = sanitizeSessionId(rawSessionId);

    const [rows] = await pool.query(
        `
    SELECT session_id, contexto_json, expires_at
    FROM ia_sesiones_busqueda
    WHERE session_id = ?
      AND expires_at > NOW()
    LIMIT 1
    `,
        [sessionId]
    );

    if (!rows.length) {
        return {
            session_id: sessionId,
            contexto: {},
            is_new: true,
        };
    }

    return {
        session_id: sessionId,
        contexto: safeJsonParse(rows[0].contexto_json),
        is_new: false,
    };
}

export function extractContextFromIntent(intent = {}) {
    const context = {};

    if (hasValue(intent.marca_auto)) {
        context.marca_auto = cleanString(intent.marca_auto).toUpperCase();
    }

    if (hasValue(intent.modelo_auto)) {
        context.modelo_auto = cleanString(intent.modelo_auto).toUpperCase();
    }

    const year = normalizeYear(intent.anio);
    if (year) {
        context.anio = year;
    }

    if (hasValue(intent.motor) && !intent.motor_ambiguo) {
        context.motor = cleanString(intent.motor).toUpperCase();
    }

    if (Array.isArray(intent.motores_posibles) && intent.motores_posibles.length) {
        context.motores_posibles = intent.motores_posibles;
    }

    return context;
}

export function hasVehicleContext(context = {}) {
    return Boolean(
        context.marca_auto ||
        context.modelo_auto ||
        context.anio ||
        context.motor
    );
}

export function mergeSessionContextWithIntent(intent = {}, sessionContext = {}) {
    const hasCurrentMarca = hasValue(intent.marca_auto);
    const hasCurrentModelo = hasValue(intent.modelo_auto);
    const hasCurrentAnio = hasValue(intent.anio);
    const hasCurrentMotor = hasValue(intent.motor);

    const merged = {
        ...intent,
        marca_auto: hasCurrentMarca ? intent.marca_auto : sessionContext.marca_auto || null,
        modelo_auto: hasCurrentModelo ? intent.modelo_auto : sessionContext.modelo_auto || null,
        anio: hasCurrentAnio ? intent.anio : sessionContext.anio || null,
        motor: hasCurrentMotor ? intent.motor : sessionContext.motor || null,
    };

    const applied = [];

    if (!hasCurrentMarca && sessionContext.marca_auto) applied.push("marca_auto");
    if (!hasCurrentModelo && sessionContext.modelo_auto) applied.push("modelo_auto");
    if (!hasCurrentAnio && sessionContext.anio) applied.push("anio");
    if (!hasCurrentMotor && sessionContext.motor) applied.push("motor");

    return {
        ...merged,
        contexto_sesion_aplicado: applied.length > 0,
        contexto_sesion_campos: applied,
        contexto_sesion_previo: sessionContext,
    };
}

export async function updateSearchSessionContext({
    sessionId,
    previousContext = {},
    intent = {},
    question,
    origen,
}) {
    const extracted = extractContextFromIntent(intent);

    const nextContext = {
        ...previousContext,
        ...extracted,
    };

    const hasContext = hasVehicleContext(nextContext);

    if (!hasContext) {
        return nextContext;
    }

    await pool.query(
        `
    INSERT INTO ia_sesiones_busqueda
      (session_id, contexto_json, last_question, origen, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE
      contexto_json = VALUES(contexto_json),
      last_question = VALUES(last_question),
      origen = VALUES(origen),
      expires_at = VALUES(expires_at),
      updated_at = CURRENT_TIMESTAMP
    `,
        [
            sessionId,
            JSON.stringify(nextContext),
            cleanString(question).slice(0, 1000),
            cleanString(origen) || "CHAT_PUBLICO",
            buildExpiresAt(),
        ]
    );

    return nextContext;
}

export function buildVehicleContextText(context = {}) {
    const parts = [
        context.marca_auto,
        context.modelo_auto,
        context.anio,
        context.motor,
    ].filter(Boolean);

    return parts.join(" ");
}