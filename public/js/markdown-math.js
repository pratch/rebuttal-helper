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
   * @param {object} [options]
   * @param {boolean} [options.sourceMap] - Wrap each top-level block in
   *   <div class="md-block" data-src-start data-src-end> giving the 0-based
   *   source line range it came from (used for editor/preview scroll sync)
   * @returns {string} Safe HTML string
   */
  function renderMarkdownWithMath(text, options = {}) {
    if (!text || typeof text !== 'string') return '';

    // Strip commented out lines starting with // or %% so they do not show in rendered output,
    // remembering which source line each remaining line came from
    const sourceLineOf = [];
    const cleanText = text.split('\n')
      .filter((line, i) => {
        const trimmed = line.trim();
        const keep = !trimmed.startsWith('//') && !trimmed.startsWith('%%');
        if (keep) sourceLineOf.push(i);
        return keep;
      })
      .join('\n');

    const mathStore = [];

    // Helper to store math and return a placeholder (records how many newlines it replaced)
    const storeMath = (mathCode, isBlock, original) => {
      const idx = mathStore.length;
      mathStore.push({ math: mathCode, isBlock, newlines: (original.match(/\n/g) || []).length });
      return `%%MATH_${isBlock ? 'BLOCK' : 'INLINE'}_${idx}%%`;
    };

    // 1. Protect display math $$ ... $$
    let processed = cleanText.replace(/\$\$([\s\S]+?)\$\$/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), true, match);
    });

    // Also support \[ ... \] block math
    processed = processed.replace(/\\\[([\s\S]+?)\\\]/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), true, match);
    });

    // 2. Protect inline math $ ... $ (excluding escaped \$ and currency like $50 or $$)
    // Matches $equation$ where equation starts and ends with non-whitespace
    processed = processed.replace(/(^|[^\\])\$([^\$\n\r]+?)\$/g, (match, prefix, mathContent) => {
      // Avoid matching empty or invalid single char dollar signs
      if (!mathContent.trim()) return match;
      return prefix + storeMath(mathContent.trim(), false, match);
    });

    // Also support \( ... \) inline math
    processed = processed.replace(/\\\(([\s\S]+?)\\\)/g, (match, mathContent) => {
      return storeMath(mathContent.trim(), false, match);
    });

    // 3. Render Markdown with Marked
    let html = '';
    if (options.sourceMap && window.marked && typeof window.marked.lexer === 'function') {
      html = renderBlocksWithSourceLines(processed, mathStore, sourceLineOf);
    } else if (window.marked && typeof window.marked.parse === 'function') {
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

  // Render top-level tokens one at a time, each wrapped with the source lines it spans
  function renderBlocksWithSourceLines(processed, mathStore, sourceLineOf) {
    // Newlines in a raw chunk, counting those collapsed into math placeholders
    const countLines = (raw) => {
      let n = (raw.match(/\n/g) || []).length;
      raw.replace(/%%MATH_(?:BLOCK|INLINE)_(\d+)%%/g, (m, idx) => {
        n += (mathStore[parseInt(idx, 10)] || {}).newlines || 0;
        return m;
      });
      return n;
    };
    const toSource = (cleanLine) =>
      sourceLineOf[Math.min(Math.max(cleanLine, 0), sourceLineOf.length - 1)] ?? 0;

    let line = 0; // current line in the comment-stripped text
    let html = '';
    window.marked.lexer(processed).forEach(token => {
      const raw = token.raw || '';
      if (token.type !== 'space') {
        const leading = raw.match(/^\n*/)[0].length;
        const body = raw.slice(leading).replace(/\n+$/, '');
        const start = line + leading;
        const end = start + countLines(body);
        // Finer ranges for list items and table rows: data-src-parts="start-end,..." in DOM order
        const parts = [];
        if (token.type === 'list' && Array.isArray(token.items)) {
          let itemLine = start;
          token.items.forEach(item => {
            const itemRaw = item.raw || '';
            parts.push([itemLine, itemLine + countLines(itemRaw.replace(/\n+$/, ''))]);
            itemLine += countLines(itemRaw);
          });
        } else if (token.type === 'table' && Array.isArray(token.rows)) {
          parts.push([start, start]); // header row; the |---| separator line has no row
          token.rows.forEach((_, i) => parts.push([start + 2 + i, start + 2 + i]));
        }
        const partsAttr = parts.length
          ? ` data-src-kind="${token.type}" data-src-parts="${parts.map(([a, b]) => `${toSource(a)}-${toSource(b)}`).join(',')}"`
          : '';
        html += `<div class="md-block" data-src-start="${toSource(start)}" data-src-end="${toSource(end)}"${partsAttr}>`
          + window.marked.parser([token]) + '</div>';
      }
      line += countLines(raw);
    });
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
