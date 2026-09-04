/**
 * ChatFileDrop — reusable drag-and-drop file handling for chat composers.
 * Extracted from ChatView (main chat) so the scoped workbench can opt-in
 * to the same upload/preview/embed behavior by just passing its own
 * container + overlay + preview-area elements.
 *
 * Files aren't sent as a separate WS field — text files are embedded into
 * the text payload (see `embedAllInText()`); image/document/binary files are
 * uploaded to /tmp and passed by path via `buildAttachmentMetas()` so the
 * server can hand the bytes (or a readable path) to the LLM.
 *
 * Multiple files: dropping N files queues all N. The pending set is an array
 * (`getPendingList()`); each file shows its own removable preview chip.
 * Any file type is accepted — unknown extensions are read as inline text,
 * and anything that sniffs as binary falls back to a path reference the
 * model can read with its own tools (mirrors what Claude Code can read).
 *
 * Usage:
 *   const fd = ChatFileDrop.attach({
 *     container: chatContainerEl,
 *     overlay:   dropOverlayEl,
 *     previewArea: filePreviewAreaEl,
 *     input:     textareaEl,
 *     placeholder: 'Message Vodou...',
 *     getFileWarning: (cat) => ..., // optional
 *     toast: Components.toast,       // optional
 *     systemMessage: (msg) => ...,    // optional
 *   });
 *   ...
 *   const pending = fd.getPendingList();
 *   const embedded = ChatFileDrop.embedAllInText(pending, userText);
 *   const attachments = ChatFileDrop.buildAttachmentMetas(pending);
 *   fd.clear();
 */
