function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function deepMerge<T extends Record<string, unknown>>(...configs: T[]): T {
  const merged: Record<string, unknown> = {};

  for (const config of configs) {
    mergeInto(merged, config);
  }

  return merged as T;
}

function mergeInto(target: Record<string, unknown>, source: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(source)) {
    const existingValue = target[key];

    if (isRecord(existingValue) && isRecord(value)) {
      target[key] = deepMerge(existingValue, value);
      continue;
    }

    target[key] = value;
  }
}
