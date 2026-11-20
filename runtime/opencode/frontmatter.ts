/** Small helpers shared by the vendored OpenCode runtime modules. No dependencies. */

export const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);

export interface Frontmatter {
	/** The value of a `key: value` line in the front matter, trimmed; undefined when the key is absent or empty. */
	field(key: string): string | undefined;
	/** The text after the closing `---`. */
	body: string;
}

/** Splits `---` front matter from the body. Undefined when the text does not start with a front-matter block. */
export function parseFrontmatter(text: string): Frontmatter | undefined {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(text);
	if (!match) return undefined;
	const head = match[1] ?? "";
	return {
		field: (key) => head.match(new RegExp(`^${key}:\\s*(.+?)\\s*$`, "m"))?.[1],
		body: match[2] ?? "",
	};
}
