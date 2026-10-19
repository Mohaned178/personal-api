import { z } from "zod";

/**
 * Account deletion (`DELETE /v1/account`, session only). The request proves it is deliberate: the
 * current password, and the exact confirmation phrase. Requests are strict, and the account is the
 * session's: `userId` never comes from the body. The answer is `204`, with the session cookie
 * cleared.
 */

/** 403: the password is wrong, or the account has no password to check. One answer for both. */
export const ACCOUNT_PASSWORD_INVALID_CODE = "account.password_invalid";

/** 429: too many password checks for this account in a short time. `Retry-After` says when to retry. */
export const ACCOUNT_RATE_LIMITED_CODE = "account.rate_limited";

/** The phrase the request has to repeat, so a stray call or a pasted script cannot delete by accident. */
export const ACCOUNT_DELETE_CONFIRMATION = "delete my account";

/** Longer than Better Auth accepts, so a real password always fits; the bound keeps hashing cheap. */
export const ACCOUNT_PASSWORD_MAX_LENGTH = 256;

export const deleteAccountRequestSchema = z.strictObject({
  password: z.string().min(1).max(ACCOUNT_PASSWORD_MAX_LENGTH),
  confirm: z.literal(ACCOUNT_DELETE_CONFIRMATION),
});
export type DeleteAccountRequest = z.output<typeof deleteAccountRequestSchema>;
