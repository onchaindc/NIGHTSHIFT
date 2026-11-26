/**
 * Deploy marker: surfaced by GET /api/tasks so it can be verified from outside
 * whether a given commit is actually serving (a failed build leaves the previous
 * deployment live, which must never be mistaken for the fix being deployed).
 */
export const BUILD_MARKER = "checkpoints-sse-budget";
