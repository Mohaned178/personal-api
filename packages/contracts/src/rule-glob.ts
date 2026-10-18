/** Most `*` a rule may put in one pattern. Bounds the matcher's work (see `globMatches`). */
export const GLOB_MAX_WILDCARDS = 8;

/**
 * The glob used by `type` selectors and the `matches_glob` op. `*` matches any run of characters
 * (including none and `/`); every other character, `?` and `[` included, is literal. There is no
 * regex anywhere (PLAN §5, no ReDoS), and both sides of the wire share this one function so the
 * extension and the server cannot disagree. Case-sensitive, compared by UTF-16 code unit.
 *
 * The pattern is split on `*` and each literal piece is placed once, leftmost first: the first
 * piece must start the text, the last must end it, and the pieces between are found in order with
 * `indexOf`. That is linear in the text per piece, so a rule set full of `*a…ab` patterns cannot
 * stall an evaluation, and leftmost placement is exact for globs, so there is no backtracking.
 */
export function globMatches(pattern: string, text: string): boolean {
  const pieces = pattern.split("*");
  const first = pieces[0] ?? "";
  if (pieces.length === 1) return first === text;
  const last = pieces[pieces.length - 1] ?? "";
  if (text.length < first.length + last.length) return false;
  if (!text.startsWith(first) || !text.endsWith(last)) return false;
  const end = text.length - last.length;
  let pos = first.length;
  for (const piece of pieces.slice(1, -1)) {
    if (piece === "") continue;
    const at = text.indexOf(piece, pos);
    if (at === -1 || at + piece.length > end) return false;
    pos = at + piece.length;
  }
  return true;
}
