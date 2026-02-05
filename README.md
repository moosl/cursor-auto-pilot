# CursorPilot

AI-powered orchestration system for Cursor Agent. Let AI automatically manage and interact with Cursor to complete complex development tasks.

## Core Concept

CursorPilot provides two interaction modes:

1. **Direct Chat** - Talk directly with Cursor Agent for simple tasks
2. **AI Orchestrator** - Let AI break down complex tasks and manage multiple Cursor conversations

## Setup

```bash
# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env and add your ANTHROPIC_API_KEY

# Start dev server
pnpm dev
```

Visit http://localhost:3000

## Environment Variables

| Variable | Description |
|----------|-------------|
| `ANTHROPIC_API_KEY` | Anthropic API key (required for Orchestrator) |
| `ANTHROPIC_BASE_URL` | Optional proxy URL (e.g., one-api, DeepSeek) |
| `ANTHROPIC_MODEL` | Model override (default: claude-sonnet-4-20250514) |
| `TELEGRAM_BOT_TOKEN` | Telegram Bot Token (optional, for Telegram integration) |
| `TELEGRAM_ALLOWED_CHAT_IDS` | Comma-separated Telegram chat IDs allowed to use the bot |

## Telegram Bot Integration

CursorPiolt supports Telegram bot integration, allowing you to interact with the Orchestrator Agent directly from Telegram.

### Step 1: Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Send `/newbot` and follow the prompts to create your bot
3. Save the bot token (format: `123456789:ABCdefGHIjklMNOpqrsTUVwxyz`)

### Step 2: Get Your Chat ID

1. Send a message to your new bot
2. Visit `https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getUpdates`
3. Find `"chat":{"id":123456789}` in the response - this is your chat ID

### Step 3: Configure Environment Variables

Add the following to your `.env` file:

```bash
# Telegram Bot Integration
TELEGRAM_BOT_TOKEN=your_bot_token_here
TELEGRAM_ALLOWED_CHAT_IDS=your_chat_id_here
```

Multiple chat IDs can be specified separated by commas: `123456789,987654321`

Note: Telegram tasks will use the working directory configured in Settings.

### Step 4: Expose Local Server with ngrok

