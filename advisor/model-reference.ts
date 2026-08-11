/**
 * The `provider/id` string that names an advisor model.
 *
 * One format with three uses that have to agree: the string `/advisor` offers and
 * saves, the pattern `config.ts` validates a stored reference against, and the
 * parse that turns a stored reference back into a registry lookup. Before this
 * module they were three separate literals in two files, so a change to any one
 * of them silently broke the round trip.
 *
 * Pure, and free of `@earendil-works/*` (S2): the parameter types below are
 * structural, so pi's `Model<Api>` satisfies them without being imported.
 */

/** The part of a model this format reads. `Model<Api>` satisfies it structurally. */
export interface ModelReference {
	provider: string;
	id: string;
}

/**
 * What a *stored* reference must look like: exactly two non-empty segments with
 * no whitespace. `config.ts` rejects a configuration whose model fails this.
 *
 * Deliberately stricter than `parseModel` — see the note there.
 */
export const MODEL_REFERENCE_PATTERN = /^[^/\s]+\/[^/\s]+$/;

export function modelName(model: ModelReference): string {
	return `${model.provider}/${model.id}`;
}

/**
 * Split a reference at its *first* slash, so `a/b/c` yields provider `a`, id
 * `b/c`.
 *
 * That tolerance is currently unreachable rather than load-bearing, and the
 * distinction is worth stating: the only caller parses `config.model`, which
 * `validateConfig` has already matched against `MODEL_REFERENCE_PATTERN`, and
 * every string that pattern admits holds exactly one slash. So splitting at the
 * first slash and splitting at the last are indistinguishable in production.
 * Measured, not assumed — a mutation swapping the two produced zero divergences
 * across the entrypoint's whole surface.
 *
 * The consequence is a real if separate limitation: a provider whose ids contain
 * slashes (Vertex's `publishers/google/…`) cannot be stored as an advisor model
 * at all, because the pattern rejects the reference before the parse is reached.
 * Pre-existing, and widening the pattern is a behaviour change (§19).
 */
export function parseModel(value: string): [string, string] | undefined {
	const slash = value.indexOf("/");
	return slash > 0 && slash < value.length - 1 ? [value.slice(0, slash), value.slice(slash + 1)] : undefined;
}
