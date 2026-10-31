/**
 * Rebuttal Helper - Collaborative Markdown & Math Editor
 * Jupyter-style cells with real-time peer presence, live KaTeX rendering,
 * and per-cell & global character counters.
 */

(function () {
  'use strict';

  // --- Configuration & State ---
  const URL_PARAMS = new URLSearchParams(window.location.search);
  let docId = URL_PARAMS.get('doc');
  if (!docId) {
    // Generate clean friendly default room ID
    docId = 'rebuttal-' + Math.random().toString(36).substring(2, 8);
    const newUrl = `${window.location.protocol}//${window.location.host}${window.location.pathname}?doc=${docId}`;
    window.history.replaceState({ path: newUrl }, '', newUrl);
  }

  const state = {
    docId: docId,
    doc: null,
    me: {
      socketId: null,
      name: localStorage.getItem('rh_user_name') || '',
      color: localStorage.getItem('rh_user_color') || ''
    },
    activeUsers: [],
    activeCellId: null,
    peerCursors: new Map(), // socketId -> { cellId, cursor, user }
    viewMode: localStorage.getItem('rh_view_mode') || '3col', // 3col | split | reviewer-code | render
    theme: localStorage.getItem('rh_theme') || 'dark',
    activeFocusedTextarea: null,
    commentsFilter: 'open',
    activeHighlightSelection: null,
    reviewerFontSize: localStorage.getItem('rh_rev_font_size') || 'md' // sm | md | lg | xl
  };

  // Yjs CRDT real-time multi-peer collaboration engine
  let clientYDoc = null;
  const cellBindings = new Map(); // cellId -> { binding, unobserve }

  // Helper to escape HTML safely
  function escapeHtml(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // Convert HTML from clipboard (e.g. OpenReview, CMT, Google Docs) into clean Markdown with bullets
  function convertHtmlToMarkdown(html) {
    if (!html || !html.trim()) return '';
    const parser = new DOMParser();
    const doc = parser.parseFromString(html, 'text/html');

    function walk(node) {
      if (node.nodeType === Node.TEXT_NODE) {
        return node.textContent;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        return '';
      }

      const tag = node.tagName.toLowerCase();

      // Ordered list
      if (tag === 'ol') {
        const items = [];
        let idx = 1;
        for (const child of node.children) {
          if (child.tagName.toLowerCase() === 'li') {
            const itemText = walk(child).trim();
            if (itemText) {
              items.push(`${idx}. ${itemText}`);
              idx++;
            }
          }
        }
        return '\n\n' + items.join('\n') + '\n\n';
      }

      // Unordered list
      if (tag === 'ul') {
        const items = [];
        for (const child of node.children) {
          if (child.tagName.toLowerCase() === 'li') {
            const itemText = walk(child).trim();
            if (itemText) {
              items.push(`- ${itemText}`);
            }
          }
        }
        return '\n\n' + items.join('\n') + '\n\n';
      }

      let inner = '';
      for (const child of node.childNodes) {
        inner += walk(child);
      }

      switch (tag) {
        case 'p':
        case 'div':
          return '\n\n' + inner.trim() + '\n\n';
        case 'br':
          return '\n';
        case 'b':
        case 'strong':
          return `**${inner.trim()}**`;
        case 'i':
        case 'em':
          return `*${inner.trim()}*`;
        case 'code':
          return `\`${inner.trim()}\``;
        case 'h1':
          return `\n\n# ${inner.trim()}\n\n`;
        case 'h2':
          return `\n\n## ${inner.trim()}\n\n`;
        case 'h3':
        case 'h4':
        case 'h5':
        case 'h6':
          return `\n\n### ${inner.trim()}\n\n`;
        case 'blockquote':
          return `\n> ${inner.trim().replace(/\n/g, '\n> ')}\n`;
        default:
          return inner;
      }
    }

    return walk(doc.body)
      .replace(/\r\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // Normalize plain text with bullets into markdown lists
  function cleanPlainTextBullets(text) {
    if (!text) return '';
    return text
      // Replace bullet characters •, ·, ◦, ▪, ▫, ● with "- "
      .replace(/^[ \t]*[•·◦▪▫●]\s*/gm, '- ')
      // Replace numbered patterns like 1) or (1) with "1. "
      .replace(/^[ \t]*\(?([0-9]+)\)\s+/gm, '$1. ')
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');
  }

  // Helper to strip comments from countable text
  function getCountableText(text) {
    if (!text) return '';
    // Normalize Windows CRLF to LF so every newline is strictly counted as 1 character
    const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    // 1. Strip HTML comments <!-- ... -->
    const noHtml = normalized.replace(/<!--[\s\S]*?-->/g, '');
    // 2. Strip lines starting with // or %% (excluding their trailing newline from count)
    const countableLines = noHtml.split('\n')
      .filter(line => {
        const trimmed = line.trim();
        return !trimmed.startsWith('//') && !trimmed.startsWith('%%');
      });
    return countableLines.join('\n');
  }

  // Helper to colorize reviewer scores
  function getScoreClass(score) {
    const s = String(score || '').trim().toLowerCase();
    if (['8', '9', '10', 'strong accept', 'accept', 'sa', 'a'].includes(s)) return 'accept';
    if (['5', '6', '7', 'weak accept', 'borderline', 'wa', 'ba'].includes(s)) return 'borderline';
    if (['1', '2', '3', '4', 'reject', 'weak reject', 'r', 'wr'].includes(s)) return 'reject';
    const num = parseFloat(s);
    if (!isNaN(num)) {
      if (num >= 8) return 'accept';
      if (num >= 5) return 'borderline';
      return 'reject';
    }
    return '';
  }

  // Format relative timestamp helper
  function timeAgo(date) {
    const seconds = Math.floor((Date.now() - date) / 1000);
    if (seconds < 60) return 'Just now';
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m ago`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h ago`;
    const days = Math.floor(hours / 24);
    return `${days}d ago`;
  }

  // Preset Colors
  const PALETTE = [
    '#2563eb', '#059669', '#d97706', '#dc2626', '#7c3aed',
    '#db2777', '#0891b2', '#4f46e5', '#ea580c', '#16a34a'
  ];

  // DOM Elements
  const elDocTitleInput = document.getElementById('docTitleInput');
  const elSaveStatus = document.getElementById('saveStatus');
  const elGlobalCharCount = document.getElementById('globalCharCount');
  const elCharLimitSelect = document.getElementById('charLimitSelect');
  const elCustomLimitInput = document.getElementById('customLimitInput');
  const elCharProgressFill = document.getElementById('charProgressFill');
  const elGlobalWordCount = document.getElementById('globalWordCount');
  const elGlobalNoSpaceCount = document.getElementById('globalNoSpaceCount');
  const elActiveCountText = document.getElementById('activeCountText');
  const elAvatarStack = document.getElementById('avatarStack');
  const elMyAvatar = document.getElementById('myAvatar');
  const elMyName = document.getElementById('myName');
  const elHeaderInlineName = document.getElementById('headerInlineName');
  const elUserPill = document.getElementById('userPill');
  const elBtnShare = document.getElementById('btnShare');
  const elCellsList = document.getElementById('cellsList');
  const elBtnAddCellBottom = document.getElementById('btnAddCellBottom');
  const elBtnInsertTemplate = document.getElementById('btnInsertTemplate');
  const elBtnThemeToggle = document.getElementById('btnThemeToggle');
  const elBtnExportMenu = document.getElementById('btnExportMenu');
  const elExportDropdown = document.getElementById('exportDropdown');
  const elBtnCopyAllMarkdown = document.getElementById('btnCopyAllMarkdown');
  const elBtnOpenExportModal = document.getElementById('btnOpenExportModal');
  const elExportModal = document.getElementById('exportModal');
  const elBtnExportModalClose = document.getElementById('btnExportModalClose');
  const elBtnCloseExportModal = document.getElementById('btnCloseExportModal');
  const elBtnModalCopyMarkdown = document.getElementById('btnModalCopyMarkdown');
  const elExportModalTextarea = document.getElementById('exportModalTextarea');
  const elExportModalCharCount = document.getElementById('exportModalCharCount');
  const elBtnDownloadMarkdown = document.getElementById('btnDownloadMarkdown');
  const elBtnDownloadHTML = document.getElementById('btnDownloadHTML');
  const elToastContainer = document.getElementById('toastContainer');

  // Dedicated Quick Pastebox Elements
  const elQuickPasteboxCard = document.getElementById('quickPasteboxCard');
  const elBtnTogglePastebox = document.getElementById('btnTogglePastebox');
  const elPasteboxHeader = document.getElementById('pasteboxHeader');
  const elPasteboxTextarea = document.getElementById('pasteboxTextarea');
  const elPasteboxBackdrop = document.getElementById('pasteboxBackdrop');
  const elPasteboxPreview = document.getElementById('pasteboxPreview');
  const elPasteboxCharCount = document.getElementById('pasteboxCharCount');
  const elPasteboxWordCount = document.getElementById('pasteboxWordCount');
  const elBtnPasteboxComment = document.getElementById('btnPasteboxComment');
  const elBtnPasteboxCopy = document.getElementById('btnPasteboxCopy');
  const elBtnPasteboxClear = document.getElementById('btnPasteboxClear');

  // Universal Reviewer Font Size Stepper in Quick Toolbar
  const elBtnUniversalSizeDec = document.getElementById('btnUniversalSizeDec');
  const elUniversalSizeIndicator = document.getElementById('universalSizeIndicator');
  const elBtnUniversalSizeInc = document.getElementById('btnUniversalSizeInc');

  const REV_SIZES = ['sm', 'md', 'lg', 'xl'];
  const REV_SIZE_NAMES = { sm: 'Compact (12px)', md: 'Normal (14px)', lg: 'Large (16px)', xl: 'Extra Large (18px)' };

  function setGlobalReviewerFontSize(newSize, notify = true) {
    state.reviewerFontSize = newSize;
    localStorage.setItem('rh_rev_font_size', newSize);
    document.querySelectorAll('.reviewer-body-area').forEach(el => {
      el.classList.remove('reviewer-size-sm', 'reviewer-size-md', 'reviewer-size-lg', 'reviewer-size-xl');
      el.classList.add(`reviewer-size-${newSize}`);
    });
    if (elUniversalSizeIndicator) {
      elUniversalSizeIndicator.textContent = 'Aa';
      elUniversalSizeIndicator.title = `Current reviewer font size: ${REV_SIZE_NAMES[newSize]} (Click to cycle)`;
    }
    if (notify) {
      showToast(`Reviewer text size: ${REV_SIZE_NAMES[newSize]}`, 'info');
    }
  }

  if (elBtnUniversalSizeDec) {
    elBtnUniversalSizeDec.addEventListener('click', () => {
      const idx = REV_SIZES.indexOf(state.reviewerFontSize || 'md');
      if (idx > 0) setGlobalReviewerFontSize(REV_SIZES[idx - 1]);
    });
  }

  if (elBtnUniversalSizeInc) {
    elBtnUniversalSizeInc.addEventListener('click', () => {
      const idx = REV_SIZES.indexOf(state.reviewerFontSize || 'md');
      if (idx < REV_SIZES.length - 1) setGlobalReviewerFontSize(REV_SIZES[idx + 1]);
    });
  }

  if (elUniversalSizeIndicator) {
    elUniversalSizeIndicator.addEventListener('click', () => {
      const idx = REV_SIZES.indexOf(state.reviewerFontSize || 'md');
      const nextIdx = (idx + 1) % REV_SIZES.length;
      setGlobalReviewerFontSize(REV_SIZES[nextIdx]);
    });
  }

  // Comments Sidebar & Floating bubble elements
  const elBtnToggleComments = document.getElementById('btnToggleComments');
  const elCommentsCountBadge = document.getElementById('commentsCountBadge');
  const elCommentsSidebar = document.getElementById('commentsSidebar');
  const elBtnCloseCommentsSidebar = document.getElementById('btnCloseCommentsSidebar');
  const elCommentsList = document.getElementById('commentsList');
  const elTabOpenComments = document.getElementById('tabOpenComments');
  const elTabResolvedComments = document.getElementById('tabResolvedComments');
  const elTabAllComments = document.getElementById('tabAllComments');

  const elFloatingCommentPill = document.getElementById('floatingCommentPill');
  const elBtnTriggerAddComment = document.getElementById('btnTriggerAddComment');
  const elCommentInputBubble = document.getElementById('commentInputBubble');
  const elBubbleAuthorName = document.getElementById('bubbleAuthorName');
  const elBubbleQuoteText = document.getElementById('bubbleQuoteText');
  const elBubbleCommentInput = document.getElementById('bubbleCommentInput');
  const elBtnCancelBubble = document.getElementById('btnCancelBubble');
  const elBtnSubmitBubble = document.getElementById('btnSubmitBubble');

  // Boards Manager elements
  const elBtnBoardsManager = document.getElementById('btnBoardsManager');
  const elBoardsCountBadge = document.getElementById('boardsCountBadge');
  const elBoardsModal = document.getElementById('boardsModal');
  const elBtnBoardsModalClose = document.getElementById('btnBoardsModalClose');
  const elBtnCloseBoardsModal = document.getElementById('btnCloseBoardsModal');
  const elTabBoardsList = document.getElementById('tabBoardsList');
  const elTabNewBoard = document.getElementById('tabNewBoard');
  const elBoardsListView = document.getElementById('boardsListView');
  const elNewBoardView = document.getElementById('newBoardView');
  const elBoardsSearchInput = document.getElementById('boardsSearchInput');
  const elBtnGoCreateBoard = document.getElementById('btnGoCreateBoard');
  const elBoardsCardsGrid = document.getElementById('boardsCardsGrid');
  const elCreateBoardForm = document.getElementById('createBoardForm');
  const elNewBoardTitle = document.getElementById('newBoardTitle');
  const elNewBoardId = document.getElementById('newBoardId');
  const elNewBoardLimit = document.getElementById('newBoardLimit');
  const elReviewerCountChips = document.getElementById('reviewerCountChips');
  const elNewBoardReviewerNames = document.getElementById('newBoardReviewerNames');
  const elBtnCancelCreateBoard = document.getElementById('btnCancelCreateBoard');

  // Revision History elements
  const elBtnOpenHistory = document.getElementById('btnOpenHistory');
  const elHistoryModal = document.getElementById('historyModal');
  const elBtnHistoryModalClose = document.getElementById('btnHistoryModalClose');
  const elBtnCloseHistoryModal = document.getElementById('btnCloseHistoryModal');
  const elHistoryList = document.getElementById('historyList');

  // Quick toolbar line comment button
  const elBtnToggleLineComment = document.getElementById('btnToggleLineComment');

  // Modal elements
  const elProfileModal = document.getElementById('profileModal');
  const elBtnProfileModalClose = document.getElementById('btnProfileModalClose');
  const elInputUserName = document.getElementById('inputUserName');
  const elColorPickerGrid = document.getElementById('colorPickerGrid');
  const elBtnSaveProfile = document.getElementById('btnSaveProfile');

  // View Mode buttons
  const viewModeBtns = document.querySelectorAll('.view-btn');

  // Quick Format helper buttons
  const quickFormatBtns = document.querySelectorAll('.quick-btn');

  // --- Initialize Socket.IO ---
  const socket = io();

  // --- Setup Theme ---
  function initTheme() {
    document.body.className = `theme-${state.theme}`;
  }
  initTheme();

  elBtnThemeToggle.addEventListener('click', () => {
    state.theme = state.theme === 'dark' ? 'light' : 'dark';
    localStorage.setItem('rh_theme', state.theme);
    initTheme();
  });

  // --- Setup View Mode ---
  function setViewMode(mode) {
    state.viewMode = mode;
    localStorage.setItem('rh_view_mode', mode);
    document.body.classList.remove('view-mode-3col', 'view-mode-split', 'view-mode-reviewer-code', 'view-mode-render');
    document.body.classList.add(`view-mode-${mode}`);

    viewModeBtns.forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });
  }
  setViewMode(state.viewMode);

  viewModeBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      setViewMode(btn.dataset.view);
    });
  });

  // --- Socket.IO Event Handlers ---

  socket.on('connect', () => {
    console.log('Connected to collaboration server with ID:', socket.id);
    socket.emit('join-doc', {
      docId: state.docId,
      userName: state.me.name,
      userColor: state.me.color
    });
  });

  socket.on('init-doc', ({ doc, yjsState, user, activeUsers }) => {
    // Clean up existing Yjs cell bindings
    cellBindings.forEach(b => {
      try {
        if (b.binding && b.binding.destroy) b.binding.destroy();
        if (b.unobserve) b.unobserve();
      } catch (e) {}
    });
    cellBindings.clear();

    state.doc = doc;
    state.me = user;
    localStorage.setItem('rh_user_name', user.name);
    localStorage.setItem('rh_user_color', user.color);

    // Initialize client Yjs Document with CRDT state from server
    if (window.Y && yjsState) {
      clientYDoc = new window.Y.Doc();
      try {
        const binState = Uint8Array.from(atob(yjsState), c => c.charCodeAt(0));
        window.Y.applyUpdate(clientYDoc, binState);
      } catch (err) {
        console.error('Failed to parse initial Yjs state:', err);
      }

      clientYDoc.on('update', (update, origin) => {
        if (origin !== 'socket-remote') {
          socket.emit('yjs-update', {
            docId: state.docId,
            update: Array.from(update)
          });
        }
      });
    }

    updateMyProfileUI();
    updatePresenceUI(activeUsers);

    // Initialize Dedicated Quick Pastebox
    if (elQuickPasteboxCard && elPasteboxTextarea) {
      let pasteboxContent = (doc.pastebox && doc.pastebox.content) || '';
      // If empty, auto-migrate legacy fake 'Pastebox' or 'Quick Paste' cell if present
      if (!pasteboxContent.trim() && Array.isArray(doc.cells)) {
        const legacyCell = doc.cells.find(c =>
          c.title?.toLowerCase().includes('pastebox') ||
          c.reviewerName?.toLowerCase().includes('quick paste')
        );
        if (legacyCell && legacyCell.content) {
          pasteboxContent = legacyCell.content;
        }
      }
      elPasteboxTextarea.value = pasteboxContent;

      const isCollapsed = doc.pastebox && doc.pastebox.collapsed;
      elQuickPasteboxCard.classList.toggle('collapsed', Boolean(isCollapsed));
      updatePasteboxUI();
    }

    renderDocument();
  });

  // Receive real-time pastebox update from peer
  socket.on('pastebox-updated', ({ content, collapsed }) => {
    if (elPasteboxTextarea && elPasteboxTextarea !== document.activeElement && content !== undefined) {
      elPasteboxTextarea.value = content || '';
      updatePasteboxUI();
    }
    if (elQuickPasteboxCard && collapsed !== undefined) {
      elQuickPasteboxCard.classList.toggle('collapsed', Boolean(collapsed));
    }
  });

  // Receive Yjs CRDT real-time character update from peer
  socket.on('yjs-update', ({ update }) => {
    if (clientYDoc && window.Y && Array.isArray(update)) {
      try {
        const binUpdate = new Uint8Array(update);
        window.Y.applyUpdate(clientYDoc, binUpdate, 'socket-remote');
      } catch (err) {
        console.error('Failed to apply peer Yjs update:', err);
      }
    }
  });

  socket.on('presence-update', (users) => {
    updatePresenceUI(users);
  });

  socket.on('user-joined', (user) => {
    showToast(`👋 ${user.name} joined the session`, 'info');
  });

  socket.on('user-left', ({ socketId }) => {
    state.peerCursors.delete(socketId);
    renderPeerCursors();
  });

  // Remote cell content updated by another user (used as fallback when Yjs not active)
  socket.on('cell-updated', ({ cellId, content }) => {
    if (clientYDoc) return; // Handled character-by-character by Yjs CRDT
    if (!state.doc) return;
    const cell = state.doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.content = content;
      // Update UI for this cell
      const textarea = document.getElementById(`textarea-${cellId}`);
      const renderCol = document.getElementById(`render-${cellId}`);

      if (textarea && textarea !== document.activeElement) {
        // Only update textarea if user is not actively typing in it
        textarea.value = content;
        autoResizeTextarea(textarea);
      }

      renderEditorBackdrop(cellId);

      if (renderCol) {
        renderCellPreview(cellId, content);
      }

      updateCellCharCount(cellId, content);
      updateGlobalCharCount();
    }
  });

  // Remote cursor movement
  socket.on('cursor-moved', ({ socketId, user, cellId, cursor }) => {
    state.peerCursors.set(socketId, { user, cellId, cursor });
    renderPeerCursors();
  });

  socket.on('cursor-cleared', ({ socketId }) => {
    state.peerCursors.delete(socketId);
    renderPeerCursors();
  });

  // Document cells list structure updated (add/delete/move/duplicate)
  socket.on('doc-cells-updated', ({ cells }) => {
    if (!state.doc) return;
    state.doc.cells = cells;
    renderDocument();
  });

  // Document title updated
  socket.on('doc-title-updated', ({ title }) => {
    if (!state.doc) return;
    state.doc.title = title;
    elDocTitleInput.value = title;
  });

  // Document character limit updated
  socket.on('doc-limit-updated', ({ targetCharLimit }) => {
    if (!state.doc) return;
    state.doc.targetCharLimit = targetCharLimit;
    syncLimitSelectUI(targetCharLimit);
    updateGlobalCharCount();
  });

  // Cell title updated
  socket.on('cell-title-updated', ({ cellId, title }) => {
    if (!state.doc) return;
    const cell = state.doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.title = title;
      const titleInput = document.getElementById(`cell-title-${cellId}`);
      if (titleInput && titleInput !== document.activeElement) {
        titleInput.value = title;
      }
      updateGlobalCharCount();
    }
  });

  // Cell reviewer info updated
  socket.on('cell-reviewer-updated', ({ cellId, reviewerName, reviewerScore, reviewerComment }) => {
    if (!state.doc) return;
    const cell = state.doc.cells.find(c => c.id === cellId);
    if (cell) {
      if (reviewerName !== undefined) cell.reviewerName = reviewerName;
      if (reviewerScore !== undefined) cell.reviewerScore = reviewerScore;
      if (reviewerComment !== undefined) cell.reviewerComment = reviewerComment;

      const nameInput = document.getElementById(`reviewer-name-${cellId}`);
      if (nameInput && nameInput !== document.activeElement) {
        nameInput.value = cell.reviewerName || '';
      }

      const scoreBadge = document.getElementById(`score-badge-${cellId}`);
      if (scoreBadge) {
        scoreBadge.textContent = cell.reviewerScore || 'Score';
        scoreBadge.className = `score-badge ${getScoreClass(cell.reviewerScore)}`;
      }

      const ribbonScore = document.getElementById(`ribbon-score-${cellId}`);
      if (ribbonScore) {
        ribbonScore.textContent = cell.reviewerScore || '-';
        ribbonScore.className = `ribbon-score-pill ${getScoreClass(cell.reviewerScore)}`;
      }

      const ribbonTag = document.getElementById(`ribbon-tag-${cellId}`);
      if (ribbonTag) {
        ribbonTag.textContent = cell.reviewerName || 'Reviewer';
      }

      const commentTextarea = document.getElementById(`reviewer-comment-${cellId}`);
      if (commentTextarea && commentTextarea !== document.activeElement) {
        commentTextarea.value = cell.reviewerComment || '';
      }

      const commentPreview = document.getElementById(`reviewer-preview-${cellId}`);
      if (commentPreview) {
        const raw = cell.reviewerComment ? cell.reviewerComment.trim() : '';
        if (!raw) {
          commentPreview.innerHTML = '<div class="reviewer-empty-placeholder">📝 Empty reviewer comment. Click or paste text here.</div>';
        } else if (window.MarkdownMath && typeof window.MarkdownMath.render === 'function') {
          commentPreview.innerHTML = window.MarkdownMath.render(raw);
        } else {
          commentPreview.textContent = raw;
        }
      }

      updateGlobalCharCount();
    }
  });

  // Cell reviewer collapsed state toggled
  socket.on('cell-reviewer-collapse-updated', ({ cellId, collapsed }) => {
    if (!state.doc) return;
    const cell = state.doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.reviewerCollapsed = collapsed;
      const card = document.getElementById(`cell-card-${cellId}`);
      if (card) {
        card.classList.toggle('reviewer-collapsed', collapsed);
      }
    }
  });

  // --- Render Entire Document ---

  function renderDocument() {
    if (!state.doc) return;

    // Document title
    elDocTitleInput.value = state.doc.title || 'Paper Rebuttal';

    // Char limit
    syncLimitSelectUI(state.doc.targetCharLimit);

    // Render cells
    elCellsList.replaceChildren();

    state.doc.cells.forEach((cell, index) => {
      // Cell card element
      const cellCard = createCellElement(cell, index);
      elCellsList.appendChild(cellCard);

      // Add hover divider between cells (except after the very last one)
      if (index < state.doc.cells.length - 1) {
        const divider = createCellDivider(cell.id);
        elCellsList.appendChild(divider);
      }
    });

    // Initial render for all previews, editor syntax backdrops and char counts
    state.doc.cells.forEach(cell => {
      renderEditorBackdrop(cell.id);
      renderCellPreview(cell.id, cell.content);
      updateCellCharCount(cell.id, cell.content);
    });

    updateGlobalCharCount();
    renderPeerCursors();
    renderCommentsList();
  }

  // --- Create Single Cell DOM Element ---

  function createCellElement(cell, index) {
    const card = document.createElement('div');
    card.className = 'cell-card';
    card.id = `cell-card-${cell.id}`;
    card.dataset.cellId = cell.id;

    // Header
    const header = document.createElement('div');
    header.className = 'cell-header';

    const headerLeft = document.createElement('div');
    headerLeft.className = 'cell-header-left';

    const indexBadge = document.createElement('span');
    indexBadge.className = 'cell-index-badge';
    indexBadge.textContent = `#${index + 1}`;

    const titleInput = document.createElement('input');
    titleInput.type = 'text';
    titleInput.id = `cell-title-${cell.id}`;
    titleInput.className = 'cell-title-input';
    titleInput.value = cell.title || `Cell #${index + 1}`;
    titleInput.placeholder = 'Cell label or reviewer item...';
    titleInput.addEventListener('input', (e) => {
      cell.title = e.target.value;
      updateGlobalCharCount();
      socket.emit('cell-title-update', { cellId: cell.id, title: e.target.value });
    });

    const peerBadgeContainer = document.createElement('div');
    peerBadgeContainer.id = `peer-badge-${cell.id}`;

    headerLeft.appendChild(indexBadge);
    headerLeft.appendChild(titleInput);
    headerLeft.appendChild(peerBadgeContainer);

    // Header Actions
    const headerActions = document.createElement('div');
    headerActions.className = 'cell-header-actions';

    // Move Up
    const btnUp = document.createElement('button');
    btnUp.className = 'cell-action-btn';
    btnUp.title = 'Move cell up';
    btnUp.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="18 15 12 9 6 15"/></svg>`;
    btnUp.addEventListener('click', () => socket.emit('cell-move', { cellId: cell.id, direction: 'up' }));

    // Move Down
    const btnDown = document.createElement('button');
    btnDown.className = 'cell-action-btn';
    btnDown.title = 'Move cell down';
    btnDown.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>`;
    btnDown.addEventListener('click', () => socket.emit('cell-move', { cellId: cell.id, direction: 'down' }));

    // Duplicate
    const btnDup = document.createElement('button');
    btnDup.className = 'cell-action-btn';
    btnDup.title = 'Duplicate cell';
    btnDup.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>`;
    btnDup.addEventListener('click', () => socket.emit('cell-duplicate', { cellId: cell.id }));

    // Delete
    const btnDelete = document.createElement('button');
    btnDelete.className = 'cell-action-btn delete-btn';
    btnDelete.title = 'Delete cell';
    btnDelete.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    btnDelete.addEventListener('click', () => {
      if (state.doc.cells.length <= 1) {
        showToast('Document must have at least one cell', 'info');
        return;
      }
      socket.emit('cell-delete', { cellId: cell.id });
    });

    headerActions.appendChild(btnUp);
    headerActions.appendChild(btnDown);
    headerActions.appendChild(btnDup);
    headerActions.appendChild(btnDelete);

    header.appendChild(headerLeft);
    header.appendChild(headerActions);
    card.appendChild(header);

    // Cell Body: 3 Columns (Reviewer | Code | Render)
    const body = document.createElement('div');
    body.className = 'cell-body';

    if (cell.reviewerCollapsed) {
      card.classList.add('reviewer-collapsed');
    }

    // =========================================================
    // Column 1: Reviewer Panel (Left)
    // =========================================================
    const reviewerCol = document.createElement('div');
    reviewerCol.className = 'cell-reviewer-column';
    reviewerCol.id = `reviewer-col-${cell.id}`;

    // 1A. Collapsed Ribbon (visible when folded)
    const ribbon = document.createElement('div');
    ribbon.className = 'reviewer-collapsed-ribbon';
    ribbon.title = 'Click to expand reviewer comments';

    const btnExpand = document.createElement('button');
    btnExpand.className = 'ribbon-expand-btn';
    btnExpand.title = 'Expand Reviewer Panel';
    btnExpand.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>`;

    const ribbonScore = document.createElement('span');
    ribbonScore.id = `ribbon-score-${cell.id}`;
    ribbonScore.className = `ribbon-score-pill ${getScoreClass(cell.reviewerScore)}`;
    ribbonScore.textContent = cell.reviewerScore || '-';

    const ribbonTag = document.createElement('span');
    ribbonTag.id = `ribbon-tag-${cell.id}`;
    ribbonTag.className = 'ribbon-vertical-tag';
    ribbonTag.textContent = cell.reviewerName || 'Reviewer';

    ribbon.appendChild(btnExpand);
    ribbon.appendChild(ribbonScore);
    ribbon.appendChild(ribbonTag);

    const toggleCollapse = (collapsed) => {
      cell.reviewerCollapsed = collapsed;
      card.classList.toggle('reviewer-collapsed', collapsed);
      socket.emit('cell-reviewer-toggle-collapse', { cellId: cell.id, collapsed });
    };

    btnExpand.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleCollapse(false);
    });

    ribbon.addEventListener('click', () => {
      toggleCollapse(false);
    });

    // 1B. Expanded Content Wrapper
    const reviewerWrap = document.createElement('div');
    reviewerWrap.className = 'reviewer-content-wrapper';

    // Reviewer Header Bar (Reviewer name & score)
    const revHeader = document.createElement('div');
    revHeader.className = 'reviewer-header-bar';

    const revNameInput = document.createElement('input');
    revNameInput.type = 'text';
    revNameInput.id = `reviewer-name-${cell.id}`;
    revNameInput.className = 'reviewer-name-input';
    revNameInput.value = cell.reviewerName || 'Reviewer';
    revNameInput.placeholder = 'e.g. jV3P, R1';
    revNameInput.title = 'Reviewer identifier (e.g. jV3P or Reviewer 1)';

    const revScoreWrap = document.createElement('div');
    revScoreWrap.className = 'reviewer-score-wrap';

    const scoreBadge = document.createElement('span');
    scoreBadge.id = `score-badge-${cell.id}`;
    scoreBadge.className = `score-badge ${getScoreClass(cell.reviewerScore)}`;
    scoreBadge.textContent = cell.reviewerScore || '6';

    const scoreSelect = document.createElement('select');
    scoreSelect.className = 'score-select';
    scoreSelect.title = 'Select or enter score';
    const scorePresets = [
      { val: '10', label: '10 (Strong Accept)' },
      { val: '8', label: '8 (Accept)' },
      { val: '6', label: '6 (Weak Accept)' },
      { val: '5', label: '5 (Borderline)' },
      { val: '4', label: '4 (Borderline Reject)' },
      { val: '3', label: '3 (Reject)' },
      { val: '1', label: '1 (Strong Reject)' },
      { val: 'Overview', label: 'All / Overview' },
      { val: 'custom', label: 'Custom...' }
    ];

    scorePresets.forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.val;
      opt.textContent = p.label;
      if (cell.reviewerScore === p.val) opt.selected = true;
      scoreSelect.appendChild(opt);
    });

    revScoreWrap.appendChild(scoreBadge);
    revScoreWrap.appendChild(scoreSelect);

    const btnCollapse = document.createElement('button');
    btnCollapse.className = 'reviewer-collapse-btn';
    btnCollapse.title = 'Collapse Reviewer Panel';
    btnCollapse.innerHTML = `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>`;
    btnCollapse.addEventListener('click', () => {
      toggleCollapse(true);
    });

    revHeader.appendChild(revNameInput);
    revHeader.appendChild(revScoreWrap);
    revHeader.appendChild(btnCollapse);

    // Reviewer Body Area (Original Comments + Quote Action)
    const revBody = document.createElement('div');
    revBody.className = `reviewer-body-area reviewer-size-${state.reviewerFontSize || 'md'}`;

    const labelRow = document.createElement('div');
    labelRow.className = 'reviewer-label-hint';

    const labelTitle = document.createElement('span');
    labelTitle.textContent = 'Original Review / Question';

    const labelActions = document.createElement('div');
    labelActions.className = 'reviewer-label-actions';

    // Aa Font Size Stepper Control
    // Reviewer Edit Toggle Button (Always labeled "✏️ Edit", highlighted/ON when editing)
    const btnToggleMode = document.createElement('button');
    btnToggleMode.type = 'button';
    btnToggleMode.className = 'btn-rev-mode-toggle';
    btnToggleMode.textContent = '✏️ Edit';
    btnToggleMode.title = 'Edit reviewer comments';

    labelActions.appendChild(btnToggleMode);

    labelRow.appendChild(labelTitle);
    labelRow.appendChild(labelActions);

    // Rendered Markdown Preview
    const revPreview = document.createElement('div');
    revPreview.id = `reviewer-preview-${cell.id}`;
    revPreview.className = 'reviewer-comment-preview markdown-body';
    revPreview.title = 'Double-click to edit · Highlight text to quote';

    // Textarea Editor
    const revComment = document.createElement('textarea');
    revComment.id = `reviewer-comment-${cell.id}`;
    revComment.className = 'reviewer-comment-textarea';
    revComment.placeholder = 'Paste reviewer comments, criticism, or questions here... (Bullets 1. 2. - and Markdown supported)';
    revComment.value = cell.reviewerComment || '';

    // Function to render markdown preview
    const updatePreview = () => {
      const raw = cell.reviewerComment ? cell.reviewerComment.trim() : '';
      if (!raw) {
        revPreview.innerHTML = '<div class="reviewer-empty-placeholder">📝 Empty reviewer comments. Click Edit to paste or type markdown.</div>';
      } else {
        if (window.MarkdownMath && typeof window.MarkdownMath.render === 'function') {
          revPreview.innerHTML = window.MarkdownMath.render(raw);
        } else {
          revPreview.textContent = raw;
        }
      }
    };

    // Mode state for this cell (Show ONLY view mode by default)
    let isEditing = false;

    const applyMode = () => {
      if (isEditing) {
        revPreview.classList.add('hidden');
        revComment.classList.remove('hidden');
        btnToggleMode.classList.add('active');
        btnToggleMode.title = 'Finish editing reviewer comments';
        autoResizeReviewerTextarea(revComment);
      } else {
        updatePreview();
        revPreview.classList.remove('hidden');
        revComment.classList.add('hidden');
        btnToggleMode.classList.remove('active');
        btnToggleMode.title = 'Edit reviewer comments';
      }
    };

    updatePreview();
    applyMode();

    btnToggleMode.addEventListener('click', (e) => {
      e.stopPropagation();
      isEditing = !isEditing;
      applyMode();
      if (isEditing) {
        revComment.focus();
      }
    });

    revPreview.addEventListener('dblclick', () => {
      isEditing = true;
      applyMode();
      revComment.focus();
    });

    revPreview.addEventListener('click', (e) => {
      if (!cell.reviewerComment || !cell.reviewerComment.trim()) {
        isEditing = true;
        applyMode();
        revComment.focus();
      }
    });



    // Clipboard Paste conversion: preserve bullet points and HTML lists
    revComment.addEventListener('paste', (e) => {
      const html = e.clipboardData ? e.clipboardData.getData('text/html') : '';
      const plain = e.clipboardData ? e.clipboardData.getData('text/plain') : '';

      let formatted = '';
      if (html && (html.includes('<ul') || html.includes('<ol') || html.includes('<li') || html.includes('<p>') || html.includes('<p '))) {
        formatted = convertHtmlToMarkdown(html);
      }
      if (!formatted && plain) {
        formatted = cleanPlainTextBullets(plain);
      }

      if (formatted && formatted !== plain) {
        e.preventDefault();
        const start = revComment.selectionStart;
        const end = revComment.selectionEnd;
        const val = revComment.value;
        revComment.value = val.substring(0, start) + formatted + val.substring(end);
        revComment.selectionStart = revComment.selectionEnd = start + formatted.length;
        revComment.dispatchEvent(new Event('input'));
        autoResizeReviewerTextarea(revComment);
        showToast('Preserved formatted bullet points!', 'success');
      }
    });

    revBody.appendChild(labelRow);
    revBody.appendChild(revPreview);
    revBody.appendChild(revComment);

    reviewerWrap.appendChild(revHeader);
    reviewerWrap.appendChild(revBody);

    reviewerCol.appendChild(ribbon);
    reviewerCol.appendChild(reviewerWrap);

    // Event listeners for reviewer fields
    let revDebounce = null;
    const emitReviewerUpdate = () => {
      clearTimeout(revDebounce);
      revDebounce = setTimeout(() => {
        socket.emit('cell-reviewer-update', {
          cellId: cell.id,
          reviewerName: cell.reviewerName,
          reviewerScore: cell.reviewerScore,
          reviewerComment: cell.reviewerComment
        });
      }, 150);
    };

    revNameInput.addEventListener('input', (e) => {
      cell.reviewerName = e.target.value;
      ribbonTag.textContent = cell.reviewerName || 'Reviewer';
      updateGlobalCharCount();
      emitReviewerUpdate();
    });

    scoreSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        const customScore = prompt('Enter custom score or tag (e.g. 7 or WA):', cell.reviewerScore || '6');
        if (customScore !== null) {
          cell.reviewerScore = customScore.trim();
        }
      } else {
        cell.reviewerScore = e.target.value;
      }
      scoreBadge.textContent = cell.reviewerScore || 'Score';
      scoreBadge.className = `score-badge ${getScoreClass(cell.reviewerScore)}`;
      ribbonScore.textContent = cell.reviewerScore || '-';
      ribbonScore.className = `ribbon-score-pill ${getScoreClass(cell.reviewerScore)}`;
      emitReviewerUpdate();
    });

    revComment.addEventListener('input', (e) => {
      cell.reviewerComment = e.target.value;
      autoResizeReviewerTextarea(revComment);
      emitReviewerUpdate();
    });

    // =========================================================
    // Column 2: Code / Markdown Editor (Center)
    // =========================================================
    const editorCol = document.createElement('div');
    editorCol.className = 'cell-editor-column';

    const textareaWrap = document.createElement('div');
    textareaWrap.className = 'editor-textarea-wrapper';

    const textarea = document.createElement('textarea');
    textarea.id = `textarea-${cell.id}`;
    textarea.className = 'cell-textarea';
    textarea.value = cell.content || '';
    textarea.placeholder = 'Type Markdown or LaTeX equations ($...$ or $$...$$)...';
    textarea.spellcheck = false;



    // Editor Syntax Backdrop Layer (for gray commented lines & highlighted text)
    const backdrop = document.createElement('div');
    backdrop.id = `syntax-backdrop-${cell.id}`;
    backdrop.className = 'editor-syntax-backdrop';

    // Remote cursor ghost layer
    const cursorContainer = document.createElement('div');
    cursorContainer.id = `cursor-container-${cell.id}`;
    cursorContainer.className = 'remote-cursor-container';

    textareaWrap.appendChild(backdrop);
    textareaWrap.appendChild(cursorContainer);
    textareaWrap.appendChild(textarea);

    // Sticky header above editor: Real-time Character Counter
    const footer = document.createElement('div');
    footer.className = 'cell-editor-footer';

    const counterDiv = document.createElement('div');
    counterDiv.id = `char-counter-${cell.id}`;
    counterDiv.className = 'char-counter-details';
    footer.appendChild(counterDiv);

    editorCol.appendChild(footer);
    editorCol.appendChild(textareaWrap);

    // =========================================================
    // Column 3: Rendered Markdown & Math Preview (Right)
    // =========================================================
    const renderCol = document.createElement('div');
    renderCol.className = 'cell-render-column';

    const preview = document.createElement('div');
    preview.id = `render-${cell.id}`;
    preview.className = 'markdown-preview';
    renderCol.appendChild(preview);

    body.appendChild(reviewerCol);
    body.appendChild(editorCol);
    body.appendChild(renderCol);
    card.appendChild(body);

    // Bind to Yjs Text CRDT for character-level simultaneous editing (Google Docs style)
    if (clientYDoc && window.Y && window.TextAreaBinding) {
      const yText = clientYDoc.getText('cell-' + cell.id);
      if (yText.length === 0 && cell.content) {
        yText.insert(0, cell.content);
      }
      try {
        const binding = new window.TextAreaBinding(yText, textarea);

        const observer = () => {
          const newText = yText.toString();
          cell.content = newText;
          autoResizeTextarea(textarea);
          renderEditorBackdrop(cell.id);
          renderCellPreview(cell.id, newText);
          updateCellCharCount(cell.id, newText);
          updateGlobalCharCount();
        };

        yText.observe(observer);
        cellBindings.set(cell.id, {
          binding,
          unobserve: () => yText.unobserve(observer)
        });
      } catch (err) {
        console.error('Failed to bind textarea to Yjs:', err);
      }
    }

    // Event Listeners for Editor
    let debounceTimer = null;

    // Refresh the info bar's "Selected" count whenever the highlighted range changes
    const refreshSelectionCount = () => updateCellCharCount(cell.id, textarea.value);
    ['select', 'mouseup', 'keyup', 'focus', 'blur'].forEach((evt) =>
      textarea.addEventListener(evt, refreshSelectionCount)
    );

    textarea.addEventListener('input', () => {
      const text = textarea.value;
      cell.content = text;
      autoResizeTextarea(textarea);

      // Realtime local syntax backdrop, preview & character counts
      renderEditorBackdrop(cell.id);
      renderCellPreview(cell.id, text);
      updateCellCharCount(cell.id, text);
      updateGlobalCharCount();

      // Emit cursor movement so collaborators see remote cursor tag
      socket.emit('cursor-move', {
        cellId: cell.id,
        cursor: {
          start: textarea.selectionStart,
          end: textarea.selectionEnd
        }
      });

      // If Yjs is not active, fallback to debounced whole-cell update
      if (!clientYDoc) {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          socket.emit('cell-update', {
            cellId: cell.id,
            content: text,
            cursor: {
              start: textarea.selectionStart,
              end: textarea.selectionEnd
            }
          });
        }, 150);
      }
    });

    textarea.addEventListener('focus', () => {
      state.activeFocusedTextarea = textarea;
      state.activeCellId = cell.id;
      socket.emit('cursor-move', {
        cellId: cell.id,
        cursor: {
          start: textarea.selectionStart,
          end: textarea.selectionEnd
        }
      });
    });

    textarea.addEventListener('keyup', (e) => {
      if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) {
        socket.emit('cursor-move', {
          cellId: cell.id,
          cursor: {
            start: textarea.selectionStart,
            end: textarea.selectionEnd
          }
        });
      }
    });

    textarea.addEventListener('mousemove', (e) => {
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const hasComment = elements.some(el => el.classList && el.classList.contains('syntax-commented-text'));
      textarea.style.cursor = hasComment ? 'pointer' : 'text';
    });

    textarea.addEventListener('click', (e) => {
      socket.emit('cursor-move', {
        cellId: cell.id,
        cursor: {
          start: textarea.selectionStart,
          end: textarea.selectionEnd
        }
      });

      // 1. Direct hit on syntax-commented-text backdrop span via coordinates
      const elements = document.elementsFromPoint(e.clientX, e.clientY);
      const commentSpan = elements.find(el => el.classList && el.classList.contains('syntax-commented-text'));
      if (commentSpan && commentSpan.dataset.commentId) {
        openCommentsSidebarAndSelect(commentSpan.dataset.commentId);
        return;
      }

      // 2. Check via character cursor position in textarea
      setTimeout(() => {
        checkCommentClickInEditor(cell.id, textarea.selectionStart, textarea.selectionEnd);
      }, 0);
    });

    textarea.addEventListener('blur', () => {
      socket.emit('cell-blur', { cellId: cell.id });
    });

    // Keyboard Shortcuts inside Textarea
    textarea.addEventListener('keydown', (e) => {
      // Ctrl + / or Cmd + /: Toggle line comment (excluded from count)
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleLineCommentOnTextarea(textarea);
      }

      // Shift + Enter: Add new cell below
      if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        socket.emit('cell-add', { afterCellId: cell.id });
      }

      // Tab key: Insert 2 spaces instead of losing focus
      if (e.key === 'Tab') {
        e.preventDefault();
        const start = textarea.selectionStart;
        const end = textarea.selectionEnd;
        textarea.value = textarea.value.substring(0, start) + '  ' + textarea.value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + 2;
        textarea.dispatchEvent(new Event('input'));
      }
    });

    // Synchronize scrolling and dimensions between textarea and syntax backdrop
    textarea.addEventListener('scroll', () => {
      syncBackdropScroll(textarea, backdrop);
    });

    if (window.ResizeObserver) {
      const ro = new ResizeObserver(() => {
        syncBackdropScroll(textarea, backdrop);
      });
      ro.observe(textarea);
    }

    // Auto-resize and render backdrop on initial render
    setTimeout(() => {
      autoResizeTextarea(textarea);
      renderEditorBackdrop(cell.id);
    }, 0);

    return card;
  }

  // Toggle // line comment on current selection or line
  function toggleLineCommentOnTextarea(textarea) {
    if (!textarea) return;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    const value = textarea.value;

    const lineStart = value.lastIndexOf('\n', start - 1) + 1;
    let lineEnd = value.indexOf('\n', end);
    if (lineEnd === -1) lineEnd = value.length;

    const selectedLines = value.substring(lineStart, lineEnd).split('\n');
    const allCommented = selectedLines.every(l => l.trim().startsWith('//'));

    const toggledLines = selectedLines.map(line => {
      if (allCommented) {
        return line.replace(/^(\s*)\/\/\s?/, '$1');
      } else {
        return `// ${line}`;
      }
    });

    const replacement = toggledLines.join('\n');
    textarea.value = value.substring(0, lineStart) + replacement + value.substring(lineEnd);
    textarea.selectionStart = lineStart;
    textarea.selectionEnd = lineStart + replacement.length;
    textarea.dispatchEvent(new Event('input'));
  }

  // Auto-resize textarea to fit content
  function autoResizeTextarea(textarea) {
    if (!textarea) return;
    textarea.style.height = 'auto';
    const newHeight = Math.max(180, textarea.scrollHeight);
    textarea.style.minHeight = `${newHeight}px`;
    textarea.style.height = '100%';
  }

  // Auto-resize reviewer textarea to fit content
  function autoResizeReviewerTextarea(textarea) {
    if (!textarea) return;
    const scrollTop = textarea.scrollTop;
    textarea.style.height = 'auto';
    // Grow to fit content; the sticky panel's max-height makes it shrink and scroll when too long
    textarea.style.height = `${Math.max(140, textarea.scrollHeight)}px`;
    textarea.scrollTop = scrollTop;
  }

  // Create hoverable divider '+' button between cells
  function createCellDivider(afterCellId) {
    const divider = document.createElement('div');
    divider.className = 'cell-divider-insert';

    const btn = document.createElement('button');
    btn.className = 'btn-insert-divider';
    btn.title = 'Insert cell here';
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>`;
    btn.addEventListener('click', () => {
      socket.emit('cell-add', { afterCellId: afterCellId });
    });

    divider.appendChild(btn);
    return divider;
  }

  // Highlight commented text in the rendered preview
  function highlightCommentsInPreview(cellId, previewEl) {
    if (!state.doc || !Array.isArray(state.doc.comments) || !previewEl) return;
    const cellComments = state.doc.comments.filter(c => c.cellId === cellId && c.highlightedText && c.highlightedText.trim());
    if (cellComments.length === 0) return;

    cellComments.forEach(comment => {
      const searchText = comment.highlightedText.trim();
      if (!searchText) return;

      const walker = document.createTreeWalker(
        previewEl,
        NodeFilter.SHOW_TEXT,
        {
          acceptNode(node) {
            if (!node.nodeValue || !node.nodeValue.includes(searchText)) {
              return NodeFilter.FILTER_REJECT;
            }
            const parent = node.parentElement;
            if (parent && (parent.closest('mark.comment-highlight-mark') || parent.closest('.katex') || parent.tagName === 'SCRIPT' || parent.tagName === 'STYLE')) {
              return NodeFilter.FILTER_REJECT;
            }
            return NodeFilter.FILTER_ACCEPT;
          }
        }
      );

      const matchedNodes = [];
      let curr;
      while ((curr = walker.nextNode())) {
        matchedNodes.push(curr);
      }

      matchedNodes.forEach(textNode => {
        const parent = textNode.parentNode;
        if (!parent) return;

        const content = textNode.nodeValue;
        const idx = content.indexOf(searchText);
        if (idx === -1) return;

        const before = content.substring(0, idx);
        const match = content.substring(idx, idx + searchText.length);
        const after = content.substring(idx + searchText.length);

        const frag = document.createDocumentFragment();
        if (before) frag.appendChild(document.createTextNode(before));

        const mark = document.createElement('mark');
        mark.className = `comment-highlight-mark ${comment.resolved ? 'resolved' : ''}`;
        mark.dataset.commentId = comment.id;
        mark.dataset.cellId = cellId;
        mark.title = `💬 ${comment.author || 'Advisor'}: "${comment.commentText}" (Click to view comment)`;
        mark.textContent = match;

        mark.addEventListener('click', (e) => {
          e.stopPropagation();
          openCommentsSidebarAndSelect(comment.id);
        });

        frag.appendChild(mark);
        if (after) frag.appendChild(document.createTextNode(after));

        parent.replaceChild(frag, textNode);
      });
    });
  }

  function highlightCommentsInAllPreviews() {
    if (!state.doc || !Array.isArray(state.doc.cells)) return;
    state.doc.cells.forEach(cell => {
      const previewEl = document.getElementById(`render-${cell.id}`);
      if (previewEl && cell.content) {
        if (window.MarkdownMath && typeof window.MarkdownMath.render === 'function') {
          previewEl.innerHTML = window.MarkdownMath.render(cell.content);
        } else {
          previewEl.textContent = cell.content;
        }
        highlightCommentsInPreview(cell.id, previewEl);
      }
    });
  }

  // --- Editor Syntax Backdrop (Gray Commented Lines & Inline Feedback) ---

  function escapeRegex(str) {
    return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function formatNormalText(text, highlights) {
    if (!text) return '';
    if (!highlights || highlights.length === 0) {
      return escapeHtml(text);
    }

    const regexPatterns = highlights.map(h => escapeRegex(h.text));
    const combinedRegex = new RegExp(`(${regexPatterns.join('|')})`, 'g');

    const parts = text.split(combinedRegex);
    return parts.map(part => {
      const matched = highlights.find(h => h.text === part);
      if (matched) {
        return `<span class="syntax-commented-text" data-comment-id="${matched.id}">${escapeHtml(part)}</span>`;
      }
      return escapeHtml(part);
    }).join('');
  }

  function formatCommentedLine(line, highlights) {
    if (!line) return '';
    return formatNormalText(line, highlights);
  }

  function buildBackdropHtml(text, cellComments = []) {
    if (!text) return '';

    const lines = text.split('\n');
    let inHtmlComment = false;
    const resultLines = [];

    const commentHighlights = (cellComments || [])
      .filter(c => !c.resolved && c.highlightedText && c.highlightedText.trim())
      .map(c => ({
        id: c.id,
        text: c.highlightedText.trim()
      }))
      .sort((a, b) => b.text.length - a.text.length);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const trimmed = line.trim();

      // Check multi-line HTML comment state <!-- ... -->
      if (inHtmlComment) {
        const closeIdx = line.indexOf('-->');
        if (closeIdx !== -1) {
          const commentPart = line.substring(0, closeIdx + 3);
          const restPart = line.substring(closeIdx + 3);
          inHtmlComment = false;
          resultLines.push(`<span class="syntax-line-comment">${escapeHtml(commentPart)}</span>` + formatNormalText(restPart, commentHighlights));
        } else {
          resultLines.push(`<span class="syntax-line-comment">${escapeHtml(line)}</span>`);
        }
        continue;
      }

      if (trimmed.startsWith('<!--')) {
        const openIdx = line.indexOf('<!--');
        const closeIdx = line.indexOf('-->', openIdx + 4);
        if (closeIdx !== -1) {
          const before = line.substring(0, openIdx);
          const commentPart = line.substring(openIdx, closeIdx + 3);
          const after = line.substring(closeIdx + 3);
          resultLines.push(formatNormalText(before, commentHighlights) + `<span class="syntax-line-comment">${escapeHtml(commentPart)}</span>` + formatNormalText(after, commentHighlights));
        } else {
          inHtmlComment = true;
          const before = line.substring(0, openIdx);
          const commentPart = line.substring(openIdx);
          resultLines.push(formatNormalText(before, commentHighlights) + `<span class="syntax-line-comment">${escapeHtml(commentPart)}</span>`);
        }
        continue;
      }

      // Check if line starts with // or %% (markdown / latex comments)
      if (trimmed.startsWith('//') || trimmed.startsWith('%%')) {
        resultLines.push(`<span class="syntax-line-comment">${formatCommentedLine(line, commentHighlights)}</span>`);
        continue;
      }

      // Normal line
      resultLines.push(formatNormalText(line, commentHighlights));
    }

    let html = resultLines.join('\n');
    if (text.endsWith('\n')) {
      html += '<br>';
    }
    return html;
  }

  function syncBackdropScroll(textarea, backdrop) {
    if (!textarea || !backdrop) return;
    backdrop.scrollTop = textarea.scrollTop;
    backdrop.scrollLeft = textarea.scrollLeft;
  }

  function renderEditorBackdrop(cellId) {
    const textarea = document.getElementById(`textarea-${cellId}`);
    const backdrop = document.getElementById(`syntax-backdrop-${cellId}`);
    if (!textarea || !backdrop) return;

    const cellComments = (state.doc && Array.isArray(state.doc.comments))
      ? state.doc.comments.filter(c => c.cellId === cellId)
      : [];

    backdrop.innerHTML = buildBackdropHtml(textarea.value, cellComments);
    syncBackdropScroll(textarea, backdrop);
  }

  function renderAllEditorBackdrops() {
    if (!state.doc || !Array.isArray(state.doc.cells)) return;
    state.doc.cells.forEach(cell => {
      renderEditorBackdrop(cell.id);
    });
  }

  function openCommentsSidebarAndSelect(commentId) {
    if (elCommentsSidebar.classList.contains('hidden')) {
      elCommentsSidebar.classList.remove('hidden');
    }
    const comment = (state.doc.comments || []).find(c => c.id === commentId);
    if (comment && comment.resolved && state.commentsFilter === 'open') {
      state.commentsFilter = 'all';
      filterTabs.forEach(t => t.classList.toggle('active', t.dataset.filter === 'all'));
    }
    renderCommentsList();

    const doScrollAndHighlight = () => {
      const card = document.getElementById(`comment-card-${commentId}`);
      if (card) {
        document.querySelectorAll('.comment-card').forEach(cc => cc.classList.remove('active-card'));
        card.classList.add('active-card');
        card.scrollIntoView({ behavior: 'smooth', block: 'center' });

        card.classList.remove('active-flash');
        void card.offsetWidth;
        card.classList.add('active-flash');
        setTimeout(() => card.classList.remove('active-flash'), 2500);
      }
    };

    doScrollAndHighlight();
    setTimeout(doScrollAndHighlight, 80);
    setTimeout(doScrollAndHighlight, 280);
  }

  function checkCommentClickInEditor(cellId, start, end) {
    if (!state.doc || !Array.isArray(state.doc.comments)) return;
    const cell = (state.doc.cells || []).find(c => c.id === cellId);
    if (!cell) return;

    const cellComments = state.doc.comments.filter(c => c.cellId === cellId && c.highlightedText && c.highlightedText.trim());
    if (cellComments.length === 0) return;

    const textarea = document.getElementById(`textarea-${cellId}`);
    const content = textarea ? textarea.value : (cell.content || '');
    const clickPos = start !== undefined ? start : (textarea ? textarea.selectionStart : 0);
    const endPos = end !== undefined ? end : (textarea ? textarea.selectionEnd : clickPos);

    for (const comment of cellComments) {
      const target = comment.highlightedText.trim();
      if (!target) continue;

      let startIdx = 0;
      while ((startIdx = content.indexOf(target, startIdx)) !== -1) {
        const endIdx = startIdx + target.length;
        // Match with 1 char margin for relaxed click precision
        if ((clickPos >= Math.max(0, startIdx - 1) && clickPos <= endIdx + 1) || 
            (endPos > clickPos && !(endPos < startIdx || clickPos > endIdx))) {
          openCommentsSidebarAndSelect(comment.id);
          return;
        }
        startIdx += target.length;
      }
    }
  }

  // --- Render Cell Preview with KaTeX ---
  function renderCellPreview(cellId, content) {
    const previewEl = document.getElementById(`render-${cellId}`);
    if (!previewEl) return;

    if (!content || !content.trim()) {
      previewEl.innerHTML = '<p class="text-muted" style="color: var(--text-muted); font-style: italic;">(Empty cell - edit markdown on the left)</p>';
      return;
    }

    if (window.MarkdownMath && typeof window.MarkdownMath.render === 'function') {
      previewEl.innerHTML = window.MarkdownMath.render(content);
    } else {
      previewEl.textContent = content;
    }

    // Apply persistent comment highlights to the preview
    highlightCommentsInPreview(cellId, previewEl);
  }

  // --- Realtime Character & Word Counting (Excluding Commented-Out Lines) ---

  function updateCellCharCount(cellId, text) {
    const counterEl = document.getElementById(`char-counter-${cellId}`);
    if (!counterEl) return;

    const rawTotal = (text || '').length;
    const countable = getCountableText(text);
    const totalChars = countable.length;
    const words = countable.trim().split(/\s+/).filter(Boolean).length;

    const stat = (label, value) =>
      `<span class="char-stat"><span class="char-stat-label">${label}</span><span class="char-count-pill">${value.toLocaleString()}</span></span>`;

    const stats = [
      stat('Characters', totalChars),
      stat('+Comments', rawTotal),
      stat('Words', words),
    ];

    // Highlighted text in this cell's editor (only while it has focus)
    const textarea = document.getElementById(`textarea-${cellId}`);
    if (textarea && document.activeElement === textarea) {
      const selected = Math.abs(textarea.selectionEnd - textarea.selectionStart);
      if (selected > 0) {
        stats.push(`<span class="char-stat char-stat-selected"><span class="char-stat-label">Selected</span><span class="char-count-pill">${selected.toLocaleString()}</span></span>`);
      }
    }

    counterEl.innerHTML = stats.join('');
  }

  function updateGlobalCharCount() {
    if (!state.doc || !state.doc.cells) return;

    let totalChars = 0;
    let totalNoSpaceChars = 0;
    let totalWords = 0;
    let totalExcluded = 0;

    const cellStats = state.doc.cells.map((cell, idx) => {
      const text = cell.content || '';
      const countable = getCountableText(text);
      const chars = countable.length;
      totalChars += chars;
      totalNoSpaceChars += countable.replace(/\s/g, '').length;
      totalWords += countable.trim().split(/\s+/).filter(Boolean).length;
      totalExcluded += (text.length - chars);
      return {
        cell,
        idx,
        chars
      };
    });

    if (elGlobalCharCount) elGlobalCharCount.textContent = totalChars.toLocaleString();
    let noSpaceLabel = `${totalNoSpaceChars.toLocaleString()} non-space chars`;
    if (totalExcluded > 0) {
      noSpaceLabel += ` (${totalExcluded.toLocaleString()} in comments excluded)`;
    }
    if (elGlobalWordCount) elGlobalWordCount.textContent = `${totalWords.toLocaleString()} words`;
    if (elGlobalNoSpaceCount) elGlobalNoSpaceCount.textContent = noSpaceLabel;

    const limit = state.doc.targetCharLimit || 0;
    if (elCharProgressFill) {
      if (limit > 0) {
        const pct = Math.min(100, Math.round((totalChars / limit) * 100));
        elCharProgressFill.style.width = `${pct}%`;

        elCharProgressFill.classList.remove('warning', 'danger');
        if (totalChars > limit) {
          elCharProgressFill.classList.add('danger');
        } else if (totalChars >= limit * 0.9) {
          elCharProgressFill.classList.add('warning');
        }
      } else {
        elCharProgressFill.style.width = '0%';
      }
    }

    // Render Compact Per-Reviewer Character Count Summary Bar
    const elSummaryReviewersPills = document.getElementById('summaryReviewersPills');
    const elSummaryBarRight = document.getElementById('summaryBarRight');

    if (elSummaryReviewersPills) {
      elSummaryReviewersPills.replaceChildren();

      cellStats.forEach(({ cell, idx, chars }) => {
        const displayName = cell.reviewerName?.trim() || cell.title?.trim() || `Reviewer ${idx + 1}`;
        const sharePct = totalChars > 0 ? Math.round((chars / totalChars) * 100) : 0;

        const pill = document.createElement('button');
        pill.type = 'button';
        pill.className = 'summary-rev-pill';
        pill.title = `Jump to ${displayName} • ${chars.toLocaleString()} chars (${sharePct}% of rebuttal)`;
        pill.innerHTML = `
          <span class="pill-rev-name">${escapeHtml(displayName)}</span>
          <span class="pill-rev-count">${chars.toLocaleString()}</span>
          <span class="pill-rev-pct">${sharePct}%</span>
        `;

        pill.addEventListener('click', () => {
          const targetCard = document.getElementById(`cell-card-${cell.id}`);
          if (targetCard) {
            targetCard.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCard.classList.remove('flash-highlight');
            void targetCard.offsetWidth; // retrigger css animation
            targetCard.classList.add('flash-highlight');
            setTimeout(() => targetCard.classList.remove('flash-highlight'), 1600);
          }
        });

        elSummaryReviewersPills.appendChild(pill);
      });
    }

    if (elSummaryBarRight) {
      let rightHtml = `
        <div class="summary-total-pill">
          <span>Total:</span> <strong>${totalChars.toLocaleString()}</strong>${limit > 0 ? ` / ${limit.toLocaleString()}` : ''}
        </div>
      `;
      if (limit > 0) {
        const diff = limit - totalChars;
        if (diff >= 0) {
          rightHtml += `<div class="summary-remain-pill ok">${diff.toLocaleString()} left</div>`;
        } else {
          rightHtml += `<div class="summary-remain-pill over">+${Math.abs(diff).toLocaleString()} over</div>`;
        }
      }
      elSummaryBarRight.innerHTML = rightHtml;
    }
  }

  function syncLimitSelectUI(limit) {
    if (!elCharLimitSelect) return;
    const standardValues = ['5000', '4000', '6000', '0'];
    const limitStr = String(limit || 0);

    if (standardValues.includes(limitStr)) {
      elCharLimitSelect.value = limitStr;
      if (elCustomLimitInput) elCustomLimitInput.classList.add('hidden');
    } else {
      elCharLimitSelect.value = 'custom';
      if (elCustomLimitInput) {
        elCustomLimitInput.classList.remove('hidden');
        elCustomLimitInput.value = limit;
      }
    }
  }

  // --- Realtime Remote Cursors & Presence Visualization ---

  function updatePresenceUI(users) {
    state.activeUsers = users || [];

    // Count badge
    const count = state.activeUsers.length;
    elActiveCountText.textContent = `${count} online`;

    // Avatars stack
    elAvatarStack.replaceChildren();
    state.activeUsers.forEach(u => {
      const avatar = document.createElement('div');
      avatar.className = 'avatar-circle';
      avatar.style.backgroundColor = u.color || '#3b82f6';
      avatar.textContent = (u.name || 'U').charAt(0).toUpperCase();
      avatar.title = `${u.name}${u.socketId === socket.id ? ' (You)' : ''}`;
      elAvatarStack.appendChild(avatar);
    });

    renderPeerCursors();
  }

  function renderPeerCursors() {
    // Reset all cell card peer highlights
    document.querySelectorAll('.cell-card').forEach(card => {
      card.classList.remove('peer-active');
      card.style.borderColor = '';
    });

    // Clear peer badges from cell headers
    document.querySelectorAll('[id^="peer-badge-"]').forEach(el => el.replaceChildren());

    // Clear remote cursor overlays
    document.querySelectorAll('.remote-cursor-container').forEach(c => c.replaceChildren());

    // Render active peers for each cell
    state.peerCursors.forEach(({ user, cellId, cursor }, socketId) => {
      if (socketId === socket.id || !cellId) return;

      const card = document.getElementById(`cell-card-${cellId}`);
      if (card) {
        card.classList.add('peer-active');
        card.style.borderLeftColor = user.color || '#3b82f6';
      }

      // Add badge in header
      const badgeContainer = document.getElementById(`peer-badge-${cellId}`);
      if (badgeContainer) {
        const badge = document.createElement('span');
        badge.className = 'cell-peer-badge';
        badge.style.backgroundColor = user.color || '#3b82f6';
        badge.textContent = `● ${user.name} is editing...`;
        badgeContainer.appendChild(badge);
      }

      // Render cursor overlay inside textarea container
      const cursorOverlay = document.getElementById(`cursor-container-${cellId}`);
      const textarea = document.getElementById(`textarea-${cellId}`);
      if (cursorOverlay && textarea && cursor) {
        const text = textarea.value || '';
        const cursorPos = Math.min(cursor.start || 0, text.length);

        const beforeText = text.substring(0, cursorPos);
        const afterText = text.substring(cursorPos);

        const beforeNode = document.createTextNode(beforeText);
        const afterNode = document.createTextNode(afterText);

        const caret = document.createElement('span');
        caret.className = 'remote-cursor-caret';
        caret.style.backgroundColor = user.color || '#3b82f6';

        const tag = document.createElement('span');
        tag.className = 'remote-cursor-tag';
        tag.style.backgroundColor = user.color || '#3b82f6';
        tag.textContent = user.name;
        caret.appendChild(tag);

        cursorOverlay.replaceChildren(beforeNode, caret, afterNode);
      }
    });
  }

  function updateMyProfileUI() {
    if (!state.me) return;
    elMyName.textContent = state.me.name || 'You';
    elMyAvatar.textContent = (state.me.name || 'Y').charAt(0).toUpperCase();
    elMyAvatar.style.backgroundColor = state.me.color || '#3b82f6';
    if (elHeaderInlineName && document.activeElement !== elHeaderInlineName) {
      elHeaderInlineName.value = state.me.name || '';
    }
  }

  if (elHeaderInlineName) {
    elHeaderInlineName.addEventListener('input', (e) => {
      const val = e.target.value.trim() || 'Collaborator';
      state.me.name = val;
      localStorage.setItem('rh_user_name', val);
      elMyName.textContent = val;
      elMyAvatar.textContent = val.charAt(0).toUpperCase();
      socket.emit('update-user-profile', { name: val, color: state.me.color });
    });
  }

  // --- Profile Modal & Customization ---

  elUserPill.addEventListener('click', () => {
    elInputUserName.value = state.me.name || '';
    renderColorPickerGrid();
    elProfileModal.classList.remove('hidden');
    elInputUserName.focus();
  });

  elBtnProfileModalClose.addEventListener('click', () => {
    elProfileModal.classList.add('hidden');
  });

  function renderColorPickerGrid() {
    elColorPickerGrid.replaceChildren();
    PALETTE.forEach(c => {
      const btn = document.createElement('button');
      btn.className = `color-circle-btn ${state.me.color === c ? 'selected' : ''}`;
      btn.style.backgroundColor = c;
      btn.addEventListener('click', () => {
        document.querySelectorAll('.color-circle-btn').forEach(b => b.classList.remove('selected'));
        btn.classList.add('selected');
        state.me.color = c;
      });
      elColorPickerGrid.appendChild(btn);
    });
  }

  elBtnSaveProfile.addEventListener('click', () => {
    const newName = elInputUserName.value.trim() || 'Collaborator';
    state.me.name = newName;
    localStorage.setItem('rh_user_name', state.me.name);
    localStorage.setItem('rh_user_color', state.me.color);

    socket.emit('update-user-profile', {
      name: state.me.name,
      color: state.me.color
    });

    updateMyProfileUI();
    elProfileModal.classList.add('hidden');
    showToast('Profile updated!', 'success');
  });

  // --- Document Title & Char Limit Events ---

  elDocTitleInput.addEventListener('input', (e) => {
    if (!state.doc) return;
    state.doc.title = e.target.value;
    socket.emit('doc-title-update', { title: e.target.value });
  });

  if (elCharLimitSelect) {
    elCharLimitSelect.addEventListener('change', (e) => {
      if (e.target.value === 'custom') {
        if (elCustomLimitInput) {
          elCustomLimitInput.classList.remove('hidden');
          elCustomLimitInput.focus();
        }
      } else {
        if (elCustomLimitInput) elCustomLimitInput.classList.add('hidden');
        const limit = parseInt(e.target.value, 10);
        state.doc.targetCharLimit = limit;
        socket.emit('doc-limit-update', { targetCharLimit: limit });
        updateGlobalCharCount();
      }
    });
  }

  if (elCustomLimitInput) {
    elCustomLimitInput.addEventListener('change', (e) => {
      const limit = parseInt(e.target.value, 10) || 5000;
      state.doc.targetCharLimit = limit;
      socket.emit('doc-limit-update', { targetCharLimit: limit });
      updateGlobalCharCount();
    });
  }

  // =========================================================
  // Dedicated Quick Pastebox / Scratchpad Controller
  // =========================================================
  function updatePasteboxUI() {
    if (!elPasteboxTextarea) return;
    const val = elPasteboxTextarea.value || '';
    const countable = getCountableText(val);
    const chars = countable.length;
    const words = countable.trim().split(/\s+/).filter(Boolean).length;
    const noSpace = countable.replace(/\s/g, '').length;

    if (elPasteboxCharCount) elPasteboxCharCount.textContent = chars.toLocaleString();
    if (elPasteboxWordCount) elPasteboxWordCount.textContent = `(${words.toLocaleString()} words, ${noSpace.toLocaleString()} no-space)`;

    // Live markdown render in pastebox preview
    if (elPasteboxPreview) {
      if (!val.trim()) {
        elPasteboxPreview.innerHTML = '<span class="pastebox-empty-hint">Rendered markdown & math preview will appear here...</span>';
      } else {
        elPasteboxPreview.innerHTML = window.MarkdownMath.render(val);
      }
    }

    // Live syntax backdrop (commented out lines grayed)
    if (elPasteboxBackdrop) {
      const lines = val.split('\n');
      const backdropLines = lines.map(line => {
        const trimmed = line.trim();
        if (trimmed.startsWith('//') || trimmed.startsWith('%%') || (trimmed.startsWith('<!--') && trimmed.endsWith('-->'))) {
          return `<span class="syntax-line-comment">${escapeHtml(line)}</span>`;
        }
        return escapeHtml(line);
      });
      elPasteboxBackdrop.innerHTML = backdropLines.join('\n') + (val.endsWith('\n') ? '\n' : '');
    }
  }

  function initPastebox() {
    if (!elQuickPasteboxCard || !elPasteboxTextarea) return;

    let pasteboxDebounce = null;
    elPasteboxTextarea.addEventListener('input', () => {
      updatePasteboxUI();
      clearTimeout(pasteboxDebounce);
      pasteboxDebounce = setTimeout(() => {
        socket.emit('pastebox-update', {
          docId: state.docId,
          content: elPasteboxTextarea.value
        });
      }, 200);
    });

    elPasteboxTextarea.addEventListener('scroll', () => {
      if (elPasteboxBackdrop) {
        elPasteboxBackdrop.scrollTop = elPasteboxTextarea.scrollTop;
      }
    });

    // Toggle collapse/expand when clicking header or chevron
    if (elPasteboxHeader) {
      elPasteboxHeader.addEventListener('click', (e) => {
        if (e.target.closest('button:not(#btnTogglePastebox)') || e.target.closest('input')) return;
        const isCollapsed = elQuickPasteboxCard.classList.toggle('collapsed');
        socket.emit('pastebox-update', {
          docId: state.docId,
          collapsed: isCollapsed
        });
      });
    }

    // Comment line in pastebox
    if (elBtnPasteboxComment) {
      elBtnPasteboxComment.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleLineCommentOnTextarea(elPasteboxTextarea);
        updatePasteboxUI();
      });
    }

    // Keyboard shortcut Ctrl + / inside pastebox
    elPasteboxTextarea.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === '/') {
        e.preventDefault();
        toggleLineCommentOnTextarea(elPasteboxTextarea);
        updatePasteboxUI();
      }
    });

    // Copy to clipboard
    if (elBtnPasteboxCopy) {
      elBtnPasteboxCopy.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = elPasteboxTextarea.value;
        if (!text) {
          showToast('Pastebox is empty', 'info');
          return;
        }
        copyTextToClipboard(text, '📋 Copied pastebox text to clipboard!');
      });
    }

    // Clear pastebox
    if (elBtnPasteboxClear) {
      elBtnPasteboxClear.addEventListener('click', (e) => {
        e.stopPropagation();
        if (!elPasteboxTextarea.value) return;
        if (confirm('Clear all pastebox text?')) {
          elPasteboxTextarea.value = '';
          updatePasteboxUI();
          socket.emit('pastebox-update', {
            docId: state.docId,
            content: ''
          });
          showToast('Pastebox cleared', 'info');
        }
      });
    }
  }

  initPastebox();

  // --- Bottom Add Cell Button ---

  elBtnAddCellBottom.addEventListener('click', () => {
    socket.emit('cell-add', { afterCellId: null });
  });

  // Quick Template Cell
  elBtnInsertTemplate.addEventListener('click', () => {
    const templateContent = `### Response to Reviewer jV3P\n\n> **jV3P**: *"Please elaborate on the convergence proof."*\n\n**Reply**: By applying the Banach Fixed-Point Theorem to operator $\\mathcal{T}$, we establish that:\n$$\n\\| \\mathcal{T}(x) - \\mathcal{T}(y) \\| \\le \\gamma \\| x - y \\|, \\quad \\gamma < 1\n$$\nwhich guarantees uniform convergence in finite iterations.`;
    socket.emit('cell-add', {
      title: 'Response to Reviewer jV3P',
      reviewerName: 'Reviewer jV3P',
      reviewerScore: '6',
      reviewerComment: 'Please elaborate on the convergence proof and computational bounds for non-convex loss regimes.',
      content: templateContent
    });
  });

  // --- Format Helpers (Insert text into current active editor) ---

  quickFormatBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const textarea = state.activeFocusedTextarea || document.querySelector('.cell-textarea');
      if (!textarea) return;

      const prefix = btn.dataset.insert || '';
      const suffix = btn.dataset.insertEnd || '';

      const start = textarea.selectionStart;
      const end = textarea.selectionEnd;
      const text = textarea.value;

      const selected = text.substring(start, end);
      const replacement = `${prefix}${selected || 'formula'}${suffix}`;

      textarea.value = text.substring(0, start) + replacement + text.substring(end);
      textarea.selectionStart = start + prefix.length;
      textarea.selectionEnd = start + prefix.length + (selected ? selected.length : 7);
      textarea.focus();
      textarea.dispatchEvent(new Event('input'));
    });
  });

  // --- Universal Bulletproof Clipboard Copy Helper ---

  function copyTextToClipboard(text, successToast = '📋 Copied to clipboard!') {
    if (!text) {
      showToast('⚠️ No content to copy', 'warning');
      return;
    }

    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(successToast, 'success');
      }).catch((err) => {
        console.warn('navigator.clipboard.writeText failed, using execCommand fallback:', err);
        fallbackExecCommandCopy(text, successToast);
      });
    } else {
      fallbackExecCommandCopy(text, successToast);
    }
  }

  function fallbackExecCommandCopy(text, successToast) {
    let textarea = null;
    try {
      textarea = document.createElement('textarea');
      textarea.value = text;
      textarea.setAttribute('readonly', '');
      textarea.style.position = 'fixed';
      textarea.style.top = '0';
      textarea.style.left = '0';
      textarea.style.width = '2em';
      textarea.style.height = '2em';
      textarea.style.padding = '0';
      textarea.style.border = 'none';
      textarea.style.outline = 'none';
      textarea.style.boxShadow = 'none';
      textarea.style.background = 'transparent';
      document.body.appendChild(textarea);
      textarea.focus();
      textarea.select();
      textarea.setSelectionRange(0, textarea.value.length);

      const successful = document.execCommand('copy');
      document.body.removeChild(textarea);
      textarea = null;

      if (successful) {
        showToast(successToast, 'success');
      } else {
        openExportModal(text);
      }
    } catch (err) {
      if (textarea && textarea.parentNode) {
        document.body.removeChild(textarea);
      }
      console.error('execCommand fallback failed:', err);
      openExportModal(text);
    }
  }

  // --- Sharing & URL Link ---

  elBtnShare.addEventListener('click', () => {
    const url = window.location.href;
    copyTextToClipboard(url, '🔗 Shareable link copied to clipboard!');
  });

  // --- Markdown Export Formatter ---

  function getExportMarkdown() {
    if (!state.doc || !state.doc.cells) return '';
    return state.doc.cells.map((cell, idx) => {
      const liveTextarea = document.querySelector(`textarea[data-cell-id="${cell.id}"]`);
      const content = (liveTextarea ? liveTextarea.value : (cell.content || '')).trim();
      const revName = (cell.reviewerName || '').trim() || (cell.title || '').trim() || `Reviewer ${idx + 1}`;
      const header = revName.startsWith('#') ? revName : `# ${revName}`;
      return `${header}\n\n${content}`;
    }).join('\n\n===\n\n');
  }

  // --- Export Modal Controller ---

  function openExportModal(text) {
    const markdown = text !== undefined ? text : getExportMarkdown();
    if (elExportModalTextarea) {
      elExportModalTextarea.value = markdown;
      elExportModalTextarea.scrollTop = 0;
      if (elExportModalCharCount) {
        elExportModalCharCount.textContent = `${markdown.length.toLocaleString()} characters`;
      }
      setTimeout(() => {
        elExportModalTextarea.focus();
        elExportModalTextarea.select();
        elExportModalTextarea.scrollTop = 0;
      }, 50);
    }
    if (elExportModal) elExportModal.classList.remove('hidden');
  }

  function closeExportModal() {
    if (elExportModal) elExportModal.classList.add('hidden');
  }

  if (elBtnOpenExportModal) {
    elBtnOpenExportModal.addEventListener('click', () => {
      openExportModal();
    });
  }

  if (elBtnExportModalClose) {
    elBtnExportModalClose.addEventListener('click', closeExportModal);
  }

  if (elBtnCloseExportModal) {
    elBtnCloseExportModal.addEventListener('click', closeExportModal);
  }

  if (elBtnModalCopyMarkdown) {
    elBtnModalCopyMarkdown.addEventListener('click', () => {
      const text = elExportModalTextarea ? elExportModalTextarea.value : getExportMarkdown();
      copyTextToClipboard(text, '📋 Rebuttal markdown copied to clipboard!');
    });
  }

  if (elExportModal) {
    elExportModal.addEventListener('click', (e) => {
      if (e.target === elExportModal) closeExportModal();
    });
  }

  // --- Export Menu Actions ---

  elBtnExportMenu.addEventListener('click', (e) => {
    e.stopPropagation();
    elBtnExportMenu.parentElement.classList.toggle('open');
  });

  document.addEventListener('click', () => {
    document.querySelectorAll('.dropdown').forEach(d => d.classList.remove('open'));
  });

  // 1. Copy All Markdown
  elBtnCopyAllMarkdown.addEventListener('click', () => {
    if (!state.doc) return;
    const combined = getExportMarkdown();
    copyTextToClipboard(combined, '📋 Rebuttal markdown copied to clipboard!');
  });

  // 2. Download Markdown file
  elBtnDownloadMarkdown.addEventListener('click', () => {
    if (!state.doc) return;
    const combined = getExportMarkdown();
    downloadFile(`${state.doc.id || 'rebuttal'}.md`, 'text/markdown;charset=utf-8', combined);
  });

  // 3. Download Rendered HTML
  elBtnDownloadHTML.addEventListener('click', () => {
    if (!state.doc) return;
    const renderedParts = state.doc.cells.map(c => {
      const html = window.MarkdownMath.render(c.content);
      return `<section class="rebuttal-cell">\n<h2>${window.MarkdownMath.escapeHtml(c.title || '')}</h2>\n${html}\n</section>`;
    }).join('\n<hr/>\n');

    const fullHtml = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${window.MarkdownMath.escapeHtml(state.doc.title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
<style>
body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 900px; margin: 40px auto; padding: 0 20px; line-height: 1.6; color: #1e293b; }
h1, h2, h3 { color: #0f172a; }
blockquote { border-left: 4px solid #3b82f6; margin: 16px 0; padding: 8px 16px; background: #f0f7ff; }
table { width: 100%; border-collapse: collapse; margin: 16px 0; }
th, td { border: 1px solid #cbd5e1; padding: 8px 12px; }
th { background: #f8fafc; }
code { background: #f1f5f9; padding: 2px 6px; border-radius: 4px; font-family: monospace; }
pre { background: #0f172a; color: #f8fafc; padding: 12px; border-radius: 6px; overflow-x: auto; }
hr { border: none; border-top: 1px solid #e2e8f0; margin: 30px 0; }
</style>
</head>
<body>
<h1>${window.MarkdownMath.escapeHtml(state.doc.title)}</h1>
${renderedParts}
</body>
</html>`;

    downloadFile(`${state.doc.id || 'rebuttal'}.html`, 'text/html;charset=utf-8', fullHtml);
  });

  function downloadFile(filename, type, data) {
    const blob = new Blob([data], { type });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(link.href);
    showToast(`💾 Downloaded ${filename}`, 'success');
  }

  // =========================================================================
  // Floating Highlight Comment Trigger & Popover (Google Docs Style)
  // =========================================================================

  document.addEventListener('mouseup', handleTextSelection);
  document.addEventListener('keyup', (e) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Shift'].includes(e.key)) {
      handleTextSelection();
    }
  });

  function handleTextSelection() {
    if (!elCommentInputBubble.classList.contains('hidden')) return;

    const selection = window.getSelection();
    const selectedText = selection ? selection.toString().trim() : '';

    if (!selectedText || selectedText.length < 2) {
      elFloatingCommentPill.classList.add('hidden');
      return;
    }

    // Check if selection is within a cell card
    const anchorNode = selection.anchorNode;
    const parentCell = anchorNode ? (anchorNode.nodeType === 3 ? anchorNode.parentElement : anchorNode).closest('.cell-card') : null;
    if (!parentCell) {
      elFloatingCommentPill.classList.add('hidden');
      return;
    }

    const cellId = parentCell.dataset.cellId;
    state.activeHighlightSelection = { cellId, text: selectedText };

    try {
      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();
      const top = Math.max(70, rect.top + window.scrollY - 38);
      const left = Math.min(window.innerWidth - 180, Math.max(10, rect.left + window.scrollX));

      elFloatingCommentPill.style.top = `${top}px`;
      elFloatingCommentPill.style.left = `${left}px`;
      elFloatingCommentPill.classList.remove('hidden');
    } catch (err) {
      elFloatingCommentPill.classList.add('hidden');
    }
  }

  elBtnTriggerAddComment.addEventListener('click', (e) => {
    e.stopPropagation();
    if (!state.activeHighlightSelection) return;

    elBubbleAuthorName.textContent = state.me.name || 'You';
    const quote = state.activeHighlightSelection.text;
    elBubbleQuoteText.textContent = `"${quote.slice(0, 80)}${quote.length > 80 ? '...' : ''}"`;
    elCommentInputBubble.classList.remove('hidden');
    elBubbleCommentInput.value = '';
    elBubbleCommentInput.focus();
  });

  elBtnCancelBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    elCommentInputBubble.classList.add('hidden');
    elFloatingCommentPill.classList.add('hidden');
    state.activeHighlightSelection = null;
  });

  elBtnSubmitBubble.addEventListener('click', (e) => {
    e.stopPropagation();
    const commentText = elBubbleCommentInput.value.trim();
    if (!commentText) return;

    socket.emit('comment-add', {
      cellId: state.activeHighlightSelection ? state.activeHighlightSelection.cellId : state.activeCellId,
      highlightedText: state.activeHighlightSelection ? state.activeHighlightSelection.text : '',
      commentText: commentText,
      author: state.me.name || 'Collaborator',
      authorColor: state.me.color || '#3b82f6'
    });

    elCommentInputBubble.classList.add('hidden');
    elFloatingCommentPill.classList.add('hidden');
    state.activeHighlightSelection = null;

    // Open comments sidebar so user sees the posted comment
    elCommentsSidebar.classList.remove('hidden');
  });

  document.addEventListener('mousedown', (e) => {
    if (!elFloatingCommentPill.contains(e.target)) {
      elFloatingCommentPill.classList.add('hidden');
      elCommentInputBubble.classList.add('hidden');
    }
  });

  // =========================================================================
  // Comments Sidebar Panel Logic
  // =========================================================================

  elBtnToggleComments.addEventListener('click', () => {
    elCommentsSidebar.classList.toggle('hidden');
    if (!elCommentsSidebar.classList.contains('hidden')) {
      renderCommentsList();
    }
  });

  elBtnCloseCommentsSidebar.addEventListener('click', () => {
    elCommentsSidebar.classList.add('hidden');
  });

  [elTabOpenComments, elTabResolvedComments, elTabAllComments].forEach(tab => {
    tab.addEventListener('click', () => {
      [elTabOpenComments, elTabResolvedComments, elTabAllComments].forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      state.commentsFilter = tab.dataset.filter;
      renderCommentsList();
    });
  });

  function renderCommentsList() {
    if (!state.doc || !Array.isArray(state.doc.comments)) return;

    const all = state.doc.comments;
    const openCount = all.filter(c => !c.resolved).length;
    elCommentsCountBadge.textContent = openCount;
    elCommentsCountBadge.classList.toggle('has-unread', openCount > 0);

    const filtered = all.filter(c => {
      if (state.commentsFilter === 'open') return !c.resolved;
      if (state.commentsFilter === 'resolved') return c.resolved;
      return true;
    });

    elCommentsList.replaceChildren();

    if (filtered.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'comments-empty-state';
      empty.innerHTML = `
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
        </svg>
        <p>No ${state.commentsFilter === 'open' ? 'open' : state.commentsFilter} feedback.<br>Highlight any text in a cell to add a comment!</p>
      `;
      elCommentsList.appendChild(empty);
      return;
    }

    filtered.forEach(c => {
      const card = document.createElement('div');
      card.className = `comment-card ${c.resolved ? 'resolved' : ''}`;
      card.id = `comment-card-${c.id}`;

      // Header
      const header = document.createElement('div');
      header.className = 'comment-card-header';

      const authorWrap = document.createElement('div');
      authorWrap.className = 'comment-author-wrap';

      const avatar = document.createElement('div');
      avatar.className = 'comment-author-avatar';
      avatar.style.backgroundColor = c.authorColor || '#3b82f6';
      avatar.textContent = (c.author || 'C').charAt(0).toUpperCase();

      const name = document.createElement('span');
      name.className = 'comment-author-name';
      name.textContent = c.author || 'Collaborator';

      authorWrap.appendChild(avatar);
      authorWrap.appendChild(name);

      const time = document.createElement('span');
      time.className = 'comment-time';
      time.textContent = timeAgo(c.createdAt);

      header.appendChild(authorWrap);
      header.appendChild(time);
      card.appendChild(header);

      // Quoted text
      if (c.highlightedText) {
        const quote = document.createElement('div');
        quote.className = 'comment-quote-box';
        quote.textContent = `❝ ${c.highlightedText} ❞`;
        card.appendChild(quote);
      }

      // Comment message
      const text = document.createElement('div');
      text.className = 'comment-text';
      text.textContent = c.commentText;
      card.appendChild(text);

      // Action buttons
      const actions = document.createElement('div');
      actions.className = 'comment-actions';

      const btnResolve = document.createElement('button');
      btnResolve.className = 'btn-resolve-comment';
      btnResolve.innerHTML = c.resolved ? '↺ Reopen' : '✓ Resolve';
      btnResolve.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('comment-resolve', { commentId: c.id, resolved: !c.resolved });
      });

      const btnDelete = document.createElement('button');
      btnDelete.className = 'btn-delete-comment';
      btnDelete.textContent = '✕';
      btnDelete.title = 'Delete comment';
      btnDelete.addEventListener('click', (e) => {
        e.stopPropagation();
        socket.emit('comment-delete', { commentId: c.id });
      });

      actions.appendChild(btnResolve);
      actions.appendChild(btnDelete);
      card.appendChild(actions);

      // Click comment card: highlight in preview, scroll to cell, and select in textarea
      card.addEventListener('click', () => {
        // Highlight active card in sidebar
        document.querySelectorAll('.comment-card').forEach(cc => cc.classList.remove('active-card'));
        card.classList.add('active-card');

        if (c.cellId) {
          const targetCell = document.getElementById(`cell-card-${c.cellId}`);
          if (targetCell) {
            targetCell.scrollIntoView({ behavior: 'smooth', block: 'center' });
            targetCell.classList.add('peer-active');
            setTimeout(() => targetCell.classList.remove('peer-active'), 1800);
          }

          // 1. Highlight and pulse the comment mark in rendered preview
          const previewEl = document.getElementById(`render-${c.cellId}`);
          if (previewEl) {
            const marks = previewEl.querySelectorAll(`mark[data-comment-id="${c.id}"]`);
            if (marks.length > 0) {
              marks.forEach(m => {
                m.scrollIntoView({ behavior: 'smooth', block: 'center' });
                m.classList.remove('active-flash');
                void m.offsetWidth; // trigger reflow
                m.classList.add('active-flash');
                setTimeout(() => m.classList.remove('active-flash'), 2500);
              });
            }
          }

          // 2. Also highlight and select the exact text in the editor textarea
          const textarea = document.getElementById(`textarea-${c.cellId}`);
          if (textarea && c.highlightedText) {
            const fullText = textarea.value;
            const idx = fullText.indexOf(c.highlightedText);
            if (idx !== -1) {
              textarea.focus();
              textarea.setSelectionRange(idx, idx + c.highlightedText.length);
              const wrap = textarea.closest('.editor-textarea-wrapper') || textarea;
              wrap.classList.remove('textarea-comment-flash');
              void wrap.offsetWidth; // trigger reflow
              wrap.classList.add('textarea-comment-flash');
              // Also pulse the exact word in the editor backdrop
              const backdrop = document.getElementById(`syntax-backdrop-${c.cellId}`);
              if (backdrop) {
                const editorMarks = backdrop.querySelectorAll(`.syntax-commented-text[data-comment-id="${c.id}"]`);
                editorMarks.forEach(em => {
                  em.classList.remove('flash-active');
                  void em.offsetWidth;
                  em.classList.add('flash-active');
                  setTimeout(() => em.classList.remove('flash-active'), 2500);
                });
              }
            }
          }
        }
      });

      elCommentsList.appendChild(card);
    });
  }

  // Socket listeners for comments
  socket.on('comment-added', (comment) => {
    if (!state.doc.comments) state.doc.comments = [];
    state.doc.comments.push(comment);
    renderCommentsList();
    highlightCommentsInAllPreviews();
    renderAllEditorBackdrops();
    showToast(`💬 ${comment.author} added feedback`, 'info');
  });

  socket.on('comment-resolved', ({ commentId, resolved }) => {
    if (!state.doc.comments) return;
    const c = state.doc.comments.find(x => x.id === commentId);
    if (c) {
      c.resolved = resolved;
      renderCommentsList();
      highlightCommentsInAllPreviews();
      renderAllEditorBackdrops();
    }
  });

  socket.on('comment-deleted', ({ commentId }) => {
    if (!state.doc.comments) return;
    state.doc.comments = state.doc.comments.filter(x => x.id !== commentId);
    renderCommentsList();
    highlightCommentsInAllPreviews();
    renderAllEditorBackdrops();
  });

  // =========================================================================
  // Revision History & Auto-Backups
  // =========================================================================

  elBtnOpenHistory.addEventListener('click', () => {
    elHistoryModal.classList.remove('hidden');
    elHistoryList.innerHTML = '<div class="spinner"></div>';
    socket.emit('get-doc-history');
  });

  elBtnHistoryModalClose.addEventListener('click', () => {
    elHistoryModal.classList.add('hidden');
  });
  elBtnCloseHistoryModal.addEventListener('click', () => {
    elHistoryModal.classList.add('hidden');
  });

  socket.on('doc-history-data', ({ snapshots }) => {
    elHistoryList.replaceChildren();

    if (!snapshots || snapshots.length === 0) {
      elHistoryList.innerHTML = '<p class="text-muted" style="padding: 1.5rem; text-align: center;">No history snapshots found yet. Snapshots are automatically saved to disk every 3 minutes when you edit.</p>';
      return;
    }

    snapshots.forEach(s => {
      const item = document.createElement('div');
      item.className = 'history-item';

      const left = document.createElement('div');
      left.className = 'history-item-left';

      const d = new Date(s.timestamp);
      const dateStr = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      const timeStr = d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

      const timestampEl = document.createElement('span');
      timestampEl.className = 'history-timestamp';
      timestampEl.textContent = `${dateStr} at ${timeStr}`;

      const meta = document.createElement('span');
      meta.className = 'history-meta';
      meta.textContent = `${s.cellsCount} cells • ${s.charCount.toLocaleString()} characters`;

      left.appendChild(timestampEl);
      left.appendChild(meta);

      const btnRestore = document.createElement('button');
      btnRestore.className = 'btn-restore-history';
      btnRestore.textContent = 'Restore';
      btnRestore.addEventListener('click', () => {
        if (confirm(`Restore snapshot from ${dateStr} at ${timeStr}? A backup of the current state will be created.`)) {
          socket.emit('restore-doc-history', { timestamp: s.timestamp });
          elHistoryModal.classList.add('hidden');
          showToast('Restored previous snapshot from disk!', 'success');
        }
      });

      item.appendChild(left);
      item.appendChild(btnRestore);
      elHistoryList.appendChild(item);
    });
  });

  // =========================================================================
  // Boards Manager & Switcher
  // =========================================================================

  let cachedBoards = [];

  async function fetchBoards() {
    try {
      const res = await fetch('/api/boards');
      if (!res.ok) throw new Error('Failed to fetch boards');
      cachedBoards = await res.json();
      if (elBoardsCountBadge) {
        elBoardsCountBadge.textContent = cachedBoards.length;
      }
      renderBoardsCards(cachedBoards);
    } catch (err) {
      console.error('Error fetching boards:', err);
      if (elBoardsCardsGrid) {
        elBoardsCardsGrid.innerHTML = '<p class="text-danger" style="padding:1.5rem; text-align:center;">Failed to load boards list.</p>';
      }
    }
  }

  function renderBoardsCards(boards) {
    if (!elBoardsCardsGrid) return;
    elBoardsCardsGrid.replaceChildren();

    const searchTerm = (elBoardsSearchInput ? elBoardsSearchInput.value : '').trim().toLowerCase();
    const filtered = boards.filter(b => {
      if (!searchTerm) return true;
      return (b.title && b.title.toLowerCase().includes(searchTerm)) ||
             (b.id && b.id.toLowerCase().includes(searchTerm)) ||
             (b.reviewers && b.reviewers.some(r => r.toLowerCase().includes(searchTerm)));
    });

    if (filtered.length === 0) {
      elBoardsCardsGrid.innerHTML = '<p class="text-muted" style="padding: 2rem; text-align: center; grid-column: 1 / -1;">No matching rebuttal boards found.</p>';
      return;
    }

    filtered.forEach(board => {
      const isCurrent = board.id === state.docId;
      const card = document.createElement('div');
      card.className = `board-card ${isCurrent ? 'current-active' : ''}`;

      // Progress calculation
      const limit = board.targetCharLimit || 5000;
      const pct = limit > 0 ? Math.min(100, Math.round((board.charCount / limit) * 100)) : 0;
      let progressClass = '';
      if (pct >= 100) progressClass = 'limit-exceeded';
      else if (pct >= 90) progressClass = 'limit-warning';

      // Format reviewers pills
      const reviewers = board.reviewers && board.reviewers.length > 0 ? board.reviewers : ['3 Reviewers'];
      const reviewersHtml = reviewers.slice(0, 5).map(r => `<span class="rev-tag-pill">${escapeHtml(r)}</span>`).join('') +
        (reviewers.length > 5 ? `<span class="rev-tag-pill">+${reviewers.length - 5} more</span>` : '');

      card.innerHTML = `
        <div class="board-card-header">
          <div class="board-card-title-group">
            <h4 class="board-card-title" title="${escapeHtml(board.title)}">${escapeHtml(board.title)}</h4>
            <span class="board-card-id">doc: ${escapeHtml(board.id)}</span>
          </div>
          ${isCurrent ? '<span class="board-card-active-tag">● Active Board</span>' : ''}
        </div>

        <div class="board-card-meta">
          <div class="board-card-reviewers-list">
            ${reviewersHtml}
          </div>
          <div class="board-card-stats">
            <span>📝 ${board.cellsCount} cells</span>
            <span>⚡ ${board.charCount.toLocaleString()} / ${limit ? limit.toLocaleString() : '∞'} chars</span>
            ${board.openCommentsCount ? `<span>💬 ${board.openCommentsCount} open</span>` : ''}
          </div>
          ${limit > 0 ? `
            <div class="board-card-progress" title="${pct}% of limit">
              <div class="board-card-progress-bar ${progressClass}" style="width: ${pct}%;"></div>
            </div>
          ` : ''}
        </div>

        <div class="board-card-footer">
          <span class="history-meta">Updated ${timeAgo(board.updatedAt)}</span>
          <div class="board-card-actions">
            <button class="btn btn-xs btn-outline btn-copy-board-link" title="Copy shareable link">
              🔗 Share
            </button>
            ${!isCurrent ? `
              <button class="btn btn-xs btn-primary btn-open-board" title="Switch to this board">
                Open Board →
              </button>
              <button class="btn btn-xs btn-danger btn-delete-board" title="Delete board from disk">
                🗑️
              </button>
            ` : `
              <span class="badge" style="font-size:0.75rem; color:var(--success); font-weight:600;">Current Board</span>
            `}
          </div>
        </div>
      `;

      // Copy board share link
      const btnCopy = card.querySelector('.btn-copy-board-link');
      if (btnCopy) {
        btnCopy.addEventListener('click', (e) => {
          e.stopPropagation();
          const url = `${window.location.protocol}//${window.location.host}${window.location.pathname}?doc=${encodeURIComponent(board.id)}`;
          navigator.clipboard.writeText(url).then(() => {
            showToast(`Copied share link for "${board.title}"!`, 'success');
          });
        });
      }

      // Open board
      const btnOpen = card.querySelector('.btn-open-board');
      if (btnOpen) {
        btnOpen.addEventListener('click', (e) => {
          e.stopPropagation();
          window.location.search = `?doc=${encodeURIComponent(board.id)}`;
        });
      }

      // Delete board
      const btnDelete = card.querySelector('.btn-delete-board');
      if (btnDelete) {
        btnDelete.addEventListener('click', async (e) => {
          e.stopPropagation();
          if (confirm(`Are you sure you want to delete board "${board.title}" (${board.id}) from disk? This cannot be undone.`)) {
            try {
              const res = await fetch(`/api/boards/${encodeURIComponent(board.id)}`, { method: 'DELETE' });
              if (res.ok) {
                showToast(`Deleted board "${board.title}"`, 'info');
                fetchBoards();
              } else {
                showToast('Failed to delete board', 'error');
              }
            } catch (err) {
              console.error(err);
              showToast('Error deleting board', 'error');
            }
          }
        });
      }

      elBoardsCardsGrid.appendChild(card);
    });
  }

  function openBoardsModal(tab = 'list') {
    elBoardsModal.classList.remove('hidden');
    switchBoardsTab(tab);
    fetchBoards();
  }

  function switchBoardsTab(tab) {
    if (tab === 'list') {
      elTabBoardsList.classList.add('active');
      elTabNewBoard.classList.remove('active');
      elBoardsListView.classList.remove('hidden');
      elNewBoardView.classList.add('hidden');
    } else {
      elTabBoardsList.classList.remove('active');
      elTabNewBoard.classList.add('active');
      elBoardsListView.classList.add('hidden');
      elNewBoardView.classList.remove('hidden');
      if (elNewBoardTitle) elNewBoardTitle.focus();
    }
  }

  if (elBtnBoardsManager) {
    elBtnBoardsManager.addEventListener('click', () => openBoardsModal('list'));
  }
  if (elBtnBoardsModalClose) {
    elBtnBoardsModalClose.addEventListener('click', () => elBoardsModal.classList.add('hidden'));
  }
  if (elBtnCloseBoardsModal) {
    elBtnCloseBoardsModal.addEventListener('click', () => elBoardsModal.classList.add('hidden'));
  }
  if (elTabBoardsList) {
    elTabBoardsList.addEventListener('click', () => switchBoardsTab('list'));
  }
  if (elTabNewBoard) {
    elTabNewBoard.addEventListener('click', () => switchBoardsTab('new'));
  }
  if (elBtnGoCreateBoard) {
    elBtnGoCreateBoard.addEventListener('click', () => switchBoardsTab('new'));
  }
  if (elBtnCancelCreateBoard) {
    elBtnCancelCreateBoard.addEventListener('click', () => switchBoardsTab('list'));
  }

  if (elBoardsSearchInput) {
    elBoardsSearchInput.addEventListener('input', () => {
      renderBoardsCards(cachedBoards);
    });
  }

  // Reviewer chip selectors in New Board form
  if (elReviewerCountChips) {
    elReviewerCountChips.querySelectorAll('.chip-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        elReviewerCountChips.querySelectorAll('.chip-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const count = btn.dataset.revs;
        if (count === 'custom') {
          elNewBoardReviewerNames.focus();
        } else {
          const num = parseInt(count, 10);
          const names = [];
          for (let i = 1; i <= num; i++) {
            names.push(`Reviewer ${i}`);
          }
          elNewBoardReviewerNames.value = names.join(', ');
        }
      });
    });
  }

  // Handle New Board Form Submission
  if (elCreateBoardForm) {
    elCreateBoardForm.addEventListener('submit', async (e) => {
      e.preventDefault();
      const title = elNewBoardTitle.value.trim();
      if (!title) return;

      const slug = (elNewBoardId ? elNewBoardId.value.trim() : '');
      const limit = elNewBoardLimit ? parseInt(elNewBoardLimit.value, 10) : 5000;
      const activeChip = elReviewerCountChips ? elReviewerCountChips.querySelector('.chip-btn.active') : null;
      const numRevs = activeChip && activeChip.dataset.revs !== 'custom' ? parseInt(activeChip.dataset.revs, 10) : 3;
      const reviewerNames = elNewBoardReviewerNames ? elNewBoardReviewerNames.value.trim() : '';

      try {
        const res = await fetch('/api/boards', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: title,
            id: slug,
            targetCharLimit: limit,
            numReviewers: numRevs,
            reviewerNames: reviewerNames
          })
        });

        const data = await res.json();
        if (data.success && data.docId) {
          showToast(`Board "${title}" created successfully! Redirecting...`, 'success');
          setTimeout(() => {
            window.location.search = `?doc=${encodeURIComponent(data.docId)}`;
          }, 400);
        } else {
          showToast('Failed to create board: ' + (data.error || 'Unknown error'), 'error');
        }
      } catch (err) {
        console.error(err);
        showToast('Error creating board', 'error');
      }
    });
  }

  // Fetch boards count on initial load
  fetch('/api/boards').then(r => r.json()).then(boards => {
    cachedBoards = boards;
    if (elBoardsCountBadge) {
      elBoardsCountBadge.textContent = boards.length;
    }
  }).catch(() => {});

  // --- Toast Notifications ---

  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.textContent = message;

    elToastContainer.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = 'opacity 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3200);
  }

})();
