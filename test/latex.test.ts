import stripAnsi from 'strip-ansi';
import {describe, expect, it} from 'vitest';
import {latexToUnicode} from '../src/ui/latex.js';
import {renderMarkdown} from '../src/ui/markdown.js';

describe('LaTeX as Unicode', () => {
  it('converts the common notation', () => {
    expect(latexToUnicode('x^2 + y^2 = r^2')).toBe('x² + y² = r²');
    expect(latexToUnicode('a_{i+1} = a_i \\cdot \\alpha')).toBe('aᵢ₊₁ = aᵢ · α');
    expect(latexToUnicode('\\frac{1}{2}')).toBe('1/2');
    expect(latexToUnicode('\\frac{a+b}{c}')).toBe('(a+b)/c');
    expect(latexToUnicode('\\sqrt{x^2+1}')).toBe('√(x²+1)');
    expect(latexToUnicode('\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}')).toBe('∑ᵢ₌₁ⁿ i = (n(n+1))/2');
    expect(latexToUnicode('\\forall x \\in \\mathbb{R}, x \\le |x|')).toBe('∀ x ∈ ℝ, x ≤ |x|');
    expect(latexToUnicode('f: A \\to B')).toBe('f: A → B');
    expect(latexToUnicode('e^{i\\pi} + 1 = 0')).toBe('e^(iπ) + 1 = 0'); // no superscript π: kept readable
    expect(latexToUnicode('\\lim_{x \\to 0} \\frac{\\sin x}{x}')).toBe('lim_(x → 0) (sin x)/x');
    expect(latexToUnicode('\\text{if } n \\ne 0')).toBe('if n ≠ 0');
    expect(latexToUnicode('\\weirdcommand{x}')).toBe('\\weirdcommandx'); // unknown: as written (braces dropped)
  });

  it('renders $…$ and $$…$$ in replies, and leaves prices alone', () => {
    const inline = stripAnsi(renderMarkdown('The area is $\\pi r^2$ for a circle.', 80).join('\n'));
    expect(inline).toBe('The area is π r² for a circle.');
    const prices = stripAnsi(renderMarkdown('It costs $5 and $10 for two.', 80).join('\n'));
    expect(prices).toBe('It costs $5 and $10 for two.');
    const block = stripAnsi(renderMarkdown('Euler:\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n\nDone.', 80).join('\n'));
    expect(block).toContain('    e^(iπ) + 1 = 0');
    expect(block).toContain('Done.');
    expect(stripAnsi(renderMarkdown('Use \\(a \\times b\\) here.', 80).join('\n'))).toBe('Use a × b here.');
    expect(stripAnsi(renderMarkdown('code: `$x^2$` stays', 80).join('\n'))).toBe('code: $x^2$ stays');
  });
});
