/**
 * Decide whether a readable SQL checkpoint is authoritative during cold load.
 *
 * SQL-native rooms have no migration receipt and no retained legacy source, so
 * they remain valid. A KV-to-SQL migration is authoritative only after its
 * checkpoint was verified and the receipt recorded. Until then, retained KV
 * remains the recovery source even if a partial SQL checkpoint is readable.
 */
export function shouldUseSqlState(
	sqlHasData: boolean,
	hasMigrationReceipt: boolean,
	hasLegacyMigrationSource: boolean,
): boolean {
	return sqlHasData && (hasMigrationReceipt || !hasLegacyMigrationSource);
}
