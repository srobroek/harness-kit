export function fail(where: string, message: string): never {
  throw new Error(`${where}: ${message}`)
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export function nonEmptyString(where: string, field: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) fail(where, `"${field}" must be a non-empty string`)
  return value
}

export function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}
