/**
 * WHERE Clause Builder
 *
 * Builds SQL WHERE clauses from TypeORM-style conditions.
 * Handles simple conditions, AND/OR combinations, and nested Brackets.
 */

import {
  convertCamelCaseIdentifiers,
  type ParameterReplacementResult,
  removeAliasPrefix,
  replaceNamedParameters,
} from './sql-utils';

/**
 * A single WHERE condition with its SQL fragment and parameters.
 */
export type WhereCondition = {
  sql: string;
  params: Record<string, unknown>;
};

/**
 * A sub-query builder for handling TypeORM Brackets.
 *
 * TypeORM's Brackets class groups conditions with parentheses:
 * ```ts
 * new Brackets(qb => {
 *   qb.where('status = :pending', { pending: 'PENDING' })
 *     .orWhere('status = :claimed', { claimed: 'CLAIMED' })
 * })
 * ```
 *
 * This creates a mini query builder that collects the conditions
 * and can output them as a grouped SQL string.
 *
 * @param tableAlias - The table alias to remove from column references (e.g., 'task')
 */
export function createBracketsQueryBuilder(tableAlias: string = 'task') {
  const conditions: Array<{
    type: 'where' | 'or';
    sql: string;
    params: Record<string, unknown>;
  }> = [];

  /**
   * Cleans up a SQL fragment by removing the table alias and converting to snake_case.
   */
  function cleanSql(sql: string): string {
    let result = removeAliasPrefix(sql, tableAlias);
    result = convertCamelCaseIdentifiers(result);
    return result;
  }

  return {
    /**
     * Adds a WHERE condition. The first condition added uses this.
     */
    where(sql: string, params?: Record<string, unknown>) {
      conditions.push({
        type: 'where',
        sql,
        params: params || {},
      });
      return this;
    },

    /**
     * Adds an OR condition to the group.
     */
    orWhere(sql: string, params?: Record<string, unknown>) {
      conditions.push({
        type: 'or',
        sql,
        params: params || {},
      });
      return this;
    },

    /**
     * Builds the SQL string for all conditions in this group.
     *
     * @returns SQL like: "status = :pending OR status = :claimed AND claimed_at <= :staleThreshold"
     */
    getSql(): string {
      return conditions
        .map((condition, index) => {
          const cleaned = cleanSql(condition.sql);

          // First condition doesn't need AND/OR prefix
          if (index === 0) {
            return cleaned;
          }

          // Subsequent conditions get their appropriate connector
          const connector = condition.type === 'or' ? 'OR' : 'AND';
          return `${connector} ${cleaned}`;
        })
        .join(' ');
    },

    /**
     * Collects all parameters from all conditions in this group.
     */
    getParams(): Record<string, unknown> {
      const result: Record<string, unknown> = {};
      for (const condition of conditions) {
        Object.assign(result, condition.params);
      }
      return result;
    },
  };
}

/**
 * Manages a collection of WHERE clauses and builds the final SQL.
 */
export class WhereClauseCollection {
  private clauses: WhereCondition[] = [];
  private tableAlias: string;

  constructor(tableAlias: string = 'entity') {
    this.tableAlias = tableAlias;
  }

  /**
   * Updates the table alias used for removing prefixes.
   * Call this when the alias changes (e.g., after from() is called).
   */
  setAlias(alias: string): void {
    this.tableAlias = alias;
  }

  /**
   * Gets the current table alias.
   */
  getAlias(): string {
    return this.tableAlias;
  }

  /**
   * Adds a simple string condition.
   */
  addCondition(sql: string, params: Record<string, unknown> = {}): void {
    // Remove table alias and convert column names to snake_case
    let cleanSql = removeAliasPrefix(sql, this.tableAlias);
    cleanSql = convertCamelCaseIdentifiers(cleanSql);

    this.clauses.push({ sql: cleanSql, params });
  }

  /**
   * Adds a condition from a Brackets query builder.
   * Wraps the result in parentheses to maintain grouping.
   */
  addBracketsCondition(bracketsQb: ReturnType<typeof createBracketsQueryBuilder>): void {
    this.clauses.push({
      sql: `(${bracketsQb.getSql()})`,
      params: bracketsQb.getParams(),
    });
  }

  /**
   * Adds an OR condition to the previous clause.
   * Combines the last clause with the new condition using OR.
   */
  addOrCondition(sql: string, params: Record<string, unknown> = {}): void {
    const cleanSql = removeAliasPrefix(sql, this.tableAlias);
    const lastClause = this.clauses.pop();

    if (lastClause) {
      // Combine with previous clause using OR
      this.clauses.push({
        sql: `(${lastClause.sql} OR ${cleanSql})`,
        params: { ...lastClause.params, ...params },
      });
    } else {
      // No previous clause, just add this one
      this.clauses.push({ sql: cleanSql, params });
    }
  }

  /**
   * Builds the final WHERE clause SQL with positional parameters.
   *
   * @returns Object with the SQL string and array of parameter values
   */
  build(): ParameterReplacementResult {
    if (this.clauses.length === 0) {
      return { sql: '', values: [] };
    }

    // Combine all parameters
    const allParams: Record<string, unknown> = {};
    for (const clause of this.clauses) {
      Object.assign(allParams, clause.params);
    }

    // Join clauses with AND
    const combinedSql = this.clauses.map((c) => c.sql).join(' AND ');

    // Replace named parameters with positional ones
    return replaceNamedParameters(combinedSql, allParams);
  }
}
