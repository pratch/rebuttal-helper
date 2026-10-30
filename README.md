# Rebuttal Helper 📝⚡

A lightweight, real-time collaborative web application designed for academic paper rebuttals (AAAI, NeurIPS, CVPR, ICML, ICLR). Features Jupyter-style cell-by-cell editing (Markdown code on the left, live rendering with LaTeX math equations on the right), real-time cursor tracking and presence indicators (Google Docs style), and character counters under every cell.

---

## 🌟 Key Features

1. **Adaptive 3-Column / 2-Column Jupyter-Style Cells**
   - **Column 1 (Left): Reviewer Panel**:
     - **Reviewer Identifier**: Name/tag input (e.g. `Reviewer jV3P`, `Reviewer 2`, `Meta-Reviewer`).
     - **Score Badge**: Color-coded score indicators (`8–10 Accept` in green, `5–7 Borderline/Weak Accept` in amber, `1–4 Reject` in red).
     - **Original Review / Question Box**: Keep reviewer critique visible right next to your response draft.
     - **❝ Quote to Reply**: One-click quoting of selected reviewer critique into your rebuttal markdown editor formatted as `> **Reviewer**: *"..."*`.
     - **Collapsible Ribbon (`◀` / `▶`)**: Fold the reviewer panel into a slim vertical ribbon badge anytime to give full width to the markdown code and render columns.
   - **Column 2 (Center): Markdown Code Editor**:
     - Monospace code editor with auto-resizing, tab indentation, and format helpers.
     - **Realtime character counter** below each cell (with spaces, without spaces, words).
   - **Column 3 (Right): Live Rendered Preview**:
     - Instant LaTeX math equation rendering via **KaTeX** (`$...$` and `$$...$$`).
     - Tables, quotes, and markdown formatting rendered and sanitized via DOMPurify.

2. **Real-time Collaboration & Presence (Google Docs Style)**
   - **Shareable URL**: Share the URL (e.g. `http://your-server:3000/?doc=paper-rebuttal-1`) and anyone with the link can edit collaboratively in real time.
   - **Active Collaborator Avatars**: Top header shows circular colored avatars of everyone currently viewing/editing the document.
   - **Live Cursor & Focus Tracking**:
     - Remote users' current editing cell is highlighted with their assigned color and badge (`Alex is editing...`).
     - Live cursor caret positioned right inside the code editor where peers are typing.
   - **Customizable Profile**: Click your avatar to change your display name and avatar color.

3. **Rebuttal Character Counters & Progress Meter**
   - **Per-Cell Character Count**: Displayed directly below each markdown code cell in real-time as you type:
     - Characters with spaces
     - Characters without spaces
     - Word count
   - **Document-wide Rebuttal Meter**:
     - Global total characters with live progress bar.
     - Preset limit selectors: **AAAI (5,000)**, **NeurIPS / CVPR (4,000)**, **ICLR (6,000)**, or Custom.
     - Automatic warning color when reaching 90% and red alert when exceeding limit.

4. **Multiple View Modes (Header Switcher)**
   - 🖥️ **3-Column Mode**: `Reviewer | Code | Render` (Everything in one glance)
   - 📝 **Rebuttal Only 2-Col**: `Code | Render` (Folds reviewer panels into compact ribbons)
   - 🎯 **Reviewer + Code Focus**: `Reviewer | Code`
   - 🌐 **Render Only**: Full document preview mode

5. **Self-Contained & Fast**
   - KaTeX, Marked, and DOMPurify are vendored locally from `node_modules`—works seamlessly on internal NAS / LAN without external CDN dependencies.
   - Auto-saves all changes locally to `./data/docs/<docId>.json`.
   - Export options: Copy combined Markdown, download `.md` file, or export standalone rendered `.html`.

---

## 🚀 Getting Started

### 1. Installation

```bash
cd /ist-nas/users/pratchp/projects/utils/rebuttal_helper
npm install
```

### 2. Start the Server

```bash
# Default port 3000
npm start

# Or specify a custom port
PORT=8080 npm start
```

### 3. Open in Browser

Open your browser to:
```
http://localhost:3000
```
Or share the URL with your collaborators across the local network:
```
http://<server-ip>:3000/?doc=my-paper-rebuttal
```

---

## ⌨️ Keyboard Shortcuts

| Shortcut | Action |
| :--- | :--- |
| <kbd>Shift</kbd> + <kbd>Enter</kbd> | Add new markdown cell directly below current cell |
| <kbd>Tab</kbd> | Insert 2 spaces in editor without losing focus |

---

## 📂 Project Structure

```
rebuttal_helper/
├── server.js               # Express & Socket.io server (rooms, presence, storage)
├── package.json            # Dependencies & start script
├── data/
│   └── docs/               # Persisted rebuttal JSON documents
├── public/
│   ├── index.html          # Application UI layout & modals
│   ├── css/
│   │   └── style.css       # Responsive dark/light theme & cell layouts
│   └── js/
│       ├── markdown-math.js# KaTeX math extraction + DOMPurify sanitization
│       └── app.js          # Client real-time collaboration logic
└── README.md
```
