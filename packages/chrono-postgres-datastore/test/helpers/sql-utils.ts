/**
 * SQL Utility Functions
 *
 * Helpers for converting between TypeORM's conventions and raw PostgreSQL.
 * TypeORM uses camelCase for column names, but PostgreSQL uses snake_case.
 */

/**
 * Converts a camelCase string to snake_case.
 *
 * @example
 * toSnakeCase('scheduledAt') // returns 'scheduled_at'
 * toSnakeCase('idempotencyKey') // returns 'idempotency_key'
 */
export function toSnakeCase(str: string): string {
  return str.replace(/([A-Z])/g, '_$1').toLowerCase();
}

/**
 * Converts camelCase column names in SQL to snake_case.
 * Only converts "alias.columnName" patterns, leaving other text untouched.
 *
 * @example
 * convertAliasedColumns('task.scheduledAt <= :now')
 * // returns 'task.scheduled_at <= :now'
 */
export function convertAliasedColumns(sql: string): string {
  return sql.replace(/(\w+)\.(\w+)/g, (_match, tableAlias, column) => {
    return `${tableAlias}.${toSnakeCase(column)}`;
  });
}

/**
 * Converts camelCase identifiers to snake_case, but preserves :param placeholders.
 * Uses negative lookbehind to avoid converting parameter names like :scheduledAt.
 *
 * @example
 * convertIdentifiers('scheduledAt = :scheduledAt')
 * // returns 'scheduled_at = :scheduledAt'
 */
export function convertCamelCaseIdentifiers(sql: string): string {
  // Pattern matches camelCase words (lowercase followed by uppercase)
  // Negative lookbehind (?<!:) ensures we don't match :paramName placeholders
  return sql.replace(/(?<!:)\b([a-z]+)([A-Z][a-z]*)+\b/g, (match) => toSnakeCase(match));
}

/**
 * Removes a table alias prefix from a SQL fragment.
 *
 * @example
 * removeAliasPrefix('task.status = :status', 'task')
 * // returns 'status = :status'
 */
export function removeAliasPrefix(sql: string, alias: string): string {
  return sql.replace(new RegExp(`${alias}\\.`, 'g'), '');
}

/**
 * Result of replacing named parameters with positional parameters.
 */
export type ParameterReplacementResult = {
  sql: string;
  values: unknown[];
};

/**
 * Replaces TypeORM-style named parameters (:paramName) with PostgreSQL-style
 * positional parameters ($1, $2, etc.).
 *
 * @example
 * replaceNamedParameters('status = :status AND kind = :kind', { status: 'PENDING', kind: 'test' })
 * // returns { sql: 'status = $1 AND kind = $2', values: ['PENDING', 'test'] }
 */
export function replaceNamedParameters(sql: string, params: Record<string, unknown>): ParameterReplacementResult {
  const values: unknown[] = [];
  let paramIndex = 1;
  let result = convertAliasedColumns(sql);

  for (const [key, value] of Object.entries(params)) {
    const placeholder = `:${key}`;

    if (result.includes(placeholder)) {
      // Replace all occurrences of this placeholder
      result = result.split(placeholder).join(`$${paramIndex}`);
      values.push(value);
      paramIndex++;
    }
  }

  return { sql: result, values };
}
