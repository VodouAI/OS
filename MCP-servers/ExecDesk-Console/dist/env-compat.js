/**
 * Read VODOU_<name>, falling back to OI_<name> for backward compat.
 * Sprint B shim — removed in v0.6.1 after OI_* vars are fully deprecated.
 */
export function vodouEnv(name) {
    return process.env[`VODOU_${name}`] ?? process.env[`OI_${name}`];
}
