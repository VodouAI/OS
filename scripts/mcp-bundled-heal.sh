#!/bin/bash
# Keep bundled MCP server DB paths valid for the current install directory.
# Sourced by start-vodou-services.sh (and install-prebuilt.sh on upgrade).

if ! declare -F dbg >/dev/null 2>&1; then
    dbg() { [ "${DEBUG:-0}" = "1" ] && echo "  [DEBUG] $*" || true; }
fi

mcp_bundled_node_cmd() {
    local bundled="${VODOU_DIR:?}/.node/node"
    if [ -x "$bundled" ]; then
        echo "./.node/node"
    elif command -v node &>/dev/null; then
        echo "node"
    else
        return 1
    fi
}

mcp_resolve_install_path() {
    local p="$1"
    case "$p" in
        /*) echo "$p" ;;
        ./*) echo "$VODOU_DIR/${p#./}" ;;
        *) echo "$VODOU_DIR/$p" ;;
    esac
}

# True when a registered server points at missing files or dev/test paths.
mcp_bundled_registration_stale() {
    local name="$1"
    local expected_rel="$2"

    [ "${HAS_SQLITE3:-0}" = "1" ] || return 1
    [ -f "${VODOU_DIR}/vodou-core.db" ] || return 0

    local row command args_json first_arg
    row=$(sqlite3 "${VODOU_DIR}/vodou-core.db" \
        "SELECT command || '|' || args FROM mcp_servers WHERE name='$name' AND (active IS NULL OR active = 1) LIMIT 1;" 2>/dev/null) || return 0
    [ -z "$row" ] && return 0

    command="${row%%|*}"
    args_json="${row#*|}"

    case "$command" in
        /tmp/*) return 0 ;;
    esac
    [[ "$args_json" == *"/tmp/"* ]] && return 0

    case "$command" in
        /*)
            case "$command" in "$VODOU_DIR"/*) ;; *) return 0 ;; esac
            ;;
    esac

    first_arg=$(printf '%s' "$args_json" | sed -n 's/^\["\([^"]*\)".*/\1/p')
    [ -z "$first_arg" ] && return 0

    case "$first_arg" in
        /*)
            case "$first_arg" in "$VODOU_DIR"/*) ;; *) return 0 ;; esac
            ;;
    esac

    if [ -n "$expected_rel" ]; then
        local norm_expected norm_actual
        norm_expected=$(echo "$expected_rel" | sed 's|^\./||')
        norm_actual=$(echo "$first_arg" | sed 's|^\./||')
        [ "$norm_actual" != "$norm_expected" ] && return 0
    fi

    if [ "$command" != "node" ] && [ "$command" != "./.node/node" ]; then
        local resolved_cmd
        resolved_cmd=$(mcp_resolve_install_path "$command")
        [ -f "$resolved_cmd" ] || [ -x "$resolved_cmd" ] || return 0
    fi

    local resolved_script
    resolved_script=$(mcp_resolve_install_path "$first_arg")
    [ -f "$resolved_script" ] || return 0

    return 1
}

ensure_bundled_mcp_server() {
    local name="$1"
    local rel_dist="$2"
    local server_dir
    server_dir="$(dirname "$(dirname "$rel_dist")")"

    [ -d "$VODOU_DIR/$server_dir" ] || return 0

    dbg "=== $name ==="
    echo "?? Checking $name connection..."

    if [ ! -f "$VODOU_DIR/vodou-core.db" ]; then
        echo "   ??  Database not initialized yet. $name will be connected on first Vodou command."
        return 0
    fi

    local connected
    connected=$(sqlite3 "$VODOU_DIR/vodou-core.db" "SELECT COUNT(*) FROM mcp_servers WHERE name='$name';" 2>/dev/null || echo "0")

    if [ "$connected" != "0" ] && ! mcp_bundled_registration_stale "$name" "$rel_dist"; then
        echo "   ? $name already connected"
        return 0
    fi

    if [ "$connected" != "0" ]; then
        echo "   ?? $name registration stale � reconnecting..."
    else
        echo "   ?? Connecting $name to Vodou..."
    fi

    local node_cmd
    node_cmd=$(mcp_bundled_node_cmd) || {
        echo "   ??  Node.js not found. $name requires Node.js"
        return 1
    }

    if [ ! -f "$VODOU_DIR/$rel_dist" ]; then
        if [ ! -d "$VODOU_DIR/$server_dir/node_modules" ]; then
            echo "   ??  $name dependencies missing (node_modules not found)"
            echo "      Run: cd $server_dir && npm install && npm run build"
        else
            echo "   ??  $name not built ($rel_dist missing)"
            echo "      Run: cd $server_dir && npm run build"
        fi
        return 1
    fi

    if [ ! -d "$VODOU_DIR/$server_dir/node_modules" ]; then
        echo "   ??  $name dependencies missing (node_modules not found)"
        echo "      Run: cd $server_dir && npm install"
        return 1
    fi

    cd "$VODOU_DIR" || return 1
    if run_vc connect "$name" "$node_cmd" "$rel_dist" > /dev/null 2>&1; then
        echo "   ? $name connected successfully"
        return 0
    fi

    echo "   ??  Failed to connect $name (may need manual connection)"
    echo "      Run: ./vodou-core connect $name $node_cmd $rel_dist"
    return 1
}
