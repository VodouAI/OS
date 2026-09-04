/**
 * Terminal View — Embedded interactive terminal via xterm.js
 * Runs any CLI tool: claude, kimi, ollama, python, etc.
 */

const TerminalView = {
  term: null,
  fitAddon: null,
  started: false,
  container: null,

  render(el) {
    // If terminal already exists, re-attach and focus
    if (this.term && this.container) {
      el.innerHTML = '';
      const header = Components.pageHeader('Terminal', 'Run any CLI — claude, kimi, ollama, python, or any command');
      const toolbar = document.createElement('div');
      toolbar.className = 'terminal-toolbar';
      const restartBtn = document.createElement('button');
      restartBtn.className = 'btn btn-sm';
      restartBtn.textContent = 'Restart';
      restartBtn.addEventListener('click', () => this.restart());
      const clearBtn = document.createElement('button');
      clearBtn.className = 'btn btn-sm';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => { if (this.term) this.term.clear(); });
      const shellInfo = document.createElement('span');
      shellInfo.className = 'secondary-text';
      shellInfo.id = 'terminal-shell-info';
      shellInfo.textContent = this.started ? 'Connected' : 'Exited';
      toolbar.appendChild(restartBtn);
      toolbar.appendChild(clearBtn);
      toolbar.appendChild(shellInfo);
      const termWrapper = document.createElement('div');
      termWrapper.id = 'terminal-wrapper';
      termWrapper.className = 'terminal-wrapper-shell';
      el.appendChild(header);
      el.appendChild(toolbar);
      el.appendChild(termWrapper);
      this.container = termWrapper;
      this.term.open(termWrapper);
      setTimeout(() => {
        try { this.fitAddon.fit(); } catch(e) {}
        this.term.focus();
      }, 50);
      return;
    }

    el.innerHTML = '';

    // Header
    const header = Components.pageHeader('Terminal', 'Run any CLI — claude, kimi, ollama, python, or any command');

    // Toolbar
    const toolbar = document.createElement('div');
    toolbar.className = 'terminal-toolbar';

    const restartBtn = document.createElement('button');
    restartBtn.className = 'btn btn-sm';
    restartBtn.textContent = 'Restart';
    restartBtn.addEventListener('click', () => this.restart());

    const clearBtn = document.createElement('button');
    clearBtn.className = 'btn btn-sm';
    clearBtn.textContent = 'Clear';
    clearBtn.addEventListener('click', () => {
      if (this.term) this.term.clear();
    });

    const shellInfo = document.createElement('span');
    shellInfo.className = 'secondary-text';
    shellInfo.id = 'terminal-shell-info';
    shellInfo.textContent = 'Starting...';

    toolbar.appendChild(restartBtn);
    toolbar.appendChild(clearBtn);
    toolbar.appendChild(shellInfo);

    // Terminal container
    const termWrapper = document.createElement('div');
    termWrapper.id = 'terminal-wrapper';
    termWrapper.className = 'terminal-wrapper-shell';

    el.appendChild(header);
    el.appendChild(toolbar);
    el.appendChild(termWrapper);

    this.container = termWrapper;
    this._initTerminal(termWrapper);
  },

  async _initTerminal(container) {
    // Load xterm CSS and wait for it before opening terminal
    if (!document.getElementById('xterm-css')) {
      await new Promise((resolve) => {
        const link = document.createElement('link');
        link.id = 'xterm-css';
        link.rel = 'stylesheet';
        link.href = '/node_modules/@xterm/xterm/css/xterm.css';
        link.onload = resolve;
        link.onerror = resolve; // proceed even if CSS fails
        document.head.appendChild(link);
      });
    }

    // Dynamically import xterm modules
    const { Terminal } = await import('/node_modules/@xterm/xterm/lib/xterm.mjs');
    const { FitAddon } = await import('/node_modules/@xterm/addon-fit/lib/addon-fit.mjs');

    // Create terminal instance
    this.term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      cursorWidth: 2,
      cursorInactiveStyle: 'bar',
      fontSize: 14,
      fontFamily: "'SF Mono', Consolas, 'Liberation Mono', Menlo, monospace",
      theme: {
        background: '#1e1e1e',
        foreground: '#d4d4d4',
        cursor: '#ffffff',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#d7ba7d',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#d7ba7d',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff',
      },
      allowProposedApi: true,
    });

    this.fitAddon = new FitAddon();
    this.term.loadAddon(this.fitAddon);
    this.term.open(container);

    // Fit to container and focus so cursor is visible
    // Multiple attempts to ensure focus sticks after all rendering completes
    const focusTerminal = () => {
      try { this.fitAddon.fit(); } catch(e) {}
      this.term.focus();
    };
    setTimeout(focusTerminal, 50);
    setTimeout(focusTerminal, 200);
    setTimeout(focusTerminal, 500);

    // Handle resize
    this._resizeObserver = new ResizeObserver(() => {
      if (this.fitAddon && this.term) {
        try { this.fitAddon.fit(); } catch(e) {}
      }
    });
    this._resizeObserver.observe(container);

    // Send resize events to backend
    this.term.onResize(({ cols, rows }) => {
      if (ChatView.ws && ChatView.ws.readyState === WebSocket.OPEN) {
        ChatView.ws.send(JSON.stringify({
          type: 'terminal_resize',
          cols, rows
        }));
      }
    });

    // Terminal input → WebSocket → PTY
    this.term.onData((data) => {
      if (ChatView.ws && ChatView.ws.readyState === WebSocket.OPEN) {
        ChatView.ws.send(JSON.stringify({
          type: 'terminal_input',
          data
        }));
      }
    });

    // Focus terminal on click anywhere in container
    container.addEventListener('click', () => {
      if (this.term) this.term.focus();
    });

    // Start the PTY session
    this._startPty();

    const info = document.getElementById('terminal-shell-info');
    if (info) info.textContent = 'Connected';
  },

  /**
   * Ask the backend to spawn a PTY with the actual terminal dimensions
   */
  _startPty() {
    const sendStart = () => {
      // Get actual dimensions from xterm after fit
      let cols = 80, rows = 24;
      if (this.term) {
        cols = this.term.cols;
        rows = this.term.rows;
      }
      ChatView.ws.send(JSON.stringify({ type: 'terminal_start', cols, rows }));
      this.started = true;
      // Auto-run a handed-off command once the PTY is up (e.g. the chat
      // "Reconnect" banner hands us `claude` so the user just types /login).
      let autoRun = null;
      try { autoRun = sessionStorage.getItem('vodou.terminalAutoRun'); sessionStorage.removeItem('vodou.terminalAutoRun'); } catch (_) {}
      if (autoRun && ChatView.ws) {
        setTimeout(() => {
          if (ChatView.ws && ChatView.ws.readyState === WebSocket.OPEN) {
            ChatView.ws.send(JSON.stringify({ type: 'terminal_input', data: autoRun + '\r' }));
            if (this.term) this.term.writeln('\r\n\x1b[36m▶ Running "' + autoRun + '" — once it loads, type /login to sign in.\x1b[0m');
          }
        }, 1200);
      }
    };

    if (ChatView.ws && ChatView.ws.readyState === WebSocket.OPEN) {
      // Delay slightly to ensure fit has happened
      setTimeout(sendStart, 100);
    } else {
      const check = setInterval(() => {
        if (ChatView.ws && ChatView.ws.readyState === WebSocket.OPEN) {
          clearInterval(check);
          setTimeout(sendStart, 100);
        }
      }, 200);
    }
  },

  /**
   * Handle terminal output from WebSocket
   */
  handleOutput(data) {
    if (this.term) {
      this.term.write(data);
    }
  },

  /**
   * Handle terminal exit
   */
  handleExit(exitCode) {
    if (this.term) {
      this.term.writeln(`\r\n\x1b[33m[Process exited with code ${exitCode}. Press Restart to start a new session.]\x1b[0m`);
    }
    this.started = false;
    const info = document.getElementById('terminal-shell-info');
    if (info) info.textContent = 'Exited';
  },

  /**
   * Restart the terminal session
   */
  restart() {
    if (this.term) {
      this.term.clear();
      this.term.reset();
    }
    this._startPty();
    const info = document.getElementById('terminal-shell-info');
    if (info) info.textContent = 'Connected';
  },

  /**
   * Cleanup on view switch
   */
  destroy() {
    if (this._resizeObserver) {
      this._resizeObserver.disconnect();
      this._resizeObserver = null;
    }
    // Don't destroy the PTY — keep it alive in the background
    // User can come back to the terminal tab and continue where they left off
  }
};
