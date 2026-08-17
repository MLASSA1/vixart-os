/**
 * Stands in for the `server-only` package under Vitest.
 *
 * The real package throws on import to stop server code reaching a client
 * bundle. Tests run in Node, so there is no client bundle to protect and the
 * guard would only make the module untestable.
 */
export {};
