#!/usr/bin/env python3
"""
PTY helper — allocates a real pseudo-terminal via pty.fork().

Protocol:
  - PTY output → stdout (raw bytes)
  - stdin → PTY input (raw bytes)
  - fd 3 → resize commands: {"resize": [cols, rows]}
  - stderr → exit notification: {"exit": code}
"""

import pty
import os
import sys
import select
import signal
import json
import struct
import fcntl
import termios

def resize_pty(fd, cols, rows):
    winsize = struct.pack('HHHH', rows, cols, 0, 0)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, winsize)

def main():
    shell = os.environ.get('SHELL', '/bin/zsh')
    cwd = os.environ.get('PTY_CWD', os.path.expanduser('~'))
    cols = int(os.environ.get('PTY_COLS', '80'))
    rows = int(os.environ.get('PTY_ROWS', '24'))

    # Use openpty + fork manually so we can set size BEFORE the child runs
    master_fd, slave_fd = os.openpty()

    # Set terminal size on the master BEFORE fork
    resize_pty(master_fd, cols, rows)

    pid = os.fork()

    if pid == 0:
        # Child — become the shell
        os.close(master_fd)
        os.setsid()

        # Set the slave as the controlling terminal
        fcntl.ioctl(slave_fd, termios.TIOCSCTTY, 0)

        # Redirect stdin/stdout/stderr to slave PTY
        os.dup2(slave_fd, 0)
        os.dup2(slave_fd, 1)
        os.dup2(slave_fd, 2)
        if slave_fd > 2:
            os.close(slave_fd)

        os.chdir(cwd)
        os.environ['TERM'] = 'xterm-256color'
        os.environ['COLORTERM'] = 'truecolor'
        os.environ['COLUMNS'] = str(cols)
        os.environ['LINES'] = str(rows)

        # Strip env vars that cause CLI tools to think they're nested
        for var in [
            'CLAUDECODE', 'CLAUDE_CODE', 'CLAUDE_SESSION',
            'CLAUDE_CONVERSATION_ID', 'CLAUDE_CODE_ENTRYPOINT',
            'PTY_CWD', 'PTY_COLS', 'PTY_ROWS',
        ]:
            os.environ.pop(var, None)

        os.execlp(shell, shell)
    else:
        # Parent — relay I/O
        os.close(slave_fd)
        fd = master_fd

        # Set non-blocking on PTY master and stdin
        for f in [fd, 0]:
            flags = fcntl.fcntl(f, fcntl.F_GETFL)
            fcntl.fcntl(f, fcntl.F_SETFL, flags | os.O_NONBLOCK)

        # Resize pipe (fd 3 from Node)
        resize_fd = None
        try:
            os.fstat(3)
            resize_fd = 3
            flags = fcntl.fcntl(3, fcntl.F_GETFL)
            fcntl.fcntl(3, fcntl.F_SETFL, flags | os.O_NONBLOCK)
        except:
            pass

        running = True
        def on_sigchld(sig, frame):
            nonlocal running
            running = False
        signal.signal(signal.SIGCHLD, on_sigchld)

        try:
            while running:
                read_fds = [fd, 0]
                if resize_fd is not None:
                    read_fds.append(resize_fd)

                try:
                    r, _, _ = select.select(read_fds, [], [], 0.01)
                except (InterruptedError, ValueError):
                    continue

                if fd in r:
                    try:
                        data = os.read(fd, 65536)
                        if not data:
                            break
                        os.write(1, data)
                    except OSError:
                        break

                if 0 in r:
                    try:
                        data = os.read(0, 65536)
                        if not data:
                            break
                        os.write(fd, data)
                    except OSError:
                        break

                if resize_fd is not None and resize_fd in r:
                    try:
                        line = os.read(resize_fd, 1024).decode()
                        for part in line.strip().split('\n'):
                            msg = json.loads(part)
                            if 'resize' in msg:
                                c, ro = msg['resize']
                                resize_pty(fd, c, ro)
                    except:
                        pass

        finally:
            try:
                os.close(fd)
            except:
                pass
            try:
                _, status = os.waitpid(pid, os.WNOHANG)
                exit_code = os.WEXITSTATUS(status) if os.WIFEXITED(status) else 1
            except:
                exit_code = 0
            sys.stderr.write(json.dumps({"exit": exit_code}) + '\n')
            sys.stderr.flush()

if __name__ == '__main__':
    main()
