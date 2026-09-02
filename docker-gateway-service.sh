#!/bin/bash

# P4 — this entrypoint declares its stack (stacks.toml). Read by
# `vodou-core stacks`, the exec-world seam, and the receipt, so a lane
# that is off in this composition renders `off (stack)` rather than
# absent — indistinguishable from a lane that failed.
export VODOU_STACK="${VODOU_STACK:-docker}"

# Background Docker Gateway Service
# This keeps Docker servers running between commands

GATEWAY_PID_FILE="/tmp/docker-gateway.pid"
GATEWAY_LOG_FILE="/tmp/docker-gateway.log"

# Check if Docker is installed
check_docker_installed() {
    if ! command -v docker &> /dev/null; then
        return 1
    fi
    return 0
}

# Check if Docker Desktop is running
check_docker_desktop() {
    # First check if Docker is installed
    if ! check_docker_installed; then
        echo "❌ Docker is not installed"
        echo "   💡 Install Docker Desktop from: https://www.docker.com/products/docker-desktop/"
        return 1
    fi
    
    if ! docker info > /dev/null 2>&1; then
        echo "🐳 Docker Desktop not running, attempting to start..."
        open -a Docker
        
        # Wait for Docker to start (max 60 seconds)
        echo "⏳ Waiting for Docker Desktop to start..."
        for i in {1..60}; do
            if docker info > /dev/null 2>&1; then
                echo "✅ Docker Desktop is now running"
                return 0
            fi
            sleep 1
            echo -n "."
        done
        echo ""
        echo "❌ Docker Desktop failed to start within 60 seconds"
        return 1
    else
        echo "✅ Docker Desktop is running"
        return 0
    fi
}

start_gateway() {
    # Check if Docker is installed first
    if ! check_docker_installed; then
        echo "❌ Cannot start Docker Gateway - Docker is not installed"
        echo "   💡 Install Docker Desktop from: https://www.docker.com/products/docker-desktop/"
        return 1
    fi
    
    # Check if Docker Desktop is running
    if ! check_docker_desktop; then
        echo "❌ Cannot start Docker Gateway without Docker Desktop running"
        return 1
    fi

    if [ -f "$GATEWAY_PID_FILE" ]; then
        PID=$(cat "$GATEWAY_PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "✅ Docker Gateway already running (PID: $PID)"
            return 0
        else
            echo "🧹 Cleaning up stale PID file"
            rm -f "$GATEWAY_PID_FILE"
        fi
    fi

    echo "🚀 Starting Docker Gateway service..."
    nohup docker mcp gateway run > "$GATEWAY_LOG_FILE" 2>&1 &
    PID=$!
    echo $PID > "$GATEWAY_PID_FILE"
    echo "✅ Docker Gateway started (PID: $PID)"
    echo "📋 Logs: $GATEWAY_LOG_FILE"
}

stop_gateway() {
    if [ -f "$GATEWAY_PID_FILE" ]; then
        PID=$(cat "$GATEWAY_PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "🛑 Stopping Docker Gateway (PID: $PID)..."
            kill $PID
            rm -f "$GATEWAY_PID_FILE"
            echo "✅ Docker Gateway stopped"
        else
            echo "⚠️ Docker Gateway not running"
            rm -f "$GATEWAY_PID_FILE"
        fi
    else
        echo "⚠️ Docker Gateway not running"
    fi
}

status_gateway() {
    if [ -f "$GATEWAY_PID_FILE" ]; then
        PID=$(cat "$GATEWAY_PID_FILE")
        if ps -p $PID > /dev/null 2>&1; then
            echo "✅ Docker Gateway running (PID: $PID)"
            echo "📋 Logs: $GATEWAY_LOG_FILE"
        else
            echo "❌ Docker Gateway not running (stale PID file)"
            rm -f "$GATEWAY_PID_FILE"
        fi
    else
        echo "❌ Docker Gateway not running"
    fi
}

case "$1" in
    start)
        start_gateway
        ;;
    stop)
        stop_gateway
        ;;
    restart)
        stop_gateway
        sleep 2
        start_gateway
        ;;
    check-docker)
        check_docker_desktop
        ;;
    status)
        status_gateway
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|check-docker}"
        echo ""
        echo "KISS Docker Gateway Service"
        echo "Keeps Docker servers running between commands"
        echo ""
        echo "Commands:"
        echo "  start        - Start the Docker Gateway service (auto-starts Docker Desktop if needed)"
        echo "  stop         - Stop the Docker Gateway service"
        echo "  restart      - Restart the Docker Gateway service"
        echo "  status       - Check if the service is running"
        echo "  check-docker - Check if Docker Desktop is running (auto-starts if needed)"
        exit 1
        ;;
esac