Telegram webhooks require a public HTTPS URL. Use [ngrok](https://ngrok.com/) to create a tunnel to your local server:

```bash
# Install ngrok (if not already installed)
brew install ngrok  # macOS
# or download from https://ngrok.com/download

# Start ngrok tunnel (keep this running)
ngrok http 3000
```

ngrok will provide a public URL like `https://xxxx-xx-xx-xxx-xx.ngrok-free.app`

### Step 5: Set Up Webhook

Use the provided script to configure the webhook:

```bash
# Set webhook URL (use your ngrok URL)
npx tsx scripts/setup-telegram-webhook.ts https://your-domain.ngrok-free.app/api/telegram/webhook

# Other available commands:
npx tsx scripts/setup-telegram-webhook.ts info     # Show current webhook info
npx tsx scripts/setup-telegram-webhook.ts menu     # Set bot commands menu
npx tsx scripts/setup-telegram-webhook.ts delete   # Delete webhook
```

### Step 6: Test the Bot

1. Make sure your dev server is running (`pnpm dev`)
2. Make sure ngrok is running and pointing to port 3000
3. Send `/start` to your bot in Telegram
4. Try sending a task like "List all TypeScript files in the project"

### Telegram Bot Commands

| Command | Description |
|---------|-------------|
| `/start` | Start the bot and show welcome message |
| `/help` | Show help information |
| `/chats` | Browse and select existing chat sessions |
| `/back` | Return to main orchestrator agent |
| `/status` | Show system status and chat statistics |
| `/clear` | Clear conversation history |

### Telegram Architecture

```
┌────────────────┐         ┌─────────────────┐         ┌──────────────────┐
│   Telegram     │  HTTPS  │     ngrok       │  HTTP   │   Next.js App    │
│   Cloud API    │◄───────►│   Tunnel        │◄───────►│   localhost:3000 │
└────────────────┘         └─────────────────┘         └──────────────────┘
                                                              │
                                                              ▼
                                                       ┌──────────────────┐
                                                       │  /api/telegram/  │
                                                       │    webhook       │
                                                       └──────────────────┘
                                                              │
                                                              ▼
                                                       ┌──────────────────┐
                                                       │  Orchestrator    │
                                                       │     Agent        │
                                                       └──────────────────┘
```

### Production Deployment

For production, replace ngrok with a proper deployment:

1. Deploy to Vercel, Railway, or any hosting with HTTPS
2. Update the webhook URL: `npx tsx scripts/setup-telegram-webhook.ts https://your-production-domain.com/api/telegram/webhook`

## Usage

### Direct Chat Mode

1. Click "New Chat" in sidebar
2. Type your message
3. Cursor Agent responds directly
4. Continue conversation as needed

### Orchestrator Mode

1. Click "AI Orchestrator" button (purple gradient)
2. Set your working directory
3. Describe your complex task
4. AI will:
   - Analyze the request
   - Explore codebase if needed
   - Create one or more chats
   - Manage conversations automatically
   - Report completion status

### Example Tasks for Orchestrator

- "Refactor the authentication module to use JWT"
- "Add unit tests for all API endpoints"
- "Implement dark mode support across the app"
- "Fix all TypeScript errors in the project"

## Business Logic

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                         Web UI                                   │
│  ┌──────────────────┐    ┌────────────────────────────────────┐ │
│  │   Chat Sessions  │    │   Global Orchestrator Panel        │ │
│  │   (Independent)  │    │   (Manages all chats)              │ │
│  └──────────────────┘    └────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
           │                              │
           ▼                              ▼
┌──────────────────┐         ┌─────────────────────────────────┐
│   /api/chat      │         │   /api/orchestrate              │
│   Direct Cursor  │         │   Claude + Chat Manager         │
│   Interaction    │         │   Creates & monitors chats      │
└──────────────────┘         └─────────────────────────────────┘
           │                              │
           │                    ┌─────────┴─────────┐
           ▼                    ▼                   ▼
┌──────────────────────────────────────────────────────────────┐
│                    Cursor Agent CLI                           │
│              agent -p --output-format=stream-json             │
└──────────────────────────────────────────────────────────────┘
```

### Key Features

#### 1. Global Orchestrator (AI Task Manager)

- **Independent of chats** - Orchestrator is a global dialog, not bound to any specific chat
- **Task decomposition** - AI analyzes complex requests and breaks them into subtasks
- **Auto-conversation** - After creating a chat, AI monitors responses and continues conversation until task is complete
- **Completion detection** - AI detects when Cursor says "done", "completed", etc.

#### 2. Chat Sessions

- **Manual creation** - Users can create new chats anytime
- **Orchestrator creation** - AI Orchestrator can create chats for subtasks
- **Status tracking** - Each chat shows status: idle, running, completed, error
- **Independent conversations** - Each chat is a separate Cursor Agent process

#### 3. Intelligent Agent Manager

The system uses a sophisticated Agent Manager prompt to handle conversations:

**State Detection:**
- `WORKING` - AI is executing tasks (writing code, debugging, etc.)
- `BLOCKED` - AI encountered problems that need help
- `CLARIFYING` - AI needs confirmation on details
- `COMPLETED` - AI claims task is finished
- `PARTIAL` - AI completed part of the work

**Decision Logic:**
- For WORKING: Let AI continue, request status updates
- For BLOCKED: Identify obstacle, provide guidance
- For CLARIFYING: Evaluate question, authorize or answer
- For PARTIAL: Confirm progress, ask for remaining checklist
- For COMPLETED: Enter verification process

**Completion Verification:**
Before accepting "done", the system requires AI to confirm:
- Functional completeness
- Code quality
- Runnability
- All deliverables present

#### 4. Auto-Conversation Flow

When Orchestrator creates a chat:

```
1. User → Orchestrator: "Refactor the auth module"
2. Orchestrator → Creates Chat: "Refactor auth module"
3. Chat → Cursor Agent: "Please refactor..."
4. Cursor Agent → Chat: "I've made changes to..."
5. Agent Manager analyzes response:
   - Detects state (WORKING/BLOCKED/CLARIFYING/PARTIAL/COMPLETED)
   - If COMPLETED: requests verification checklist
   - If verified: marks as TASK_COMPLETE
   - Otherwise: sends appropriate follow-up
6. Repeat until task is verified complete
```

### Conversation Loop Logic

```typescript
while (turn < maxTurns && !isTaskComplete) {
    // 1. Send message to Cursor
    const response = await sendToCursor(message);
    
    // 2. Agent Manager analyzes and decides
    const { nextAction, state, isComplete } = await analyzeAndDecide(response);
    
    // 3. If verified complete, stop
    if (isComplete) {
        isTaskComplete = true;
        break;
    }
    
    // 4. Otherwise, send follow-up based on detected state
    message = nextAction;
}
```

## Project Structure

```
src/
├── app/
│   ├── api/
│   │   ├── chat/route.ts         # Chat API (single & auto modes)
│   │   └── orchestrate/route.ts  # Orchestrator API
│   ├── page.tsx                  # Main UI with global orchestrate
│   └── layout.tsx
├── components/
│   ├── Sidebar.tsx               # Chat list with status icons
│   ├── OrchestratePanel.tsx      # Global orchestrator dialog
│   └── ThemeToggle.tsx
└── lib/
    ├── agent/
    │   ├── cursor-executor.ts    # Cursor CLI interface
    │   ├── chat-manager.ts       # Auto-conversation with Agent Manager
    │   ├── orchestrator.ts       # Claude orchestration agent
    │   ├── tools.ts              # Tool definitions
    │   └── index.ts
    ├── prompts/                   # AI Prompts (centralized)
    │   ├── index.ts              # Prompt exports
    │   ├── orchestrator.ts       # Orchestrator system prompt
    │   └── agent-manager.ts      # Agent Manager prompt (conversation management)
    └── types.ts                  # Type definitions
```

## Prompts

All AI prompts are centralized in `src/lib/prompts/`:

### Orchestrator Prompt (`orchestrator.ts`)
Guides the main orchestrator to:
- Analyze user requests
- Explore codebase for context
- Break down complex tasks
- Create and monitor chat sessions

### Agent Manager Prompt (`agent-manager.ts`)
Manages Cursor Agent conversations by:
- Analyzing response state (WORKING/BLOCKED/CLARIFYING/PARTIAL/COMPLETED)
- Making intelligent decisions based on state
- Requiring completion verification checklist
- Detecting issues proactively (repeated attempts, error keywords, vague responses)

## API Reference

### POST /api/chat

Chat with Cursor Agent.

**Request:**
```json
{
    "messages": [{ "role": "user", "content": "..." }],
    "mode": "single" | "auto",
    "workdir": "/path/to/project",
    "sessionId": "optional-resume-id"
}
```

**Response:** Server-Sent Events stream

### POST /api/orchestrate

Run AI orchestration.

**Request:**
```json
{
    "request": "Complex task description",
    "workdir": "/path/to/project"
}
```

**Response:** Server-Sent Events with:
- `message` - AI thinking/response
- `tool_start/tool_end` - Tool execution
- `chat_created` - New chat created
- `chat_update` - Chat status changed (includes state detection)
- `chat_complete` - Chat finished
- `result` - Final orchestration result

## License

MIT
