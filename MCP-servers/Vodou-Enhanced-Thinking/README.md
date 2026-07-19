# Vodou-Enhanced-Thinking MCP Server

🧠 **Persistent thinking sessions with full context access for AI agents**

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![MCP Protocol](https://img.shields.io/badge/MCP-Protocol-blue)](https://modelcontextprotocol.io)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.0-blue)](https://www.typescriptlang.org/)

## Overview

Vodou-Enhanced-Thinking is an advanced MCP (Model Context Protocol) server that provides AI agents with persistent, context-aware thinking capabilities. Unlike basic sequential thinking tools, this server enables AI agents to:

- ✅ **Persist state** across multiple calls (no data loss between sessions)
- ✅ **Access full context** (previous thoughts always accessible)
- ✅ **Auto-connect to Vodou** for intelligent context enrichment
- ✅ **Analyze thinking quality** with gap detection and suggestions
- ✅ **Work standalone** or integrated with Vodou ecosystem
- ✅ **Support branching** and revision workflows

## Key Features

### 🧠 Persistent Thinking Sessions
All thinking data is stored in a dedicated SQLite database (`thinking.db`), allowing AI agents to:
- Resume thinking sessions across multiple tool calls
- Reference previous thoughts when adding new ones
- Maintain context throughout complex reasoning processes

### 🔗 Vodou Ecosystem Integration
Automatically enriches thinking data with Vodou context when available:
- Vodou session information (if linked via `oi_session_id`)
- Agent history and work logs (if `oi_agent_id` provided)
- Skill information and metadata
- Gracefully degrades to standalone mode if Vodou database unavailable

### 📊 Thinking Analysis
Built-in analysis engine provides:
- **Gap Detection**: Identifies missing considerations
- **Assumption Identification**: Highlights unstated assumptions
- **Quality Scoring**: Numerical assessment of thinking depth
- **Suggestions**: Actionable recommendations for improvement

### 🌳 Branching & Revision Support
Advanced features for complex reasoning:
- **Thought Revisions**: Mark thoughts as revisions of previous ones
- **Branching**: Create alternative thinking paths from any thought
- **Context Preservation**: Full history maintained for all branches

## Architecture

### Hybrid Database Design

The server uses a hybrid database approach for optimal flexibility:

- **`thinking.db`** - Primary database in MCP server directory
  - Stores all thinking sessions and thoughts
  - Portable (can move entire directory with all data)
  - Clean isolation from Vodou infrastructure

- **`vodou-core.db`** - Auto-connected read-only reference (when available)
  - Provides Vodou context enrichment
  - Read-only access prevents corruption
  - Optional (works without it)

### Benefits

- **Isolation**: Thinking data separate from Vodou infrastructure
- **Portability**: Move MCP server directory with all data intact
- **Context Enrichment**: Auto-enriches with Vodou data when available
- **Safety**: Read-only Vodou access, no risk of corruption
- **Flexibility**: Works standalone or integrated

## Installation

### Prerequisites

- Node.js 18+ and npm
- TypeScript 5.0+
- Vodou (optional, for context enrichment)
- **macOS**: If `npm install` fails with `gyp ERR!`, install Xcode Command Line Tools: `xcode-select --install`. The server uses `better-sqlite3` (native); prebuilds are used when available, otherwise it compiles from source.

### Quick Install

```bash
# 1. Navigate to MCP server directory
cd MCP-servers/Vodou-Enhanced-Thinking

# 2. Install dependencies
npm install

# 3. Build TypeScript
npm run build

# 4. Connect to Vodou (if using Vodou ecosystem)
cd ../..
./vodou-core connect Vodou-Enhanced-Thinking node -- "$(pwd)/MCP-servers/Vodou-Enhanced-Thinking/dist/index.js"
```

### Development Mode

```bash
# Watch mode for development
npm run dev

# Run server directly
npm start
```

## Tools Reference

### 1. `start_thinking_session`

Start a new thinking session with a topic.

**Parameters:**
- `topic` (required): What to think about (e.g., "database optimization", "API design")
- `estimated_steps` (optional): Estimated number of thinking steps (default: 5)
- `metadata` (optional): Additional context object (agent_id, skill, etc.)
- `oi_session_id` (optional): Link to Vodou-session-manager session
- `oi_agent_id` (optional): Link to agent/work log ID

**Returns:**
```json
{
  "session_id": "uuid-string",
  "topic": "database optimization",
  "status": "active",
  "estimated_steps": 6,
  "created_at": "2026-01-04T12:00:00Z"
}
```

### 2. `add_thought`

Add a thought to an existing session. Returns full context including previous thoughts and suggestions.

**Parameters:**
- `session_id` (required): Session ID from `start_thinking_session`
- `thought` (required): The current thinking step content
- `thoughtNumber` (required): Current thought number (1, 2, 3, ...)
- `totalThoughts` (required): Estimated total thoughts needed
- `nextThoughtNeeded` (required): Whether another thought step is needed
- `isRevision` (optional): Whether this revises previous thinking
- `revisesThought` (optional): Which thought number is being reconsidered
- `branchFromThought` (optional): Branching point thought number
- `branchId` (optional): Branch identifier
- `needsMoreThoughts` (optional): If more thoughts needed beyond initial estimate

**Returns:**
```json
{
  "session_id": "uuid-string",
  "thought_number": 1,
  "previous_thoughts": [...],
  "suggestions": ["Consider X", "Explore Y"],
  "context": {
    "oi_session": {...},
    "agent_history": [...]
  }
}
```

### 3. `get_thought_context`

Retrieve thought history for a session with optional Vodou context enrichment.

**Parameters:**
- `session_id` (required): Session ID to retrieve context for
- `from_thought` (optional): Start from thought number
- `to_thought` (optional): End at thought number
- `include_branches` (optional): Include branch thoughts (default: true)
- `include_oi_context` (optional): Include Vodou context (default: true)

**Returns:**
```json
{
  "session": {...},
  "thoughts": [...],
  "oi_context": {
    "oi_session": {...},
    "agent_history": [...]
  }
}
```

### 4. `analyze_thinking`

Analyze thinking quality and provide feedback.

**Parameters:**
- `session_id` (required): Session ID to analyze

**Returns:**
```json
{
  "totalThoughts": 6,
  "averageThoughtLength": 450,
  "revisions": 1,
  "branches": 0,
  "gaps": ["Missing consideration of X", "Y not explored"],
  "assumptions": ["Assumes Z without justification"],
  "suggestions": ["Consider exploring X", "Validate assumption Z"],
  "qualityScore": 0.75
}
```

### 5. `complete_thinking_session`

Mark a thinking session as complete.

**Parameters:**
- `session_id` (required): Session ID to complete
- `final_synthesis` (optional): Final summary/synthesis

**Returns:**
```json
{
  "session_id": "uuid-string",
  "status": "completed",
  "completed_at": "2026-01-04T12:30:00Z"
}
```

### 6. `list_thinking_sessions`

List thinking sessions with optional filtering.

**Parameters:**
- `status` (optional): Filter by status ('active', 'completed', 'paused')
- `limit` (optional): Maximum results (default: 10, max: 100)

**Returns:**
```json
{
  "sessions": [
    {
      "session_id": "uuid-string",
      "topic": "database optimization",
      "status": "active",
      "created_at": "2026-01-04T12:00:00Z",
      "last_thought_at": "2026-01-04T12:15:00Z"
    }
  ]
}
```

## Usage Examples

### Direct MCP Calls

```bash
# Start a thinking session
./vodou-core call Vodou-Enhanced-Thinking start_thinking_session '{
  "topic": "database optimization strategies",
  "estimated_steps": 6,
  "metadata": {"agent_id": "claude-1", "skill": "performance"}
}'

# Add first thought
./vodou-core call Vodou-Enhanced-Thinking add_thought '{
  "session_id": "abc123",
  "thought": "First, I need to understand the current database schema and query patterns...",
  "thoughtNumber": 1,
  "totalThoughts": 6,
  "nextThoughtNeeded": true
}'

# Get context (with previous thoughts)
./vodou-core call Vodou-Enhanced-Thinking get_thought_context '{
  "session_id": "abc123",
  "include_oi_context": true
}'

# Analyze thinking quality
./vodou-core call Vodou-Enhanced-Thinking analyze_thinking '{
  "session_id": "abc123"
}'

# Complete session
./vodou-core call Vodou-Enhanced-Thinking complete_thinking_session '{
  "session_id": "abc123",
  "final_synthesis": "Key findings: indexing strategy, query optimization, caching layer"
}'
```

### Natural Language (via Vodou)

```bash
# Start deep thinking session
oi "deep think about database optimization"

# Continue thinking (Vodou automatically tracks session)
oi "add thought: we should consider indexing strategies"

# Get context
oi "what have I thought about so far?"

# Analyze quality
oi "analyze my thinking process"
```

### Advanced: Branching & Revisions

```bash
# Add a revision to thought 3
./vodou-core call Vodou-Enhanced-Thinking add_thought '{
  "session_id": "abc123",
  "thought": "Actually, reconsidering approach from thought 3...",
  "thoughtNumber": 4,
  "totalThoughts": 6,
  "nextThoughtNeeded": true,
  "isRevision": true,
  "revisesThought": 3
}'

# Create a branch from thought 2
./vodou-core call Vodou-Enhanced-Thinking add_thought '{
  "session_id": "abc123",
  "thought": "Alternative approach: exploring option B...",
  "thoughtNumber": 5,
  "totalThoughts": 6,
  "nextThoughtNeeded": true,
  "branchFromThought": 2,
  "branchId": "alternative-approach"
}'
```

## Database Location

- **thinking.db**: `MCP-servers/Vodou-Enhanced-Thinking/thinking.db`
  - Stores all thinking sessions and thoughts
  - Portable with the MCP server directory
  - SQLite format for easy inspection

- **vodou-core.db**: Auto-detected from project root (read-only)
  - Used for Vodou context enrichment when available
  - Read-only access prevents corruption
  - Optional (server works without it)

## Features Deep Dive

### State Persistence

All thinking data persists in `thinking.db`, accessible across multiple `vodou-core` calls. This means:

- AI agents can start a thinking session, pause, and resume later
- Previous thoughts are always available for reference
- No data loss between tool invocations
- Full audit trail of thinking process

### Context Enrichment

Automatically enriches thinking data with Vodou context:

- **Vodou Session Information**: If `oi_session_id` provided, includes session metadata
- **Agent History**: If `oi_agent_id` provided, includes relevant work logs
- **Skill Information**: Links to Vodou skills if applicable
- **Metadata**: Custom metadata preserved throughout session

### Thinking Analysis

Built-in analysis engine evaluates thinking quality:

- **Gap Detection**: Identifies missing considerations or unexplored areas
- **Assumption Identification**: Highlights unstated assumptions
- **Quality Scoring**: Numerical score (0.0-1.0) based on depth and completeness
- **Suggestions**: Actionable recommendations for improvement

### Standalone Mode

Works even if Vodou database is not available:

- Gracefully degrades to standalone mode
- All core functionality available
- Vodou context enrichment simply omitted
- Perfect for non-Vodou environments

## Integration with Vodou Ecosystem

### Vodou Intent Mappings

The server includes natural language intent mappings:

- `"deep think"` → `start_thinking_session`
- `"think deep"` → `start_thinking_session`
- `"deep research"` → `start_thinking_session`
- `"analyze deeply"` → `start_thinking_session`
- `"comprehensive analysis"` → `start_thinking_session`

### Parameter Extractors

Automatic parameter extraction from natural language:

- Topic extraction from query
- Step count detection ("in 5 steps")
- Session tracking for follow-up commands
- Context-aware defaults

### Vodou Skills Integration

Works seamlessly with Vodou skills:

- `deep-thinking` skill provides expert workflows
- Automatic session linking
- Context sharing between skills
- Work log integration

## Development

### Project Structure

```
Vodou-Enhanced-Thinking/
├── src/
│   ├── index.ts           # MCP server entry point
│   ├── thinking-server.ts # Core thinking logic
│   ├── database.ts        # Database operations
│   ├── analysis.ts        # Thinking analysis engine
│   └── types.ts           # TypeScript interfaces
├── dist/                  # Compiled JavaScript
├── thinking.db            # SQLite database (created on first use)
├── package.json
├── tsconfig.json
├── vodou-manifest.json    # Vodou integration manifest
└── README.md
```

### Building

```bash
# Development build (watch mode)
npm run dev

# Production build
npm run build

# Run server
npm start
```

### Database Schema

The `thinking.db` database contains:

- **thinking_sessions**: Session metadata
- **thoughts**: Individual thoughts with relationships
- **branches**: Branch tracking for alternative paths

## API Reference

### TypeScript Interfaces

```typescript
interface ThinkingSession {
  session_id: string;
  topic: string;
  status: 'active' | 'completed' | 'paused';
  created_at: string;
  last_thought_at: string;
  completed_at?: string;
  metadata?: string;
  oi_session_id?: string;
  oi_agent_id?: string;
}

interface ThoughtData {
  thought: string;
  thoughtNumber: number;
  totalThoughts: number;
  isRevision?: boolean;
  revisesThought?: number;
  branchFromThought?: number;
  branchId?: string;
  needsMoreThoughts?: boolean;
  nextThoughtNeeded: boolean;
}

interface ThinkingAnalysis {
  totalThoughts: number;
  averageThoughtLength: number;
  revisions: number;
  branches: number;
  gaps: string[];
  assumptions: string[];
  suggestions: string[];
  qualityScore: number;
}
```

## Troubleshooting

### Database Issues

**Problem**: `thinking.db` not found or corrupted

**Solution**: 
- Database is created automatically on first use
- If corrupted, delete `thinking.db` and restart (data will be lost)
- Check file permissions in MCP server directory

### Vodou Context Not Available

**Problem**: Vodou context enrichment not working

**Solution**:
- Verify `vodou-core.db` exists in project root
- Check file permissions (read-only access required)
- Server works fine without Vodou context (standalone mode)

### Session Not Found

**Problem**: `session_id` not found error

**Solution**:
- Verify session was created with `start_thinking_session`
- Check session status with `list_thinking_sessions`
- Ensure using correct `session_id` from response

## Contributing

Contributions welcome! Please:

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## License

MIT License - see LICENSE file for details

## Support

- **Documentation**: See this README
- **Issues**: Report on GitHub
- **Vodou Integration**: See `vodou-manifest.json` (legacy `oi-manifest.json` also accepted) for integration details

## Related Projects

- **OI-Sequential-Thinking**: Basic sequential thinking (no persistence)
- **Vodou**: Intelligence Orchestration platform
- **MCP Protocol**: Model Context Protocol specification

---

**Built with ❤️ by Vodou**
