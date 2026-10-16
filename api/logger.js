const instance = process.env.ECHO_INSTANCE_ID || process.env.HOSTNAME || 'unknown'

function normalize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      ...(value.code ? { code: value.code } : {}),
    }
  }
  if (typeof value === 'bigint') return value.toString()
  return value
}

export function log(level, event, fields = {}) {
  const record = {
    timestamp_unix_ms: Date.now(),
    schema_version: 1,
    level,
    service: 'api',
    instance,
    event,
  }
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined) record[key] = normalize(value)
  }
  const line = `${JSON.stringify(record)}\n`
  const output = level === 'error' || level === 'fatal' ? process.stderr : process.stdout
  output.write(line)
}

export function errorFields(error) {
  return {
    error: {
      name: error?.name || 'Error',
      message: error?.message || String(error),
      ...(error?.code ? { code: error.code } : {}),
    },
  }
}
