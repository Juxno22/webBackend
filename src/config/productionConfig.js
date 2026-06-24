const LOCALHOST_PATTERN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i;

const LOCAL_DEV_CORS_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
];

function shouldAllowLocalCors() {
  return (
    process.env.NODE_ENV !== "production" ||
    process.env.CORS_ALLOW_LOCALHOST === "true" ||
    process.env.ALLOW_LOCALHOST_CORS === "true"
  );
}

function splitCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export function normalizePublicUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";

  try {
    const url = new URL(raw);
    if (!["http:", "https:"].includes(url.protocol)) return "";
    url.hash = "";
    url.search = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

export function isValidPublicHttpUrl(value) {
  return Boolean(normalizePublicUrl(value));
}

export function getConfiguredPublicUrls() {
  const frontendUrl = normalizePublicUrl(
    process.env.FRONTEND_URL ||
    process.env.PUBLIC_FRONTEND_URL ||
    process.env.NEXT_PUBLIC_SITE_URL ||
    process.env.SITE_URL ||
    ""
  );

  const backendUrl = normalizePublicUrl(
    process.env.BACKEND_URL ||
    process.env.PUBLIC_BACKEND_URL ||
    process.env.NEXT_PUBLIC_API_URL ||
    process.env.API_URL ||
    ""
  );

  const siteUrl = normalizePublicUrl(process.env.NEXT_PUBLIC_SITE_URL || process.env.SITE_URL || frontendUrl || "");

  return { frontendUrl, backendUrl, siteUrl };
}

export function getAllowedCorsOrigins() {
  const { frontendUrl, siteUrl } = getConfiguredPublicUrls();

  const configured = [
    ...splitCsv(process.env.CORS_ORIGIN),
    ...splitCsv(process.env.CORS_ORIGINS),
    frontendUrl,
    siteUrl,
    ...(shouldAllowLocalCors() ? LOCAL_DEV_CORS_ORIGINS : []),
  ]
    .map(normalizePublicUrl)
    .filter(Boolean);

  return [...new Set(configured)];
}

export function isAllowedCorsOrigin(origin) {
  if (!origin) return true;

  const normalizedOrigin = normalizePublicUrl(origin);
  if (!normalizedOrigin) return false;

  const allowedOrigins = getAllowedCorsOrigins();
  if (allowedOrigins.includes(normalizedOrigin)) return true;

  if (shouldAllowLocalCors() && LOCALHOST_PATTERN.test(normalizedOrigin)) {
    return true;
  }

  return false;
}

export function buildCorsOptions() {
  return {
    credentials: true,
    optionsSuccessStatus: 204,
    origin(origin, callback) {
      if (isAllowedCorsOrigin(origin)) {
        callback(null, true);
        return;
      }

      const error = new Error(`Origen no permitido por CORS: ${origin}`);
      error.status = 403;
      callback(error);
    },
  };
}

export function getProductionHelmetOptions() {
  const allowedOrigins = getAllowedCorsOrigins();
  const connectSources = ["'self'", ...allowedOrigins];
  const imgSources = ["'self'", "data:", "blob:", "https://res.cloudinary.com"];

  return {
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        "default-src": ["'self'"],
        "img-src": imgSources,
        "connect-src": connectSources,
      },
    },
  };
}

export function getProductionConfigSnapshot() {
  const publicUrls = getConfiguredPublicUrls();
  const allowedOrigins = getAllowedCorsOrigins();
  const nodeEnv = process.env.NODE_ENV || "development";
  const jwtSecret = process.env.JWT_SECRET || "";

  const aiProviders = {
    openrouter: Boolean(process.env.OPENROUTER_API_KEY),
    cerebras: Boolean(process.env.CEREBRAS_API_KEY),
    gemini: Boolean(process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY),
    groq: Boolean(process.env.GROQ_API_KEY),
    mistral: Boolean(process.env.MISTRAL_API_KEY),
    huggingface: Boolean(process.env.HUGGINGFACE_API_KEY || process.env.HF_TOKEN),
  };

  return {
    node_env: nodeEnv,
    is_production: nodeEnv === "production",
    allowed_cors_origins: allowedOrigins,
    cors_origin_configured: Boolean(process.env.CORS_ORIGIN || process.env.CORS_ORIGINS),
    public_urls: publicUrls,
    public_urls_valid: {
      frontend: Boolean(publicUrls.frontendUrl),
      backend: Boolean(publicUrls.backendUrl),
      site: Boolean(publicUrls.siteUrl),
    },
    jwt_secret: {
      configured: Boolean(jwtSecret),
      length: jwtSecret.length,
      strong: jwtSecret.length >= 32,
    },
    cloudinary: {
      cloud_name: Boolean(process.env.CLOUDINARY_CLOUD_NAME),
      api_key: Boolean(process.env.CLOUDINARY_API_KEY),
      api_secret: Boolean(process.env.CLOUDINARY_API_SECRET),
      fully_configured: Boolean(
        process.env.CLOUDINARY_CLOUD_NAME &&
        process.env.CLOUDINARY_API_KEY &&
        process.env.CLOUDINARY_API_SECRET
      ),
    },
    ai_providers: aiProviders,
    ai_provider_count: Object.values(aiProviders).filter(Boolean).length,
  };
}
