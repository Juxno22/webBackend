# catalog-ai

Estructura preparada para el siguiente paso.

La separación de `aiProvider.service.js` ya está lista y mantiene compatibilidad con `aiCatalog.service.js`.

Después de validar que el backend arranca igual, el siguiente bloque será dividir `aiCatalog.service.js` en módulos:

- `catalogIntentLocal.service.js`
- `catalogIntentRouter.service.js`
- `catalogSearch.service.js`
- `catalogScoring.service.js`
- `catalogFormatter.service.js`
- `catalogAdvisor.service.js`
- `catalogComparison.service.js`

No se movió todavía la lógica de catálogo para evitar romper el flujo actual antes de probar la primera separación.
