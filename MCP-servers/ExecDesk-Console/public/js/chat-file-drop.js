/**
 * ChatFileDrop — reusable drag-and-drop file handling for chat composers.
 * Extracted from ChatView (main chat) so the scoped workbench can opt-in
 * to the same upload/preview/embed behavior by just passing its own
 * container + overlay + preview-area elements.
 *
 * Files aren't sent as a separate WS field — they're embedded into the
 * text payload (see `embedInText()`). That means server side needs no
 * changes to accept workbench file drops.
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
 *   const pending = fd.getPending();
 *   const embedded = ChatFileDrop.embedInText(pending, userText);
 *   fd.clear();
 */
const ChatFileDrop = (() => {
  const MAX_SIZE = 10 * 1024 * 1024; // 10MB

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
    return '.' + (name || '').split('.').pop().toLowerCase();
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

  function sizeStr(size) {
    if (size < 1024) return size + 'B';
    if (size < 1024 * 1024) return (size / 1024).toFixed(1) + 'KB';
    return (size / 1024 / 1024).toFixed(1) + 'MB';
  }

  /**
   * Embed a pending file into the user's text as a message payload.
   * Mirrors the logic previously in `ChatView.sendMessage` so main chat
   * and workbench produce the same server-bound text.
   */
  function embedInText(file, userText) {
    if (!file) return userText;
    const userQuery = (userText || '').trim() || 'Analyze this file';
    if (file.type === 'text') {
      const truncNote = file.truncated ? '\n[File truncated to first 50,000 characters]' : '';
      return userQuery + '\n\n<file name="' + file.name + '">\n' + file.content + truncNote + '\n</file>';
    }
    if (file.type === 'image') {
      const pathNote = file.path ? ' saved at ' + file.path : '';
      return userQuery + '\n\n[User dropped image: ' + file.name + pathNote + ']';
    }
    if (file.type === 'document') {
      const pathNote = file.path ? ' saved at ' + file.path : '';
      const label = file.docType || 'document';
      return userQuery + '\n\n[User dropped ' + label + ': ' + file.name + pathNote + ']';
    }
    return userQuery;
  }

  function attach(opts) {
    if (!opts || !opts.container || !opts.input) {
      throw new Error('ChatFileDrop.attach: opts.container + opts.input required');
    }

    const state = {
      pendingFile: null,
      dragCounter: 0,
    };

    const originalPlaceholder = opts.placeholder || opts.input.placeholder || '';
    const toast = opts.toast || (() => {});
    const systemMessage = opts.systemMessage || (() => {});
    const getFileWarning = opts.getFileWarning || (() => null);
    const onFileReady = opts.onFileReady || (() => {});
    const onInlineImage = opts.onInlineImage || (() => {});

    function renderPreview(name, size, type) {
      if (!opts.previewArea) return;
      const icon = type === 'image' ? '\uD83D\uDDBC' : '\uD83D\uDCC4';
      opts.previewArea.innerHTML = '<div class="file-preview">' +
        '<span>' + icon + '</span>' +
        '<span class="file-preview-name">' + name + '</span>' +
        '<span class="file-preview-size">(' + sizeStr(size) + ')</span>' +
        '<span class="file-preview-remove">&times;</span>' +
        '</div>';
      opts.previewArea.classList.remove('is-hidden');
      const removeBtn = opts.previewArea.querySelector('.file-preview-remove');
      if (removeBtn) removeBtn.addEventListener('click', clear);
    }

    function clear() {
      state.pendingFile = null;
      if (opts.previewArea) {
        opts.previewArea.innerHTML = '';
        opts.previewArea.classList.add('is-hidden');
      }
      opts.input.placeholder = originalPlaceholder;
    }

    function handleDroppedFile(file) {
      if (file.size > MAX_SIZE) {
        systemMessage('File too large (max 10MB). Got ' + (file.size / 1024 / 1024).toFixed(1) + 'MB.');
        return;
      }
      const ext = fileExtension(file.name);

      // Images
      if (file.type.startsWith('image/')) {
        const warn = getFileWarning('image');
        if (warn) toast(warn, 'warning');
        const reader = new FileReader();
        reader.onload = async (e) => {
          const dataUri = e.target.result;
          try {
            const res = await fetch('/api/files/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, data: dataUri }),
            });
            const result = await res.json();
            if (result.path) {
              renderPreview(file.name, file.size, 'image');
              state.pendingFile = { name: file.name, type: 'image', path: result.path, size: file.size };
              onInlineImage(result.path);
              opts.input.placeholder = 'Ask about this image, or press Enter to analyze...';
              opts.input.focus();
              onFileReady(state.pendingFile);
            }
          } catch {
            renderPreview(file.name, file.size, 'image');
            state.pendingFile = { name: file.name, type: 'image', path: null, size: file.size };
            opts.input.placeholder = 'Ask about this image...';
            opts.input.focus();
            onFileReady(state.pendingFile);
          }
        };
        reader.readAsDataURL(file);
        return;
      }

      // Documents / binary
      if (isDocumentFile(file, ext)) {
        const docCat = ext === '.pdf' ? 'pdf'
          : ext.match(/\.(mp3|wav|m4a|ogg|flac)/) ? 'audio'
          : ext.match(/\.(mp4|mov|webm)/) ? 'video'
          : 'document';
        const warn = getFileWarning(docCat);
        if (warn) toast(warn, 'warning');
        const reader = new FileReader();
        reader.onload = async (e) => {
          const dataUri = e.target.result;
          try {
            const res = await fetch('/api/files/upload', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: file.name, data: dataUri }),
            });
            const result = await res.json();
            if (result.path) {
              const docType = ext === '.pdf' ? 'pdf'
                : ext.match(/\.(docx?|xlsx?|pptx?|odt|ods|odp|rtf)/) ? 'document'
                : ext.match(/\.(mp3|wav|m4a|ogg|flac)/) ? 'audio'
                : ext.match(/\.(mp4|mov|webm)/) ? 'video'
                : 'file';
              renderPreview(file.name, file.size, docType);
              state.pendingFile = {
                name: file.name, type: 'document', path: result.path,
                size: file.size, docType,
              };
              opts.input.placeholder = 'Ask about this file, or press Enter to analyze...';
              opts.input.focus();
              onFileReady(state.pendingFile);
            }
          } catch {
            renderPreview(file.name, file.size, 'file');
            state.pendingFile = { name: file.name, type: 'document', path: null, size: file.size };
            opts.input.placeholder = 'Ask about this file...';
            opts.input.focus();
            onFileReady(state.pendingFile);
          }
        };
        reader.readAsDataURL(file);
        return;
      }

      // Text / code
      if (isTextFile(file, ext)) {
        const reader = new FileReader();
        reader.onload = (e) => {
          let content = e.target.result;
          const MAX_CHARS = 50000;
          let truncated = false;
          if (content.length > MAX_CHARS) {
            content = content.substring(0, MAX_CHARS);
            truncated = true;
          }
          renderPreview(file.name, file.size, 'text');
          state.pendingFile = {
            name: file.name, type: 'text', content, truncated, size: file.size,
          };
          opts.input.placeholder = 'Ask about this file, or press Enter to analyze...';
          opts.input.focus();
          onFileReady(state.pendingFile);
        };
        reader.readAsText(file);
        return;
      }

      systemMessage('Unsupported file type: ' + (file.type || ext) + ' (' + file.name + '). Supported: text, code, images, PDF, Office docs, audio, video.');
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
      if (files.length === 0) return;
      handleDroppedFile(files[0]);
    }

    opts.container.addEventListener('dragenter', onDragEnter);
    opts.container.addEventListener('dragleave', onDragLeave);
    opts.container.addEventListener('dragover', onDragOver);
    opts.container.addEventListener('drop', onDrop);

    return {
      getPending: () => state.pendingFile,
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

  return { attach, embedInText, MAX_SIZE };
})();

if (typeof window !== 'undefined') window.ChatFileDrop = ChatFileDrop;