const ChatFileDrop = (() => {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB per file

  const DOC_EXTENSIONS = [
    '.pdf', '.docx', '.xlsx', '.pptx', '.doc', '.xls', '.ppt',
    '.odt', '.ods', '.odp', '.rtf',
    '.mp3', '.wav', '.m4a', '.ogg', '.flac',
    '.mp4', '.mov', '.webm',
    '.zip', '.tar', '.gz',
  ];

  const TEXT_TYPES = [
    'text/', 'application/json', 'application/xml', 'application/javascript',
    'application/typescript', 'application/yaml', 'application/toml',
    'application/x-sh', 'application/sql',
  ];

  const TEXT_EXTENSIONS = [
    '.txt', '.md', '.js', '.ts', '.py', '.rs', '.go', '.java', '.c', '.cpp', '.h',
    '.css', '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash',
    '.sql', '.csv', '.tsv', '.log', '.env', '.conf', '.cfg', '.ini', '.rb',
    '.swift', '.kt', '.lua', '.r', '.php', '.pl', '.ex', '.exs', '.zig',
  ];

  function fileExtension(name) {
    const parts = (name || '').split('.');
    if (parts.length < 2) return ''; // no extension (e.g. "Dockerfile", ".gitignore")
    return '.' + parts.pop().toLowerCase();
  }

  function isDocumentFile(file, ext) {
    return DOC_EXTENSIONS.includes(ext) ||
      file.type === 'application/pdf' ||
      file.type.startsWith('application/vnd.openxmlformats') ||
      file.type.startsWith('application/vnd.ms-') ||
      file.type === 'application/msword' ||
      file.type.startsWith('audio/') ||
      file.type.startsWith('video/');
  }

  function isTextFile(file, ext) {
    return TEXT_TYPES.some((t) => file.type.startsWith(t)) ||
      TEXT_EXTENSIONS.includes(ext);
  }

  // Unknown type/extension: prefer inline text unless the MIME clearly marks
  // it binary. Empty MIME (common for odd source/config extensions) → text.
  // Actual binary content is caught post-read via a NUL-byte sniff below.
  function looksBinaryType(file) {
    const t = file.type || '';
    if (!t) return false;
    if (t.startsWith('text/')) return false;
    if (t.startsWith('application/')) {
      // Most application/* are binary EXCEPT the text-ish ones handled above.
      return !TEXT_TYPES.some((x) => t.startsWith(x));
    }
    return t.startsWith('image/') || t.startsWith('audio/') || t.startsWith('video/');
  }

  function sizeStr(size) {
    if (size < 1024) return size + 'B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + 'KB';
    return (size / 1024 / 1024).toFixed(1) + 'MB';
  }

  /**
   * Build a server-bound `ChannelAttachmentMeta` from a pending file.
   * Returns null for text files (they're inlined) or when there's no usable
   * file path (upload failed).
   */
  function buildAttachmentMeta(file) {
    if (!file || !file.path) return null;
    const mt = (file.mimeType || (file.type === 'image' ? guessImageMime(file.name) : '')) || '';
    return {
      url: file.path,
      filename: file.name,
      mimeType: mt || undefined,
      type: file.type === 'image' ? 'image' : (file.type === 'document' ? 'document' : undefined),
    };
  }

  // Multiple-file variant: metas for every uploaded file, nulls dropped.
  function buildAttachmentMetas(files) {
    if (!Array.isArray(files)) return files ? [buildAttachmentMeta(files)].filter(Boolean) : [];
    return files.map(buildAttachmentMeta).filter(Boolean);
  }

  function guessImageMime(name) {
    const ext = (name || '').toLowerCase().split('.').pop();
    if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
    if (ext === 'png') return 'image/png';
    if (ext === 'gif') return 'image/gif';
    if (ext === 'webp') return 'image/webp';
    return '';
  }

  // Just the payload block for one file (no leading user query).
  function fileBlock(file) {
    if (!file) return '';
    if (file.type === 'text') {
      const truncNote = file.truncated ? '\n[File truncated to first 50,000 characters]' : '';
      return '\n\n<file name="' + file.name + '">\n' + file.content + truncNote + '\n</file>';
    }
    if (file.type === 'image') {
      const pathNote = file.path ? ' saved at ' + file.path : '';
      return '\n\n[User dropped image: ' + file.name + pathNote + ']';
    }
    if (file.type === 'document') {
      const pathNote = file.path ? ' saved at ' + file.path : '';
      const label = file.docType || 'document';
      return '\n\n[User dropped ' + label + ': ' + file.name + pathNote + ']';
    }
    return '';
  }

  /**
   * Embed a single pending file into the user's text (back-compat shim).
   */
  function embedInText(file, userText) {
    if (!file) return userText;
    const userQuery = (userText || '').trim() || 'Analyze this file';
    return userQuery + fileBlock(file);
  }

  /**
   * Embed every pending file into the user's text. The query is stated once,
   * then each file's block is appended in drop order.
   */
  function embedAllInText(files, userText) {
    const list = Array.isArray(files) ? files.filter(Boolean) : (files ? [files] : []);
    if (!list.length) return userText;
    const many = list.length > 1;
    const userQuery = (userText || '').trim() || (many ? 'Analyze these files' : 'Analyze this file');
    return userQuery + list.map(fileBlock).join('');
  }

  function attach(opts) {
    if (!opts || !opts.container || !opts.input) {
      throw new Error('ChatFileDrop.attach: opts.container + opts.input required');
    }

    const state = {
      pendingFiles: [],
      dragCounter: 0,
      idCounter: 0,
    };

    const originalPlaceholder = opts.placeholder || opts.input.placeholder || '';
    const toast = opts.toast || (() => {});
    const systemMessage = opts.systemMessage || (() => {});
    const getFileWarning = opts.getFileWarning || (() => null);
    const onFileReady = opts.onFileReady || (() => {});
    const onInlineImage = opts.onInlineImage || (() => {});

    function previewIcon(type) {
      if (type === 'image') return '🖼';   // 🖼
      if (type === 'text') return '📄';    // 📄
      return '📎';                          // 📎
    }

    // Rebuild the whole preview strip from state.pendingFiles.
    function renderPreviews() {
      if (!opts.previewArea) return;
      if (!state.pendingFiles.length) {
        opts.previewArea.innerHTML = '';
        opts.previewArea.classList.add('is-hidden');
        opts.previewArea.style.display = 'none'; // beat any inline display:none baseline
        return;
      }
      // Flex-wrap so multiple chips flow onto new rows instead of overflowing.
      opts.previewArea.style.display = 'flex';
      opts.previewArea.style.flexWrap = 'wrap';
      opts.previewArea.style.gap = '6px';
      opts.previewArea.innerHTML = state.pendingFiles.map((f) =>
        '<div class="file-preview" data-file-id="' + f._id + '">' +
        '<span>' + previewIcon(f.type) + '</span>' +
        '<span class="file-preview-name"></span>' +
        '<span class="file-preview-size">(' + sizeStr(f.size) + ')</span>' +
        '<span class="file-preview-remove" title="Remove">&times;</span>' +
        '</div>'
      ).join('');
      opts.previewArea.classList.remove('is-hidden');
      // Set names via textContent to avoid HTML injection from file names.
      const chips = opts.previewArea.querySelectorAll('.file-preview');
      chips.forEach((chip) => {
        const id = Number(chip.getAttribute('data-file-id'));
        const f = state.pendingFiles.find((x) => x._id === id);
        const nameEl = chip.querySelector('.file-preview-name');
        if (nameEl && f) nameEl.textContent = f.name;
        const removeBtn = chip.querySelector('.file-preview-remove');
        if (removeBtn) removeBtn.addEventListener('click', () => removeOne(id));
      });
    }

    function refreshPlaceholder() {
      const n = state.pendingFiles.length;
      if (n === 0) { opts.input.placeholder = originalPlaceholder; return; }
      if (n > 1) { opts.input.placeholder = 'Ask about these ' + n + ' files, or press Enter to analyze...'; return; }
      const only = state.pendingFiles[0];
      opts.input.placeholder = only.type === 'image'
        ? 'Ask about this image, or press Enter to analyze...'
        : 'Ask about this file, or press Enter to analyze...';
    }

    function addPending(entry) {
      entry._id = ++state.idCounter;
      state.pendingFiles.push(entry);
      renderPreviews();
      refreshPlaceholder();
      opts.input.focus();
      onFileReady(entry);
    }

    function removeOne(id) {
      state.pendingFiles = state.pendingFiles.filter((f) => f._id !== id);
      renderPreviews();
      refreshPlaceholder();
    }

    function clear() {
      state.pendingFiles = [];
      if (opts.previewArea) {
        opts.previewArea.innerHTML = '';
        opts.previewArea.classList.add('is-hidden');
        opts.previewArea.style.display = 'none';
      }
      opts.input.placeholder = originalPlaceholder;
    }

    // Shared upload for image/document/binary files → returns /tmp path or null.
    function uploadFile(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = async (e) => {
          try {
            const res = await fetch('/api/files/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, data: e.target.result }),
            });
            const result = await res.json();
            resolve(result && result.path ? result.path : null);
          } catch {
            resolve(null);
          }
        };
        reader.onerror = () => resolve(null);
        reader.readAsDataURL(file);
      });
    }

    // Read a file as inline text. If the content sniffs as binary (NUL bytes),
    // returns null so the caller can fall back to a path reference instead.
    function readText(file) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
          let content = e.target.result || '';
          if (content.indexOf('\u0000') !== -1) { resolve(null); return; } // binary
          const MAX_CHARS = 50000;
          let truncated = false;
          if (content.length > MAX_CHARS) {
            content = content.substring(0, MAX_CHARS);
            truncated = true;
          }
          resolve({ content, truncated });
        };
        reader.onerror = () => resolve(null);
        reader.readAsText(file);
      });
    }

    async function addImage(file) {
      const warn = getFileWarning('image');
      if (warn) toast(warn, 'warning');
      const path = await uploadFile(file);
      addPending({ name: file.name, type: 'image', path, size: file.size });
      if (path) onInlineImage(path);
    }

    async function addDocument(file, ext) {
      const docCat = ext === '.pdf' ? 'pdf'
        : ext.match(/\.(mp3|wav|m4a|ogg|flac)/) ? 'audio'
        : ext.match(/\.(mp4|mov|webm)/) ? 'video'
        : 'document';
      const warn = getFileWarning(docCat);
      if (warn) toast(warn, 'warning');
      const path = await uploadFile(file);
      const docType = ext === '.pdf' ? 'pdf'
        : ext.match(/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)/) ? 'document'
        : ext.match(/\.(mp3|wav|m4a|ogg|flac)/) ? 'audio'
        : ext.match(/\.(mp4|mov|webm)/) ? 'video'
        : 'file';
      addPending({ name: file.name, type: 'document', path, size: file.size, docType });
    }

    async function addText(file) {
      const res = await readText(file);
      if (!res) return false; // binary — caller falls back
      addPending({ name: file.name, type: 'text', content: res.content, truncated: res.truncated, size: file.size });
      return true;
    }

    async function handleDroppedFile(file) {
      if (file.size > MAX_SIZE) {
        systemMessage('File too large (max 10MB). "' + file.name + '" is ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.');
        return;
      }
      const ext = fileExtension(file.name);

      if (file.type.startsWith('image/')) { await addImage(file); return; }
      if (isDocumentFile(file, ext))     { await addDocument(file, ext); return; }
      if (isTextFile(file, ext))         { await addText(file); return; }

      // Unknown type — accept anything. Binary-typed → path reference;
      // otherwise try inline text, falling back to a path ref if it sniffs binary.
      if (looksBinaryType(file)) { await addDocument(file, ext); return; }
      const ok = await addText(file);
      if (!ok) await addDocument(file, ext);
    }

    // Drag listeners
    function onDragEnter(e) {
      e.preventDefault();
      state.dragCounter++;
      if (opts.overlay) opts.overlay.classList.add('visible');
    }
    function onDragLeave(e) {
      e.preventDefault();
      state.dragCounter--;
      if (state.dragCounter <= 0) {
        state.dragCounter = 0;
        if (opts.overlay) opts.overlay.classList.remove('visible');
      }
    }
    function onDragOver(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    }
    function onDrop(e) {
      e.preventDefault();
      state.dragCounter = 0;
      if (opts.overlay) opts.overlay.classList.remove('visible');
      const files = e.dataTransfer.files;
      if (!files || files.length === 0) return;
      // Queue every dropped file (each resolves independently).
      for (let i = 0; i < files.length; i++) handleDroppedFile(files[i]);
    }

    opts.container.addEventListener('dragenter', onDragEnter);
    opts.container.addEventListener('dragleave', onDragLeave);
    opts.container.addEventListener('dragover', onDragOver);
    opts.container.addEventListener('drop', onDrop);

    return {
      // New array-first API
      getPendingList: () => state.pendingFiles.slice(),
      // Back-compat: first pending file (callers migrated to getPendingList)
      getPending: () => state.pendingFiles[0] || null,
      clear,
      handleFile: handleDroppedFile,
      destroy: () => {
        opts.container.removeEventListener('dragenter', onDragEnter);
        opts.container.removeEventListener('dragleave', onDragLeave);
        opts.container.removeEventListener('dragover', onDragOver);
        opts.container.removeEventListener('drop', onDrop);
        clear();
      },
    };
  }

  return {
    attach,
    embedInText,        // single-file back-compat
    embedAllInText,     // multi-file
    buildAttachmentMeta,   // single-file back-compat
    buildAttachmentMetas,  // multi-file
    MAX_SIZE,
  };
})();

if (typeof window !== 'undefined') window.ChatFileDrop = ChatFileDrop;
