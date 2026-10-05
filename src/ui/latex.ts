/**
 * LaTeX math (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`) as Unicode, since a terminal can't typeset it:
 * Greek letters, operators, relations, arrows, sets, fractions, roots, sub/superscripts.
 * Anything it doesn't know is left as written, so the output is never worse than the source.
 */
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', varepsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', vartheta: 'ϑ', iota: 'ι', kappa: 'κ', lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', pi: 'π', varpi: 'ϖ', rho: 'ρ', varrho: 'ϱ', sigma: 'σ', varsigma: 'ς', tau: 'τ', upsilon: 'υ', phi: 'φ', varphi: 'φ', chi: 'χ', psi: 'ψ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Xi: 'Ξ', Pi: 'Π', Sigma: 'Σ', Upsilon: 'Υ', Phi: 'Φ', Psi: 'Ψ', Omega: 'Ω',
  times: '×', cdot: '·', div: '÷', pm: '±', mp: '∓', ast: '∗', star: '⋆', circ: '∘', bullet: '•', oplus: '⊕', otimes: '⊗',
  le: '≤', leq: '≤', ge: '≥', geq: '≥', ne: '≠', neq: '≠', approx: '≈', equiv: '≡', sim: '∼', simeq: '≃', cong: '≅', propto: '∝', ll: '≪', gg: '≫', mid: '∣', parallel: '∥', perp: '⊥',
  in: '∈', notin: '∉', ni: '∋', subset: '⊂', subseteq: '⊆', supset: '⊃', supseteq: '⊇', cup: '∪', cap: '∩', setminus: '∖', emptyset: '∅', varnothing: '∅',
  forall: '∀', exists: '∃', nexists: '∄', neg: '¬', lnot: '¬', land: '∧', wedge: '∧', lor: '∨', vee: '∨', implies: '⟹', iff: '⟺',
  to: '→', rightarrow: '→', leftarrow: '←', leftrightarrow: '↔', Rightarrow: '⇒', Leftarrow: '⇐', Leftrightarrow: '⇔', mapsto: '↦', uparrow: '↑', downarrow: '↓', longrightarrow: '⟶',
  sum: '∑', prod: '∏', coprod: '∐', int: '∫', iint: '∬', oint: '∮', partial: '∂', nabla: '∇', infty: '∞', sqrt: '√',
  ldots: '…', cdots: '⋯', vdots: '⋮', ddots: '⋱', dots: '…', prime: '′', degree: '°', angle: '∠', triangle: '△', hbar: 'ℏ', ell: 'ℓ', Re: 'ℜ', Im: 'ℑ', aleph: 'ℵ',
  langle: '⟨', rangle: '⟩', lceil: '⌈', rceil: '⌉', lfloor: '⌊', rfloor: '⌋', lbrace: '{', rbrace: '}', vert: '|', Vert: '‖',
  log: 'log', ln: 'ln', exp: 'exp', sin: 'sin', cos: 'cos', tan: 'tan', lim: 'lim', max: 'max', min: 'min', det: 'det', gcd: 'gcd', mod: 'mod', arg: 'arg',
};
const SUP: Record<string, string> = {'0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ', a: 'ᵃ', b: 'ᵇ', c: 'ᶜ', d: 'ᵈ', e: 'ᵉ', f: 'ᶠ', g: 'ᵍ', h: 'ʰ', j: 'ʲ', k: 'ᵏ', l: 'ˡ', m: 'ᵐ', o: 'ᵒ', p: 'ᵖ', r: 'ʳ', s: 'ˢ', t: 'ᵗ', u: 'ᵘ', v: 'ᵛ', w: 'ʷ', x: 'ˣ', y: 'ʸ', z: 'ᶻ', T: 'ᵀ', '*': '*', '′': '′'};
const SUB: Record<string, string> = {'0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', h: 'ₕ', i: 'ᵢ', j: 'ⱼ', k: 'ₖ', l: 'ₗ', m: 'ₘ', n: 'ₙ', o: 'ₒ', p: 'ₚ', r: 'ᵣ', s: 'ₛ', t: 'ₜ', u: 'ᵤ', v: 'ᵥ', x: 'ₓ'};
const BB: Record<string, string> = {R: 'ℝ', N: 'ℕ', Z: 'ℤ', Q: 'ℚ', C: 'ℂ', P: 'ℙ', E: '𝔼'};

