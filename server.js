const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');
const Y = require('yjs');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});

const PORT = process.env.PORT || 3000;
const DATA_DIR = path.join(__dirname, 'data', 'docs');
const HISTORY_DIR = path.join(__dirname, 'data', 'history');

// Ensure data and history directories exist
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}
if (!fs.existsSync(HISTORY_DIR)) {
  fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

// Security: Validate document IDs to prevent path traversal
function sanitizeDocId(docId) {
  if (!docId || typeof docId !== 'string') return 'default';
  // Allow only alphanumeric, dashes, underscores
  const clean = docId.trim().replace(/[^a-zA-Z0-9_-]/g, '');
  return clean.length > 0 ? clean.slice(0, 64) : 'default';
}

function getDocFilePath(docId) {
  const sanitized = sanitizeDocId(docId);
  return path.join(DATA_DIR, `${sanitized}.json`);
}

function getDocHistoryDir(docId) {
  const sanitized = sanitizeDocId(docId);
  const dir = path.join(HISTORY_DIR, sanitized);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

// In-memory document cache to allow rapid concurrent edits
const docCache = new Map();
const saveTimeouts = new Map();
const lastSnapshotTimes = new Map();

// Server-side Yjs Documents for Conflict-Free Replicated Data (CRDT)
const yDocs = new Map(); // docId -> Y.Doc
const diskSyncTimers = new Map();

function getOrCreateYDoc(docId, doc) {
  const sanitized = sanitizeDocId(docId);
  if (yDocs.has(sanitized)) {
    return yDocs.get(sanitized);
  }
  const yDoc = new Y.Doc();
  if (doc && Array.isArray(doc.cells)) {
    doc.cells.forEach(cell => {
      const yText = yDoc.getText('cell-' + cell.id);
      if (cell.content && yText.length === 0) {
        yText.insert(0, cell.content);
      }
    });
  }
  yDocs.set(sanitized, yDoc);
  return yDoc;
}

function createDefaultDoc(docId, options = {}) {
  const title = (options.title && options.title.trim()) || (docId === 'advisor-review-demo' ? 'Paper 1 Rebuttal' : 'Paper Rebuttal');
  const targetCharLimit = Number(options.targetCharLimit) || 5000;

  let reviewerList = [];
  if (options.reviewerNames && typeof options.reviewerNames === 'string') {
    reviewerList = options.reviewerNames.split(',').map(s => s.trim()).filter(Boolean);
  } else if (Array.isArray(options.reviewerNames) && options.reviewerNames.length > 0) {
    reviewerList = options.reviewerNames.map(s => String(s).trim()).filter(Boolean);
  }

  // If explicit reviewer count or names provided, generate tailored cells
  if (reviewerList.length > 0 || options.numReviewers) {
    const count = reviewerList.length > 0 ? reviewerList.length : (Number(options.numReviewers) || 3);
    if (reviewerList.length === 0) {
      for (let i = 1; i <= count; i++) {
        reviewerList.push(`Reviewer ${i}`);
      }
    }

    const cells = [
      {
        id: 'cell-' + Date.now() + '-overview',
        title: 'General Response to All Reviewers',
        reviewerName: 'All Reviewers',
        reviewerScore: 'Overview',
        reviewerComment: 'Summary of common questions across all reviewers:\n1. Core motivation and novelty\n2. Key benchmark results\n3. Clarifications on assumptions',
        content: `# General Response\n\nWe thank all reviewers for their constructive evaluation and positive feedback.\n\n### Summary of Revisions\n- We addressed all major questions on methodology and experimental baselines.\n- Key comparisons and metrics are summarized below.`,
        reviewerCollapsed: false
      }
    ];

    reviewerList.forEach((revName, idx) => {
      const revNum = idx + 1;
      cells.push({
        id: 'cell-' + Date.now() + '-' + revNum,
        title: `Response to ${revName}`,
        reviewerName: revName,
        reviewerScore: 'Score',
        reviewerComment: `Original comments from ${revName}:\n- Question 1: ...\n- Question 2: ...`,
        content: `## Response to ${revName}\n\n> **${revName}.1**: *"..."*\n\n**Reply**: `,
        reviewerCollapsed: false
      });
    });

    return {
      id: docId,
      title: title,
      targetCharLimit: targetCharLimit,
      cells: cells,
      comments: [],
      updatedAt: Date.now()
    };
  }

  // Fallback demo document with AAAI sync-guided sample
  return {
    id: docId,
    title: title,
    targetCharLimit: 5000,
    cells: [
      {
        id: 'cell-' + Date.now() + '-1',
        title: 'General Response to All Reviewers',
        reviewerName: 'All Reviewers',
        reviewerScore: 'Overview',
        reviewerComment: 'Summary of common questions across all reviewers:\n1. Computational complexity and scaling\n2. Loss formulation balance weights\n3. User study on side-lateral camera angles',
        content: `# General Response\n\nWe thank all reviewers for their constructive feedback and appreciation of our work on **sync-guided generation**.\n\n### Key Clarifications\n1. **Computational Complexity**: Our proposed approach reduces inference time from $\\mathcal{O}(N^2)$ to $\\mathcal{O}(N \\log N)$.\n2. **Loss Formulation**: The objective function is given by:\n$$\n\\mathcal{L}_{total} = \\lambda_{sync} \\mathcal{L}_{sync} + \\lambda_{rec} \\mathcal{L}_{rec} + \\gamma \\| \\mathbf{W} \\|_2^2\n$$\nwhere $\\lambda_{sync} = 0.5$ and $\\lambda_{rec} = 1.0$ across all benchmark settings.\n\n3. **User Study**: See Table 1 for updated 5-camera cross-evaluation results.`,
        reviewerCollapsed: false
      },
      {
        id: 'cell-' + Date.now() + '-2',
        title: 'Response to Reviewer jV3P',
        reviewerName: 'Reviewer jV3P',
        reviewerScore: '6',
        reviewerComment: 'How does the method handle extreme side-lateral camera angles (e.g. 45-75 degrees)? The user study lacks cross-camera evaluations on non-frontal poses.',
        content: `## Response to Reviewer jV3P\n\n> **jV3P.1**: *"How does the method handle extreme side-lateral camera angles?"*\n\n**Reply**: We have performed additional evaluations specifically on side-lateral camera poses (angles between $45^\\circ$ and $75^\\circ$).\n\n- Sync accuracy remains above $94.2\\%$.\n- Landmark alignment error decreases from $3.4\\text{px}$ to $1.1\\text{px}$ using our landmark prior.`,
        reviewerCollapsed: false
      },
      {
        id: 'cell-' + Date.now() + '-3',
        title: 'Response to Reviewer 2',
        reviewerName: 'Reviewer 2',
        reviewerScore: '5',
        reviewerComment: 'Missing baseline comparison with Wav2Lip on cropped face settings. Please provide quantitative PSNR/SSIM numbers on the benchmark test set.',
        content: `## Response to Reviewer 2\n\n> **R2.1**: *"Missing baseline comparison with Wav2Lip on cropped face settings."*\n\n**Reply**: As suggested, we have added direct comparisons with Wav2Lip on matched cropped face datasets. Our model outperforms Wav2Lip by **+2.4 dB PSNR** and **+0.18 SSIM** while preserving exact lip synchronization.`,
        reviewerCollapsed: false
      }
    ],
    comments: [],
    updatedAt: Date.now()
  };
}

function loadDocument(docId) {
  const sanitized = sanitizeDocId(docId);
  if (docCache.has(sanitized)) {
    return docCache.get(sanitized);
  }

  const filePath = getDocFilePath(sanitized);
  if (fs.existsSync(filePath)) {
    try {
      const data = fs.readFileSync(filePath, 'utf-8');
      const doc = JSON.parse(data);
      if (!Array.isArray(doc.comments)) doc.comments = [];
      if (!doc.pastebox) doc.pastebox = { content: '', collapsed: false };
      docCache.set(sanitized, doc);
      return doc;
    } catch (err) {
      console.error(`Failed to parse doc ${sanitized}:`, err);
    }
  }

  const newDoc = createDefaultDoc(sanitized);
  saveDocument(sanitized, newDoc, true);
  return newDoc;
}

function createHistorySnapshot(docId, doc) {
  try {
    const sanitized = sanitizeDocId(docId);
    const histDir = getDocHistoryDir(sanitized);
    const now = Date.now();
    const snapshotPath = path.join(histDir, `${now}.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(doc, null, 2), 'utf-8');

    // Prune to keep at most 50 recent snapshots
    const files = fs.readdirSync(histDir)
      .filter(f => f.endsWith('.json'))
      .sort((a, b) => parseInt(b) - parseInt(a));

    if (files.length > 50) {
      files.slice(50).forEach(oldFile => {
        try { fs.unlinkSync(path.join(histDir, oldFile)); } catch (e) {}
      });
    }
    lastSnapshotTimes.set(sanitized, now);
  } catch (err) {
    console.error('Failed to create history snapshot:', err);
  }
}

function saveDocument(docId, doc, immediate = false) {
  const sanitized = sanitizeDocId(docId);
  if (!Array.isArray(doc.comments)) doc.comments = [];
  docCache.set(sanitized, doc);

  const performWrite = () => {
    const filePath = getDocFilePath(sanitized);
    try {
      fs.writeFileSync(filePath, JSON.stringify(doc, null, 2), 'utf-8');

      // Periodic history snapshot: create snapshot every 3 minutes if modified
      const lastSnap = lastSnapshotTimes.get(sanitized) || 0;
      if (Date.now() - lastSnap > 3 * 60 * 1000) {
        createHistorySnapshot(sanitized, doc);
      }
    } catch (err) {
      console.error(`Failed to save doc ${sanitized}:`, err);
    }
  };

  if (immediate) {
    performWrite();
  } else {
    if (saveTimeouts.has(sanitized)) {
      clearTimeout(saveTimeouts.get(sanitized));
    }
    const timeout = setTimeout(() => {
      performWrite();
      saveTimeouts.delete(sanitized);
    }, 1000);
    saveTimeouts.set(sanitized, timeout);
  }
}

// Serve node_modules assets locally for offline self-containment
app.use('/vendor/katex', express.static(path.join(__dirname, 'node_modules/katex/dist')));
app.use('/vendor/marked', express.static(path.join(__dirname, 'node_modules/marked/lib')));
app.use('/vendor/dompurify', express.static(path.join(__dirname, 'node_modules/dompurify/dist')));

// Serve static frontend
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// REST API for doc export / info
app.get('/api/doc/:id', (req, res) => {
  const doc = loadDocument(req.params.id);
  res.json(doc);
});

app.get('/api/doc/:id/markdown', (req, res) => {
  const doc = loadDocument(req.params.id);
  const combined = doc.cells.map(c => c.content).join('\n\n---\n\n');
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${doc.id}-rebuttal.md"`);
  res.send(combined);
});

// REST API for Boards Management
app.get('/api/boards', (req, res) => {
  try {
    const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.json'));
    const boards = [];

    for (const file of files) {
      const docId = file.replace(/\.json$/, '');
      const doc = loadDocument(docId);
      if (!doc) continue;

      let totalChars = 0;
      const reviewers = [];
      if (Array.isArray(doc.cells)) {
        for (const cell of doc.cells) {
          const content = cell.content || '';
          const normalized = content.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
          const noHtml = normalized.replace(/<!--[\s\S]*?-->/g, '');
          const cleanLines = noHtml.split('\n').filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('%%'));
          totalChars += cleanLines.join('\n').length;

          if (cell.reviewerName && cell.reviewerName !== 'All Reviewers' && !reviewers.includes(cell.reviewerName)) {
            reviewers.push(cell.reviewerName);
          }
        }
      }

      const openComments = (doc.comments || []).filter(c => !c.resolved).length;

      boards.push({
        id: doc.id || docId,
        title: doc.title || docId,
        targetCharLimit: doc.targetCharLimit || 5000,
        cellsCount: (doc.cells || []).length,
        reviewers: reviewers,
        numReviewers: reviewers.length,
        charCount: totalChars,
        openCommentsCount: openComments,
        updatedAt: doc.updatedAt || fs.statSync(path.join(DATA_DIR, file)).mtimeMs
      });
    }

    boards.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    res.json(boards);
  } catch (err) {
    console.error('Failed to list boards:', err);
    res.status(500).json({ error: 'Failed to list boards' });
  }
});

app.post('/api/boards', (req, res) => {
  try {
    const { id, title, targetCharLimit, numReviewers, reviewerNames } = req.body;
    let targetId = id;
    if (!targetId || typeof targetId !== 'string' || !targetId.trim()) {
      if (title && typeof title === 'string') {
        targetId = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      }
      if (!targetId) {
        targetId = 'rebuttal-' + Math.random().toString(36).substring(2, 8);
      }
    }
    const cleanId = sanitizeDocId(targetId);
    const filePath = getDocFilePath(cleanId);

    // If file already exists, return existing
    if (fs.existsSync(filePath)) {
      const existing = loadDocument(cleanId);
      return res.json({ success: true, docId: cleanId, doc: existing, existed: true });
    }

    const newDoc = createDefaultDoc(cleanId, {
      title: title || 'Paper Rebuttal',
      targetCharLimit: Number(targetCharLimit) || 5000,
      numReviewers: Number(numReviewers) || 3,
      reviewerNames: reviewerNames
    });

    saveDocument(cleanId, newDoc, true);
    createHistorySnapshot(cleanId, newDoc);

    res.json({ success: true, docId: cleanId, doc: newDoc, existed: false });
  } catch (err) {
    console.error('Failed to create board:', err);
    res.status(500).json({ error: 'Failed to create board' });
  }
});

app.delete('/api/boards/:id', (req, res) => {
  try {
    const cleanId = sanitizeDocId(req.params.id);
    const filePath = getDocFilePath(cleanId);
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
    docCache.delete(cleanId);
    yDocs.delete(cleanId);
    res.json({ success: true });
  } catch (err) {
    console.error('Failed to delete board:', err);
    res.status(500).json({ error: 'Failed to delete board' });
  }
});

// Socket.io Realtime Collaboration
// Active rooms tracking: room -> Map of socketId -> userInfo
const roomPresence = new Map();

// Random friendly avatar colors
const AVATAR_COLORS = [
  '#2563eb', // blue
  '#059669', // emerald
  '#d97706', // amber
  '#dc2626', // red
  '#7c3aed', // purple
  '#db2777', // pink
  '#0891b2', // cyan
  '#4f46e5', // indigo
  '#ea580c', // orange
  '#16a34a'  // green
];

const ANIMAL_NAMES = [
  'Falcon', 'Panda', 'Otter', 'Fox', 'Koala', 
  'Eagle', 'Lynx', 'Dolphin', 'Tiger', 'Owl'
];

function getRandomUser(customName) {
  const color = AVATAR_COLORS[Math.floor(Math.random() * AVATAR_COLORS.length)];
  const animal = ANIMAL_NAMES[Math.floor(Math.random() * ANIMAL_NAMES.length)];
  return {
    name: customName || `Anonymous ${animal}`,
    color: color
  };
}

io.on('connection', (socket) => {
  let currentDocId = null;
  let currentUser = null;

  socket.on('join-doc', ({ docId, userName, userColor }) => {
    currentDocId = sanitizeDocId(docId);
    socket.join(currentDocId);

    const generated = getRandomUser(userName);
    currentUser = {
      socketId: socket.id,
      name: userName || generated.name,
      color: userColor || generated.color,
      activeCellId: null,
      cursor: null
    };

    if (!roomPresence.has(currentDocId)) {
      roomPresence.set(currentDocId, new Map());
    }
    roomPresence.get(currentDocId).set(socket.id, currentUser);

    const doc = loadDocument(currentDocId);
    const yDoc = getOrCreateYDoc(currentDocId, doc);
    const yjsState = Y.encodeStateAsUpdate(yDoc);

    // Send initial doc state to joined user with Yjs state
    socket.emit('init-doc', {
      doc,
      yjsState: Buffer.from(yjsState).toString('base64'),
      user: currentUser,
      activeUsers: Array.from(roomPresence.get(currentDocId).values())
    });

    // Notify others in room of new user
    socket.to(currentDocId).emit('user-joined', currentUser);
    io.to(currentDocId).emit('presence-update', Array.from(roomPresence.get(currentDocId).values()));
  });

  // Yjs Real-Time CRDT Update (Google Docs character-by-character concurrent sync)
  socket.on('yjs-update', ({ docId, update }) => {
    const targetDocId = sanitizeDocId(docId || currentDocId);
    if (!targetDocId) return;
    const yDoc = yDocs.get(targetDocId);
    if (yDoc && Array.isArray(update)) {
      try {
        const binUpdate = new Uint8Array(update);
        Y.applyUpdate(yDoc, binUpdate);

        // Broadcast to all other peers in the room
        socket.to(targetDocId).emit('yjs-update', {
          docId: targetDocId,
          update: update
        });

        // Debounced sync to disk document
        clearTimeout(diskSyncTimers.get(targetDocId));
        diskSyncTimers.set(targetDocId, setTimeout(() => {
          const currentDoc = loadDocument(targetDocId);
          if (currentDoc && yDoc) {
            currentDoc.cells.forEach(c => {
              const yText = yDoc.getText('cell-' + c.id);
              c.content = yText.toString();
            });
            currentDoc.updatedAt = Date.now();
            saveDocument(targetDocId, currentDoc);
          }
        }, 500));
      } catch (err) {
        console.error('Error applying Yjs update on server:', err);
      }
    }
  });

  // Dedicated Quick Pastebox update
  socket.on('pastebox-update', ({ docId, content, collapsed }) => {
    const targetDocId = sanitizeDocId(docId || currentDocId);
    if (!targetDocId) return;
    const doc = loadDocument(targetDocId);
    if (doc) {
      if (!doc.pastebox) doc.pastebox = {};
      if (content !== undefined) doc.pastebox.content = String(content || '');
      if (collapsed !== undefined) doc.pastebox.collapsed = Boolean(collapsed);
      doc.updatedAt = Date.now();
      saveDocument(targetDocId, doc);

      socket.to(targetDocId).emit('pastebox-updated', {
        content: doc.pastebox.content,
        collapsed: doc.pastebox.collapsed
      });
    }
  });

  socket.on('update-user-profile', ({ name, color }) => {
    if (!currentDocId || !currentUser) return;
    if (name) currentUser.name = String(name).slice(0, 30);
    if (color) currentUser.color = String(color).slice(0, 10);
    
    if (roomPresence.has(currentDocId)) {
      roomPresence.get(currentDocId).set(socket.id, currentUser);
      io.to(currentDocId).emit('presence-update', Array.from(roomPresence.get(currentDocId).values()));
    }
  });

  // Cell content update
  socket.on('cell-update', ({ cellId, content, cursor }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const cell = doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.content = content;
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);

      // Broadcast update to other users in the room
      socket.to(currentDocId).emit('cell-updated', {
        cellId,
        content,
        updatedBy: currentUser?.name || 'Someone'
      });
    }

    // Update cursor presence
    if (currentUser) {
      currentUser.activeCellId = cellId;
      currentUser.cursor = cursor;
      socket.to(currentDocId).emit('cursor-moved', {
        socketId: socket.id,
        user: currentUser,
        cellId,
        cursor
      });
    }
  });

  // Cell selection / cursor movement without typing
  socket.on('cursor-move', ({ cellId, cursor }) => {
    if (!currentDocId || !currentUser) return;
    currentUser.activeCellId = cellId;
    currentUser.cursor = cursor;
    socket.to(currentDocId).emit('cursor-moved', {
      socketId: socket.id,
      user: currentUser,
      cellId,
      cursor
    });
  });

  // Cell blur
  socket.on('cell-blur', ({ cellId }) => {
    if (!currentDocId || !currentUser) return;
    if (currentUser.activeCellId === cellId) {
      currentUser.activeCellId = null;
      currentUser.cursor = null;
      socket.to(currentDocId).emit('cursor-cleared', {
        socketId: socket.id,
        cellId
      });
    }
  });

  // Add cell
  socket.on('cell-add', ({ afterCellId, title, content, reviewerName, reviewerScore, reviewerComment }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const newCell = {
      id: 'cell-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title: title || `Cell #${doc.cells.length + 1}`,
      reviewerName: reviewerName || 'Reviewer',
      reviewerScore: reviewerScore || '6',
      reviewerComment: reviewerComment || '',
      reviewerCollapsed: false,
      content: content || ''
    };

    if (afterCellId) {
      const idx = doc.cells.findIndex(c => c.id === afterCellId);
      if (idx !== -1) {
        doc.cells.splice(idx + 1, 0, newCell);
      } else {
        doc.cells.push(newCell);
      }
    } else {
      doc.cells.push(newCell);
    }

    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);

    const yDoc = yDocs.get(currentDocId);
    if (yDoc && newCell.content) {
      const yText = yDoc.getText('cell-' + newCell.id);
      if (yText.length === 0) yText.insert(0, newCell.content);
    }

    io.to(currentDocId).emit('doc-cells-updated', {
      cells: doc.cells,
      action: 'add',
      targetCellId: newCell.id
    });
  });

  // Delete cell
  socket.on('cell-delete', ({ cellId }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    if (doc.cells.length <= 1) {
      // Keep at least one cell
      return;
    }
    const idx = doc.cells.findIndex(c => c.id === cellId);
    if (idx !== -1) {
      doc.cells.splice(idx, 1);
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);

      io.to(currentDocId).emit('doc-cells-updated', {
        cells: doc.cells,
        action: 'delete',
        targetCellId: cellId
      });
    }
  });

  // Move cell
  socket.on('cell-move', ({ cellId, direction }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const idx = doc.cells.findIndex(c => c.id === cellId);
    if (idx === -1) return;

    if (direction === 'up' && idx > 0) {
      const temp = doc.cells[idx - 1];
      doc.cells[idx - 1] = doc.cells[idx];
      doc.cells[idx] = temp;
    } else if (direction === 'down' && idx < doc.cells.length - 1) {
      const temp = doc.cells[idx + 1];
      doc.cells[idx + 1] = doc.cells[idx];
      doc.cells[idx] = temp;
    } else {
      return;
    }

    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);

    io.to(currentDocId).emit('doc-cells-updated', {
      cells: doc.cells,
      action: 'move',
      targetCellId: cellId
    });
  });

  // Duplicate cell
  socket.on('cell-duplicate', ({ cellId }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const idx = doc.cells.findIndex(c => c.id === cellId);
    if (idx === -1) return;

    const source = doc.cells[idx];
    const newCell = {
      id: 'cell-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      title: `${source.title || 'Cell'} (Copy)`,
      reviewerName: source.reviewerName || 'Reviewer',
      reviewerScore: source.reviewerScore || '6',
      reviewerComment: source.reviewerComment || '',
      reviewerCollapsed: !!source.reviewerCollapsed,
      content: source.content
    };
    doc.cells.splice(idx + 1, 0, newCell);
    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);

    io.to(currentDocId).emit('doc-cells-updated', {
      cells: doc.cells,
      action: 'duplicate',
      targetCellId: newCell.id
    });
  });

  // Update reviewer fields for a cell
  socket.on('cell-reviewer-update', ({ cellId, reviewerName, reviewerScore, reviewerComment }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const cell = doc.cells.find(c => c.id === cellId);
    if (cell) {
      if (reviewerName !== undefined) cell.reviewerName = String(reviewerName || '').slice(0, 50);
      if (reviewerScore !== undefined) cell.reviewerScore = String(reviewerScore || '').slice(0, 30);
      if (reviewerComment !== undefined) cell.reviewerComment = String(reviewerComment || '');
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);
      socket.to(currentDocId).emit('cell-reviewer-updated', {
        cellId,
        reviewerName: cell.reviewerName,
        reviewerScore: cell.reviewerScore,
        reviewerComment: cell.reviewerComment
      });
    }
  });

  // Toggle reviewer panel collapse for a cell
  socket.on('cell-reviewer-toggle-collapse', ({ cellId, collapsed }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const cell = doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.reviewerCollapsed = !!collapsed;
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);
      socket.to(currentDocId).emit('cell-reviewer-collapse-updated', {
        cellId,
        collapsed: cell.reviewerCollapsed
      });
    }
  });

  // Update cell title
  socket.on('cell-title-update', ({ cellId, title }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    const cell = doc.cells.find(c => c.id === cellId);
    if (cell) {
      cell.title = String(title || '').slice(0, 100);
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);
      socket.to(currentDocId).emit('cell-title-updated', { cellId, title: cell.title });
    }
  });

  // Update doc title
  socket.on('doc-title-update', ({ title }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    doc.title = String(title || 'Untitled Rebuttal').slice(0, 120);
    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);
    socket.to(currentDocId).emit('doc-title-updated', { title: doc.title });
  });

  // Update target char limit
  socket.on('doc-limit-update', ({ targetCharLimit }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    doc.targetCharLimit = parseInt(targetCharLimit, 10) || 0;
    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);
    socket.to(currentDocId).emit('doc-limit-updated', { targetCharLimit: doc.targetCharLimit });
  });

  // --- Inline Comments (Google Docs Style) ---
  socket.on('comment-add', ({ cellId, highlightedText, commentText, author, authorColor }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    if (!Array.isArray(doc.comments)) doc.comments = [];

    const newComment = {
      id: 'cmt-' + Date.now() + '-' + Math.floor(Math.random() * 1000),
      cellId: cellId || null,
      author: String(author || currentUser?.name || 'Collaborator').slice(0, 40),
      authorColor: authorColor || currentUser?.color || '#3b82f6',
      highlightedText: String(highlightedText || '').slice(0, 300),
      commentText: String(commentText || '').slice(0, 1000),
      createdAt: Date.now(),
      resolved: false
    };

    doc.comments.push(newComment);
    doc.updatedAt = Date.now();
    saveDocument(currentDocId, doc);

    io.to(currentDocId).emit('comment-added', newComment);
  });

  socket.on('comment-resolve', ({ commentId, resolved }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    if (!Array.isArray(doc.comments)) return;

    const comment = doc.comments.find(c => c.id === commentId);
    if (comment) {
      comment.resolved = !!resolved;
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);
      io.to(currentDocId).emit('comment-resolved', { commentId, resolved: comment.resolved });
    }
  });

  socket.on('comment-delete', ({ commentId }) => {
    if (!currentDocId) return;
    const doc = loadDocument(currentDocId);
    if (!Array.isArray(doc.comments)) return;

    const idx = doc.comments.findIndex(c => c.id === commentId);
    if (idx !== -1) {
      doc.comments.splice(idx, 1);
      doc.updatedAt = Date.now();
      saveDocument(currentDocId, doc);
      io.to(currentDocId).emit('comment-deleted', { commentId });
    }
  });

  // --- Revision History & Snapshot Restores ---
  socket.on('get-doc-history', () => {
    if (!currentDocId) return;
    const sanitized = sanitizeDocId(currentDocId);
    const histDir = getDocHistoryDir(sanitized);

    try {
      const files = fs.readdirSync(histDir)
        .filter(f => f.endsWith('.json'))
        .sort((a, b) => parseInt(b) - parseInt(a));

      const snapshots = files.slice(0, 30).map(file => {
        const timestamp = parseInt(file.replace('.json', ''), 10);
        try {
          const content = JSON.parse(fs.readFileSync(path.join(histDir, file), 'utf-8'));
          let charCount = 0;
          if (Array.isArray(content.cells)) {
            content.cells.forEach(c => { charCount += (c.content || '').length; });
          }
          return {
            timestamp,
            title: content.title || 'Snapshot',
            cellsCount: content.cells ? content.cells.length : 0,
            charCount
          };
        } catch (e) {
          return { timestamp, title: 'Snapshot', cellsCount: 0, charCount: 0 };
        }
      });

      socket.emit('doc-history-data', { snapshots });
    } catch (err) {
      console.error('Failed to read doc history:', err);
      socket.emit('doc-history-data', { snapshots: [] });
    }
  });

  socket.on('restore-doc-history', ({ timestamp }) => {
    if (!currentDocId || !timestamp) return;
    const sanitized = sanitizeDocId(currentDocId);
    const histDir = getDocHistoryDir(sanitized);
    const snapshotPath = path.join(histDir, `${timestamp}.json`);

    if (fs.existsSync(snapshotPath)) {
      try {
        const data = fs.readFileSync(snapshotPath, 'utf-8');
        const restoredDoc = JSON.parse(data);
        restoredDoc.updatedAt = Date.now();

        // Create backup of current state before restoring
        const currentDoc = loadDocument(sanitized);
        createHistorySnapshot(sanitized, currentDoc);

        // Save restored
        saveDocument(sanitized, restoredDoc, true);
        io.to(currentDocId).emit('init-doc', {
          doc: restoredDoc,
          user: currentUser,
          activeUsers: Array.from(roomPresence.get(currentDocId).values())
        });
      } catch (err) {
        console.error('Failed to restore snapshot:', err);
      }
    }
  });

  // Disconnect
  socket.on('disconnect', () => {
    if (currentDocId && roomPresence.has(currentDocId)) {
      const room = roomPresence.get(currentDocId);
      room.delete(socket.id);
      if (room.size === 0) {
        roomPresence.delete(currentDocId);
      } else {
        io.to(currentDocId).emit('user-left', { socketId: socket.id });
        io.to(currentDocId).emit('presence-update', Array.from(room.values()));
      }
    }
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`=======================================================`);
  console.log(`🚀 Rebuttal Helper is running on http://localhost:${PORT}`);
  console.log(`Data stored at: ${DATA_DIR}`);
  console.log(`=======================================================`);
});
