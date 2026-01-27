/**
 * Test Helpers
 *
 * This module provides mock implementations of TypeORM's DataSource and
 * related classes for testing ChronoPostgresDatastore without a real database.
 *
 * Architecture:
 * ┌─────────────────────────────────────────────────────────────────┐
 * │                        MockDataSource                           │
 * │  - Main entry point for tests                                   │
 * │  - Provides manager, createQueryBuilder, transaction            │
 * └─────────────────────────────────────────────────────────────────┘
 *                              │
 *           ┌──────────────────┼──────────────────┐
 *           ▼                                     ▼
 * ┌─────────────────────┐              ┌─────────────────────┐
 * │  MockEntityManager  │              │  MockQueryBuilder   │
 * │  - create, save     │              │  - where, andWhere  │
 * │  - findOne, query   │              │  - set, orderBy     │
 * └─────────────────────┘              │  - getOne, execute  │
 *                                      └─────────────────────┘
 *                                                 │
 *                                                 ▼
 *                                      ┌─────────────────────┐
 *                                      │ WhereClauseBuilder  │
 *                                      │ - Builds WHERE SQL  │
 *                                      │ - Handles Brackets  │
 *                                      └─────────────────────┘
 *                                                 │
 *           ┌─────────────────────────────────────┼─────────────────┐
 *           ▼                                     ▼                 ▼
 * ┌─────────────────┐              ┌─────────────────┐   ┌─────────────────┐
 * │   SQL Utils     │              │  Entity Mapper  │   │ Database Setup  │
 * │ - toSnakeCase   │              │ - mapRowToEntity│   │ - TEST_TABLE    │
 * │ - replaceParams │              └─────────────────┘   └─────────────────┘
 * └─────────────────┘
 */

export { mapRowToEntity } from './entity-mapper';
// Main export - this is what tests should import
export { createMockDataSource, type MockDataSource } from './mock-datasource';
// Lower-level exports for advanced usage or extension
export { createMockEntityManager, type MockEntityManager } from './mock-entity-manager';
export { createMockQueryBuilder, type MockQueryBuilder } from './mock-query-builder';
