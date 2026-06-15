export function shouldIgnoreSessionContextForQuestion(rawIntent = {}) {
  const vehicleExclusions =
    Array.isArray(rawIntent.excluded_vehicle_tokens)
      ? rawIntent.excluded_vehicle_tokens
      : Array.isArray(rawIntent.excluded_tokens)
        ? rawIntent.excluded_tokens
        : [];

  /**
   * Solo ignoramos contexto cuando la exclusión es de vehículo/aplicación.
   */
  return vehicleExclusions.length > 0;
}

