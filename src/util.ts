export function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function nonEmptyString(where: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail(where, `"${field}" must be a non-empty string`)
  return value
}

/** An absolute http(s) URL. Claude's manifest takes web links for homepage, repository and author url. */
export function httpUrl(where: string, field: string, value: unknown): string {
  const text = nonEmptyString(where, field, value)
  let parsed: URL | undefined
  try {
    parsed = new URL(text)
  } catch {
    parsed = undefined
  }
  if (!parsed || (parsed.protocol !== "https:" && parsed.protocol !== "http:")) fail(where, `"${field}" must be an http(s) URL, got ${JSON.stringify(text)}`)
  return text
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