/** The `{…}` group starting at `i` (or one character / one command): [content, next index]. */
function group(s: string, i: number): [string, number] {
  while (s[i] === ' ') i++;
  if (s[i] === '{') {
    let depth = 0;
    for (let j = i; j < s.length; j++) {
      if (s[j] === '{') depth++;
      else if (s[j] === '}' && --depth === 0) return [s.slice(i + 1, j), j + 1];
    }
    return [s.slice(i + 1), s.length];
  }
  if (s[i] === '\\') {
    const m = /^\\([a-zA-Z]+|.)/.exec(s.slice(i));
    if (m) return [m[0], i + m[0].length];
  }
  return [s[i] ?? '', i + 1];
}

/** Superscript/subscript: Unicode when every character has one, else ^(…) / _(…). */
function script(text: string, table: Record<string, string>, mark: '^' | '_'): string {
  const chars = [...text];
  if (chars.length && chars.every((c) => table[c])) return chars.map((c) => table[c]).join('');
  return chars.length === 1 ? `${mark}${text}` : `${mark}(${text})`;
}

const simple = (x: string) => /^[\p{L}\p{N}.′]+$/u.test(x) || [...x].length === 1;

export function latexToUnicode(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; ) {
    const ch = src[i]!;
    if (ch === '^' || ch === '_') {
      const [g, next] = group(src, i + 1);
      out += script(latexToUnicode(g), ch === '^' ? SUP : SUB, ch);
      i = next;
      continue;
    }
    if (ch === '{' || ch === '}') {
      i++;
      continue;
    }
    if (ch === '\\') {
      const m = /^\\([a-zA-Z]+|.)/.exec(src.slice(i));
      if (!m) {
        out += ch;
        i++;
        continue;
      }
      const name = m[1]!;
      i += m[0].length;
      if (name === 'frac' || name === 'dfrac' || name === 'tfrac') {
        const [a, n1] = group(src, i);
        const [b, n2] = group(src, n1);
        const top = latexToUnicode(a);
        const bottom = latexToUnicode(b);
        out += `${simple(top) ? top : `(${top})`}/${simple(bottom) ? bottom : `(${bottom})`}`;
        i = n2;
      } else if (name === 'sqrt') {
        let degree = '';
        if (src[i] === '[') {
          const end = src.indexOf(']', i);
          degree = src.slice(i + 1, end);
          i = end + 1;
        }
        const [a, next] = group(src, i);
        const inner = latexToUnicode(a);
        out += `${degree === '3' ? '∛' : degree === '4' ? '∜' : degree ? script(degree, SUP, '^') + '√' : '√'}${simple(inner) ? inner : `(${inner})`}`;
        i = next;
      } else if (name === 'mathbb') {
        const [a, next] = group(src, i);
        out += [...a].map((c) => BB[c] ?? c).join('');
        i = next;
      } else if (['text', 'mathrm', 'textrm', 'mathit', 'mathbf', 'textbf', 'mathsf', 'mathtt', 'operatorname', 'boldsymbol', 'mathcal'].includes(name)) {
        const [a, next] = group(src, i);
        out += name.startsWith('text') || name === 'operatorname' ? a : latexToUnicode(a);
        i = next;
      } else if (name === 'left' || name === 'right' || name === 'big' || name === 'Big' || name === 'bigg' || name === 'displaystyle') {
        // sizing: the delimiter that follows stays
      } else if (name === ',' || name === ';' || name === ':' || name === ' ' || name === 'quad' || name === 'qquad') out += ' ';
      else if (name === '!') {
        /* negative space */
      } else if (name === '\\') out += '\n';
      else if (name === '{' || name === '}' || name === '%' || name === '$' || name === '&' || name === '#' || name === '_') out += name;
      else if (SYMBOLS[name] !== undefined) out += SYMBOLS[name] + (/^[a-z]{2,}$/.test(SYMBOLS[name]!) && /[A-Za-z]/.test(src[i] ?? '') ? ' ' : '');
      else out += m[0]; // unknown: as written
      continue;
    }
    out += ch === '~' ? ' ' : ch;
    i++;
  }
  return out.replace(/ {2,}/g, ' ');
}

/** Inline math in prose: `$x$` (not "$5 and $10"), `\(x\)`. */
export const INLINE_MATH = /^(?:\$(?!\s)((?:\\\$|[^$\n])+?)(?<!\s)\$(?!\d)|\\\((.+?)\\\))/;
/** Display math: `$$…$$` or `\[…\]`, possibly over several lines. */
export const BLOCK_MATH = /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\])(?:\n|$)/;
