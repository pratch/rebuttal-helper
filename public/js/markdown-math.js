/**
 * markdown-math.js
 * Robust Markdown & KaTeX LaTeX equation renderer with DOMPurify sanitization.
 * Protects LaTeX formulas from being mangled by Markdown underscore/asterisk parsers.
 */

(function (window) {
  'use strict';

  // Configure marked options
  if (window.marked) {
    window.marked.setOptions({
      gfm: true,
      breaks: true,
      pedantic: false
    });
  }

  /**
   * Render raw markdown text containing LaTeX math equations ($...$ and $$...$$)
   * into sanitized HTML with KaTeX rendered equations.
   *
   * @param {string} text - Raw markdown with possible math formulas
   * @returns {string} Safe HTML string
   */
  function renderMarkdownWithMath(text) {
    if (!text || typeof text !== 'string') return '';

    // Strip commented out lines starting with // or %% so they do not show in rendered output
    const cleanText = text.split('\n')
      .filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('%%');
      })
      .join('\n');

    const mathStore = [];

    // Helper to store math and return a placeholder
    const storeMath = (mathCode, isBlock) => {
      const idx = mathStore.length;
      mathStore.push({ math: mathCode, isBlock });
      return `%%MATH_${isBlock ? 'BLOCK' : 'INLINE'}_${idx}%%`;
    };

    // 1. Protect display math $$ ... $$
    let processed = cleanText.replace(/\$\$([\s\S]+?)\$\$/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), true);
    });

    // Also support \[ ... \] block math
    processed = processed.replace(/\\\[([\s\S]+?)\\\]/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), true);
    });

    // 2. Protect inline math $ ... $ (excluding escaped \$ and currency like $50 or $$)
    // Matches $equation$ where equation starts and ends with non-whitespace
    processed = processed.replace(/(^|[^\\])\$([^\$\n\r]+?)\$/g, (match, prefix, mathContent) => {
      // Avoid matching empty or invalid single char dollar signs
      if (!mathContent.trim()) return match;
      return prefix + storeMath(mathContent.trim(), false);
    });

    // Also support \( ... \) inline math
    processed = processed.replace(/\\\(([\s\S]+?)\\\)/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), false);
    });

    // 3. Render Markdown with Marked
    let html = '';
    if (window.marked && typeof window.marked.parse === 'function') {
      html = window.marked.parse(processed);
    } else {
      // Fallback if marked is loading
      html = `<pre>${escapeHtml(processed)}</pre>`;
    }

    // 4. Restore and render KaTeX equations from placeholders
    html = html.replace(/%%MATH_(BLOCK|INLINE)_(\d+)%%/g, (match, type, index) => {
      const item = mathStore[parseInt(index, 10)];
      if (!item) return match;

      const isBlock = item.isBlock;
      const formula = item.math;

      if (window.katex && typeof window.katex.renderToString === 'function') {
        try {
          return window.katex.renderToString(formula, {
            displayMode: isBlock,
            throwOnError: false,
            errorColor: '#ef4444'
          });
        } catch (err) {
          console.warn('KaTeX render error:', err);
          return `<span class="katex-error" title="${escapeHtml(err.message)}">${escapeHtml(formula)}</span>`;
        }
      } else {
        // Fallback display if KaTeX is not loaded
        return isBlock ? `<div class="math-raw">$$${escapeHtml(formula)}$$</div>` : `<span class="math-raw">$${escapeHtml(formula)}$</span>`;
      }
    });

    // 5. Sanitize with DOMPurify
    if (window.DOMPurify && typeof window.DOMPurify.sanitize === 'function') {
      html = window.DOMPurify.sanitize(html, {
        ADD_TAGS: ['annotation', 'semantics', 'mrow', 'mi', 'mo', 'mn', 'msup', 'msub', 'mfrac', 'mover', 'munder', 'msubsup', 'msqrt', 'mtable', 'mtr', 'mtd', 'span', 'svg', 'path'],
        ADD_ATTR: ['aria-hidden', 'viewBox', 'd', 'style', 'xmlns', 'preserveAspectRatio']
      });
    }

    return html;
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // Export to global namespace
  window.MarkdownMath = {
    render: renderMarkdownWithMath,
    escapeHtml: escapeHtml
  };

})(window);
