// TEMPORARY (M2-R fix): logic behind the popup's allow list editor, replaced by the rule editor in M4-06.
// Pure over `AllowListStorage`, so it is testable without a DOM. Never logs values (they are domains).
import {
  type AllowListStorage,
  addAllowedDomain,
  getAllowList,
  normalizeAllowedDomain,
  removeAllowedDomain,
} from "./allow-list";

export interface AllowListEditorState {
  domains: string[];
  /** Short inline message for the input, or null. Never contains the typed value. */
  error: string | null;
}

export const INVALID_DOMAIN_MESSAGE = "Enter a plain domain such as example.com.";
export const LIST_FULL_MESSAGE = "The allow list is full.";
export const SAVE_FAILED_MESSAGE = "Could not save. Try again.";

/** Loads the list (fail closed: [] on any problem). */
export async function loadAllowListEditor(
  storage: AllowListStorage,
): Promise<AllowListEditorState> {
  return { domains: await getAllowList(storage), error: null };
}

/** Validates then adds one domain. Invalid input stores nothing and returns an inline error. */
export async function addDomainFromInput(
  storage: AllowListStorage,
  input: string,
): Promise<AllowListEditorState> {
  if (normalizeAllowedDomain(input) === null) {
    return { domains: await getAllowList(storage), error: INVALID_DOMAIN_MESSAGE };
  }
  try {
    return { domains: await addAllowedDomain(storage, input), error: null };
  } catch (error) {
    const full = error instanceof Error && error.message === "Allow list is full";
    return {
      domains: await getAllowList(storage),
      error: full ? LIST_FULL_MESSAGE : SAVE_FAILED_MESSAGE,
    };
  }
}

/** Removes one domain; a storage failure leaves the list as stored and shows an inline error. */
export async function removeDomain(
  storage: AllowListStorage,
  domain: string,
): Promise<AllowListEditorState> {
  try {
    return { domains: await removeAllowedDomain(storage, domain), error: null };
  } catch {
    return { domains: await getAllowList(storage), error: SAVE_FAILED_MESSAGE };
  }
}
