/** Most `*` a rule may put in one pattern. Bounds the matcher's work (see `globMatches`). */
export const GLOB_MAX_WILDCARDS = 8;

/**
 * The glob used by `type` selectors and the `matches_glob` op. `*` matches any run of characters
 * (including none and `/`); every other character, `?` and `[` included, is literal. There is no
 * regex anywhere (PLAN §5, no ReDoS), and both sides of the wire share this one function so the
 * extension and the server cannot disagree. Case-sensitive, compared by UTF-16 code unit.
 *
 * The matcher is iterative with a single backtrack point, so it takes at most
 * `pattern.length * text.length` steps and cannot blow up on `a*a*a*a*b`.
 */
export function globMatches(pattern: string, text: string): boolean {
  let p = 0;
  let t = 0;
  let star = -1;
  let mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") {
      star = p++;
      mark = t;
    } else if (p < pattern.length && pattern[p] === text[t]) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++mark;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}
