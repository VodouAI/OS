#!/bin/bash
# Build vodou-ax for arm64 + x86_64 and copy to bin/
set -e

cd "$(dirname "$0")"

echo "Building vodou-ax for arm64..."
swift build -c release --arch arm64

echo "Building vodou-ax for x86_64..."
swift build -c release --arch x86_64

mkdir -p ../bin

cp .build/arm64-apple-macosx/release/vodou-ax ../bin/vodou-ax-arm64
cp .build/x86_64-apple-macosx/release/vodou-ax ../bin/vodou-ax-x86_64

chmod +x ../bin/vodou-ax-arm64 ../bin/vodou-ax-x86_64

echo ""
echo "Built vodou-ax for both architectures:"
file ../bin/vodou-ax-arm64
file ../bin/vodou-ax-x86_64
