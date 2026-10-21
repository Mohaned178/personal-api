/**
 * The shape of a read key (`pa_read_` + 43 base64url characters). Read keys were removed in
 * M9-01, so no such key can be stored any more; specs use this to show that a key from an older
 * install is refused like any other unknown bearer.
 */
export const FORMER_READ_KEY = `pa_read_${"A".repeat(43)}`;
