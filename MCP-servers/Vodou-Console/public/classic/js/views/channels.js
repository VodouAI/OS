/**
 * Messaging view (route #/messaging) — Slack, Telegram, Discord, WhatsApp, voice
 * Each connector has metadata + an interactive setup guide
 */

// Brand SVG icons (inline, no external deps)
const CHANNEL_ICONS = {
  telegram: '<svg class="channel-icon-telegram" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.479.33-.913.492-1.302.48-.428-.013-1.252-.242-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/></svg>',
  slack: '<svg viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52zm1.271 0a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A"/><path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834zm0 1.271a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0"/><path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834zm-1.27 0a2.528 2.528 0 0 1-2.523 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.163 0a2.528 2.528 0 0 1 2.523 2.522v6.312z" fill="#2EB67D"/><path d="M15.163 18.956a2.528 2.528 0 0 1 2.523 2.522A2.528 2.528 0 0 1 15.163 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52zm0-1.27a2.527 2.527 0 0 1-2.52-2.523 2.527 2.527 0 0 1 2.52-2.52h6.315A2.528 2.528 0 0 1 24 15.163a2.528 2.528 0 0 1-2.522 2.523h-6.315z" fill="#ECB22E"/></svg>',
  discord: '<svg class="channel-icon-discord" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.8733.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>',
  teams: '<svg class="channel-icon-teams" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#6264A7" d="M20.625 8.127q-.55 0-1.025-.205-.475-.205-.832-.563-.358-.357-.563-.832Q18 6.053 18 5.502q0-.54.205-1.02t.563-.837q.357-.358.832-.563.474-.205 1.025-.205.54 0 1.02.205t.837.563q.358.357.563.837.205.48.205 1.02 0 .55-.205 1.025-.205.475-.563.832-.357.358-.837.563-.48.205-1.02.205zm0-3.75q-.469 0-.797.328-.328.328-.328.797 0 .469.328.797.328.328.797.328.469 0 .797-.328.328-.328.328-.797 0-.469-.328-.797-.328-.328-.797-.328zM24 10.002v5.578q0 .774-.293 1.46-.293.685-.803 1.194-.51.51-1.195.803-.686.293-1.459.293-.445 0-.908-.105-.463-.106-.85-.329-.293.95-.855 1.729-.563.78-1.319 1.336-.756.557-1.67.861-.914.305-1.898.305-1.148 0-2.162-.398-1.014-.399-1.805-1.102-.79-.703-1.312-1.664t-.674-2.086h-5.8q-.411 0-.704-.293T0 16.881V6.873q0-.41.293-.703t.703-.293h8.59q-.34-.715-.34-1.5 0-.727.275-1.365.276-.639.75-1.114.475-.474 1.114-.75.638-.275 1.365-.275t1.365.275q.639.276 1.114.75.474.475.75 1.114.275.638.275 1.365t-.275 1.365q-.276.639-.75 1.113-.475.475-1.114.75-.638.276-1.365.276-.188 0-.375-.024-.188-.023-.375-.058v1.078h10.875q.469 0 .797.328.328.328.328.797zM12.75 2.373q-.41 0-.78.158-.368.158-.638.434-.27.275-.428.639-.158.363-.158.773 0 .41.158.78.159.368.428.638.27.27.639.428.369.158.779.158.41 0 .773-.158.364-.159.64-.428.274-.27.433-.639.158-.369.158-.779 0-.41-.158-.773-.159-.364-.434-.64-.275-.275-.639-.433-.363-.158-.773-.158zM6.937 9.814h2.25V7.94H2.814v1.875h2.25v6h1.875zm10.313 7.313v-6.75H12v6.504q0 .41-.293.703t-.703.293H8.309q.152.809.556 1.5.405.691.985 1.19.58.497 1.318.779.738.281 1.582.281.926 0 1.746-.352.82-.351 1.436-.966.615-.616.966-1.43.352-.815.352-1.752zm5.25-1.547v-5.203h-3.75v6.855q.305.305.691.452.387.146.809.146.469 0 .879-.176.41-.175.715-.48.304-.305.48-.715t.176-.879Z"/></svg>',
  googlechat: '<svg class="channel-icon-googlechat" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#00832d" d="M1.637 0C.733 0 0 .733 0 1.637v16.5c0 .904.733 1.636 1.637 1.636h3.955v3.323c0 .804.97 1.207 1.539.638l3.963-3.96h11.27c.903 0 1.636-.733 1.636-1.637V5.592L18.408 0Zm3.955 5.592h12.816v8.59H8.455l-2.863 2.863Z"/></svg>',
  signal: '<svg class="channel-icon-signal" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true" xmlns="http://www.w3.org/2000/svg"><path fill="#2592E3" d="M12.012 2.598c-5.22 0-9.452 4.233-9.452 9.452 0 5.22 4.232 9.452 9.452 9.452 5.22 0 9.452-4.232 9.452-9.452 0-5.219-4.232-9.452-9.452-9.452zm0 1.769c4.243 0 7.682 3.439 7.682 7.683 0 4.243-3.439 7.682-7.682 7.682-4.244 0-7.683-3.439-7.683-7.682 0-4.244 3.439-7.683 7.683-7.683zm3.031 4.025c-.15 0-.274.124-.274.274v2.134c0 .15.124.274.274.274h1.526c.15 0 .274-.124.274-.274V8.666c0-.15-.124-.274-.274-.274zm-3.031.548c-2.147 0-3.888 1.741-3.888 3.888 0 2.147 1.741 3.888 3.888 3.888 2.147 0 3.888-1.741 3.888-3.888 0-2.147-1.741-3.888-3.888-3.888zm0 1.098c1.541 0 2.79 1.249 2.79 2.79 0 1.541-1.249 2.79-2.79 2.79-1.541 0-2.79-1.249-2.79-2.79 0-1.541 1.249-2.79 2.79-2.79z"/></svg>',
  whatsapp: '<svg class="channel-icon-whatsapp" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 0 1-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 0 1-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 0 1 2.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0 0 12.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 0 0 5.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 0 0-3.48-8.413z"/></svg>',
  voice: '<svg class="channel-icon-voice" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3zm-1-9c0-.55.45-1 1-1s1 .45 1 1v6c0 .55-.45 1-1 1s-1-.45-1-1V5zm6 6c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z"/></svg>',
  imessage: '<svg class="channel-icon-imessage" viewBox="0 0 24 24" width="1em" height="1em" aria-hidden="true"><rect width="24" height="24" rx="6" fill="#34C759"/><path fill="#fff" transform="translate(4,4)" d="M8 15c4.418 0 8-3.134 8-7s-3.582-7-8-7-8 3.134-8 7c0 1.76.743 3.37 1.97 4.6-.097 1.016-.417 2.13-.771 2.966-.079.186.074.394.273.362 2.256-.37 3.597-.938 4.18-1.234A9 9 0 0 0 8 15"/></svg>',
  web: '<svg class="channel-icon-web" viewBox="0 0 24 24" width="1em" height="1em" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>',
};

const CHANNEL_META = {
  telegram: {
    label: 'Telegram', icon: CHANNEL_ICONS.telegram,
    setup: [
      { title: 'Create a bot', instructions: 'Open Telegram and message <strong>@BotFather</strong>. Send <code>/newbot</code>, choose a name, and choose a username.', link: { url: 'https://t.me/BotFather', label: 'Open BotFather' } },
      { title: 'Copy your bot token', instructions: 'BotFather will give you a token like <code>110201543:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw</code>. Paste it below.', field: 'TELEGRAM_BOT_TOKEN', fieldLabel: 'Bot Token' },
      { title: 'Get your chat ID (optional)', instructions: 'Send any message to your bot, then paste your chat ID below. If you skip this, your ID will be logged when you first message the bot.', field: 'TELEGRAM_ADMIN_ID', fieldLabel: 'Admin Chat ID', optional: true },
      { title: 'Connect', instructions: 'Save and start Telegram.', action: 'start' },
      {
        title: 'Allowlist heads-up',
        instructions:
          'When you later enable <strong>Only reply to allowed senders</strong>, add <strong>YOUR</strong> chat ID or @username — <em>not the bot\'s</em>. ' +
          'The bot is the recipient; the allowlist controls who can message it. ' +
          'Easiest trick: start the channel, send it one test message, then grep <code>channels-telegram.log</code> for the <code>DENY sender=</code> line — the id it prints is yours. Add that, and the channel answers you and nobody else. (Do <em>not</em> discover it by leaving the allowlist off: with no list, every sender is treated as you, with your tools.)',
      },
    ],
  },
  slack: {
    label: 'Slack', icon: CHANNEL_ICONS.slack,
    setup: [
      { title: 'Create a Slack app', instructions: 'Go to the Slack API portal and click <strong>Create New App</strong> > <strong>From scratch</strong>. Name it (e.g. "Vodou") and pick your workspace.', link: { url: 'https://api.slack.com/apps', label: 'Open Slack API' } },
      { title: 'Enable Socket Mode + app token', instructions: '<strong>api.slack.com/apps</strong> → your app → left sidebar <strong>Socket Mode</strong> → turn <strong>Enable Socket Mode</strong> ON.<br><br>On that same page, open <strong>App-Level Tokens</strong> → <strong>Generate Token</strong> → pick a label (e.g. <code>socket</code>) → add scope <code>connections:write</code> → create. Slack shows a token starting with <code>xapp-</code> <em>once</em> — that value is <strong>SLACK_APP_TOKEN</strong> (not the bot token; the bot token is <code>xoxb-</code> from Install App later).', field: 'SLACK_APP_TOKEN', fieldLabel: 'App Token (xapp-...)' },
      { title: 'Add bot permissions', instructions: 'Go to <strong>OAuth & Permissions</strong> (left sidebar) → scroll to <strong>Scopes</strong> → <strong>Bot Token Scopes</strong> → <strong>Add an OAuth Scope</strong>. Add at least: <code>chat:write</code>, <code>app_mentions:read</code>, <code>im:history</code>, <code>im:write</code>, <code>channels:history</code> (for public/private channels), and <code>users:read</code> (<em>View people in a workspace</em> — needed so multi-member channels show real names instead of <code>U…</code> ids in Vodou chat).', link: { url: 'https://api.slack.com/apps', label: 'Open App Settings' } },
      { title: 'Enable DMs', instructions: 'Go to <strong>App Home</strong> (left sidebar) > turn ON <strong>Allow users to send Slash commands and messages from the messages tab</strong>.'},
      { title: 'Subscribe to events', instructions: 'Go to <strong>Event Subscriptions</strong> > turn ON > <strong>Subscribe to bot events</strong>: add <code>message.im</code> and <code>app_mention</code>.'},
      {
        title: 'Install to workspace',
        instructions:
          'Go to <strong>Install App</strong> > <strong>Install to Workspace</strong> > Allow. Copy the <strong>Bot User OAuth Token</strong> (<code>xoxb-...</code>).<br><br>' +
          '<strong>Important:</strong> if you ever add new scopes or event subscriptions later, come back here and <strong>Reinstall to Workspace</strong> — otherwise the old token is missing the new permissions and the bot will fail silently with <code>missing_scope</code> errors.',
        field: 'SLACK_BOT_TOKEN',
        fieldLabel: 'Bot Token (xoxb-...)',
      },
      { title: 'Signing secret', instructions: 'Go to <strong>Basic Information</strong> > copy the <strong>Signing Secret</strong>.', field: 'SLACK_SIGNING_SECRET', fieldLabel: 'Signing Secret' },
      { title: 'Connect', instructions: 'Save and start Slack.', action: 'start' },
      {
        title: 'Allowlist heads-up',
        instructions:
          'When you later enable <strong>Only reply in allowed channels</strong>, add BOTH: ' +
          '(1) the <strong>channel ID</strong> where conversations happen (right-click channel → View details → bottom of About tab, or copy from the channel URL — starts with <code>C</code> for public, <code>D</code> for DM, <code>G</code> for private), ' +
          'AND (2) the <strong>bot user ID</strong> (Slack app settings → Basic Information → App ID, or App Home → scroll to "Your app\'s user ID") so <code>@mention</code> events also route through. Plain human user IDs (<code>U…</code>) can be added too.',
      },
    ],
  },
  discord: {
    label: 'Discord', icon: CHANNEL_ICONS.discord,
    setup: [
      { title: 'Create a Discord app', instructions: 'Go to the Discord Developer Portal and click <strong>New Application</strong>. Name it (e.g. "Vodou").', link: { url: 'https://discord.com/developers/applications', label: 'Open Discord Developer Portal' } },
      {
        title: 'Enable Privileged Gateway Intents',
        instructions:
          '<strong>Required — or the bot connects but receives zero messages.</strong><br><br>' +
          'Left sidebar > <strong>Bot</strong> > scroll down to <strong>Privileged Gateway Intents</strong>. ' +
          'Toggle <strong>ON</strong>:<br>' +
          '• <strong>Message Content Intent</strong> (mandatory — lets the bot read what people type)<br>' +
          '• <strong>Server Members Intent</strong> (recommended)<br>' +
          '• <strong>Presence Intent</strong> (optional)<br><br>' +
          'Click <strong>Save Changes</strong> at the bottom. If you skip this step the log will say ' +
          '<code>Used disallowed intents</code> and no messages arrive.',
      },
      {
        title: 'Copy bot token (NOT Public Key)',
        instructions:
          'Still on the <strong>Bot</strong> page, click <strong>Reset Token</strong> and copy the ~70-char string that appears.<br><br>' +
          '<strong>Common mix-up:</strong> the <strong>Public Key</strong> (under General Information) is NOT the bot token — that one verifies Discord webhook signatures and won\'t authenticate the bot. ' +
          'Bot Token looks like <code>MTIzNDU2Nz.Gabc.def-ghijklmnop</code> (three dot-separated chunks). Discord only shows it <em>once</em>; hit Reset Token any time you lose it.',
        field: 'DISCORD_BOT_TOKEN',
        fieldLabel: 'Bot Token',
      },
      {
        title: 'Invite bot to server',
        instructions:
          'Developer Portal > <strong>OAuth2</strong> > <strong>URL Generator</strong>.<br><br>' +
          '<strong>Scopes:</strong> <code>bot</code> (and <code>applications.commands</code> if you plan to add slash commands later).<br><br>' +
          '<strong>Bot Permissions — tick these:</strong><br>' +
          '• View Channels<br>' +
          '• Send Messages<br>' +
          '• Read Message History<br>' +
          '• Embed Links <em>(makes URLs render as cards)</em><br>' +
          '• Attach Files <em>(future-proofing for media replies)</em><br>' +
          '• Send Messages in Threads<br>' +
          '• Add Reactions<br>' +
          '• Use External Emojis<br><br>' +
          '<strong>Do NOT tick:</strong> Administrator, Manage Server, Manage Channels, Manage Roles, Manage Webhooks, Kick/Ban Members, Mention @everyone. A compromised bot token shouldn\'t be able to nuke your server.<br><br>' +
          'Copy the generated URL at the bottom → open in a browser → pick your server → Authorize.',
        link: { url: 'https://discord.com/developers/applications', label: 'Open App Settings' },
      },
      { title: 'Get server ID', instructions: 'In Discord (the app, not the portal): Settings > Advanced > enable Developer Mode. Then right-click your server name > Copy Server ID.', field: 'DISCORD_GUILD_ID', fieldLabel: 'Guild (Server) ID' },
      {
        title: 'Connect',
        instructions:
          'Save credentials and start the Discord channel. Log line <code>[Discord] Logged in as YourBot#1234</code> means it\'s live. ' +
          'If you see <code>Used disallowed intents</code> instead, go back to step 2.',
        action: 'start',
      },
      {
        title: 'If messages come in but replies never arrive',
        instructions:
          'Gateway log says <code>Discord send failed (HTTP 403): Missing Access</code> when the bot can\'t post in the channel. Two root causes:<br><br>' +
          '<strong>A. Channel-level permission overrides.</strong> Even if your OAuth invite granted Send Messages at the server level, a specific channel can deny it. ' +
          'Right-click the channel → <strong>Edit Channel</strong> → <strong>Permissions</strong> → add the bot as a Member → explicitly ✅ View Channel, ✅ Send Messages, ✅ Read Message History. Save.<br><br>' +
          '<strong>B. Token belongs to a different bot than the one in your server.</strong> Easy to create two apps in the Dev Portal and paste the wrong token. Verify:<br>' +
          '1. In Discord, Developer Mode on → right-click the bot in your server\'s member list → Copy User ID.<br>' +
          '2. Compare against the token\'s bot ID — gateway logs it on startup, or run:<br>' +
          '<code>curl -s -H "Authorization: Bot $TOKEN" https://discord.com/api/v10/users/@me | jq .id</code><br>' +
          'IDs must match. If they don\'t, either paste the correct token into the credentials card below, or re-invite the correct bot to the server.',
      },
      {
        title: 'Allowlist heads-up',
        instructions:
          'When you later enable <strong>Only reply to allowed senders</strong>, add the <strong>sender\'s</strong> Discord user ID, @username, or the channel ID. ' +
          '<em>Not the bot\'s own ID</em> — the bot is the recipient; the allowlist gates who can message it.',
      },
    ],
  },
  teams: {
    label: 'Microsoft Teams', icon: CHANNEL_ICONS.teams,
    setup: [
      {
        title: 'Create an Azure Bot',
        instructions:
          'In <a href="https://portal.azure.com" target="_blank" rel="noopener">Azure Portal</a> → <strong>Create a resource</strong> → search <strong>Azure Bot</strong> → create. ' +
          'Pick subscription, resource group, bot handle, pricing (F0 free tier is fine). Under <strong>Microsoft App ID</strong> choose <em>Create new</em> or link an existing App Registration.',
        link: { url: 'https://portal.azure.com/#create/Microsoft.AzureBot', label: 'Azure Portal — Azure Bot' },
      },
      {
        title: 'Enable the Teams channel',
        instructions:
          'Open your new Bot resource → <strong>Channels</strong> (left) → click <strong>Microsoft Teams</strong> icon → <strong>Agree</strong> to terms → Save. ' +
          'Without this step Teams will not deliver messages to your bot.',
      },
      {
        title: 'Messaging endpoint (public HTTPS)',
        instructions:
          'Same Bot resource → <strong>Configuration</strong> → <strong>Messaging endpoint</strong>. ' +
          'It must be a public URL that reaches this machine on the port Vodou listens on for Teams (default <strong>3978</strong>), path <code>/api/messages</code>.<br><br>' +
          'Examples: <code>https://YOUR-NGROK-ID.ngrok-free.app/api/messages</code> (ngrok <code>ngrok http 3978</code>), Cloudflare Tunnel, or Tailscale Funnel. ' +
          'Local-only <code>http://localhost:3978</code> will <em>not</em> work — Microsoft\'s servers must reach you.',
      },
      {
        title: 'Copy App ID and create a client secret',
        instructions:
          'Azure Portal → your Bot → <strong>Configuration</strong> → copy <strong>Microsoft App ID</strong>. ' +
          'Then open the linked <strong>App registration</strong> (Manage Microsoft App ID) → <strong>Certificates &amp; secrets</strong> → <strong>New client secret</strong> → copy the <strong>Value</strong> immediately (shown once).',
      },
      {
        title: 'Single-tenant bots',
        instructions:
          'If your App Registration is single-tenant, paste your <strong>Directory (tenant) ID</strong> into <code>TEAMS_TENANT_ID</code> below. Leave it empty for multi-tenant (typical dev bots).',
        field: 'TEAMS_TENANT_ID',
        fieldLabel: 'Tenant ID (optional)',
        optional: true,
      },
      {
        title: 'Save credentials &amp; start',
        instructions:
          'Open the <strong>Tokens</strong> section below → paste <strong>TEAMS_APP_ID</strong> and <strong>TEAMS_APP_PASSWORD</strong> (client secret value) → Save → click <strong>Start Microsoft Teams</strong> on the card. ' +
          'Logs: <code>tail -f .vodou/workspace/channels-teams.log</code>',
      },
      {
        title: 'Allowlist (optional)',
        instructions:
          'When <strong>Only allowed senders</strong> is on, add the Teams user AAD object id and/or the conversation id. ' +
          'Easiest: start the channel, send one chat message, then grep <code>channels-teams.log</code> for the <code>DENY sender=</code> line and add the id it prints.',
      },
    ],
  },
  googlechat: {
    label: 'Google Chat', icon: CHANNEL_ICONS.googlechat,
    setup: [
      {
        title: 'Google Cloud project',
        instructions:
          'Open <a href="https://console.cloud.google.com" target="_blank" rel="noopener">Google Cloud Console</a> → create or pick a project → ' +
          '<strong>APIs &amp; Services</strong> → <strong>Enable APIs</strong> → enable <strong>Google Chat API</strong>.',
        link: { url: 'https://console.cloud.google.com/apis/library/chat.googleapis.com', label: 'Enable Chat API' },
      },
      {
        title: 'Service account',
        instructions:
          'IAM &amp; Admin → <strong>Service Accounts</strong> → create → <strong>Keys</strong> → Add key → JSON. ' +
          'Paste the full JSON into <code>GOOGLE_CHAT_CREDENTIALS</code> below (one line is fine). ' +
          'In Chat API configuration, publish the app and set the HTTP endpoint to your public URL + <code>/api/googlechat</code> (default port <strong>3979</strong> on this machine — use ngrok/tunnel to expose it).',
      },
      {
        title: 'Save &amp; start',
        instructions:
          'Save tokens → <strong>Start Google Chat</strong> on the card. Logs: <code>tail -f .vodou/workspace/channels-googlechat.log</code>',
      },
      {
        title: 'Allowlist (optional)',
        instructions:
          'When restricted, add <code>users/…</code> resource names or display names from inbound events. ' +
          'Easiest: message the bot once, then grep the log for the <code>DENY sender=</code> line and add the id it prints.',
      },
    ],
  },
  signal: {
    label: 'Signal', icon: CHANNEL_ICONS.signal,
    setup: [
      {
        title: 'Install signal-cli',
        instructions:
          'Install <a href="https://github.com/AsamK/signal-cli" target="_blank" rel="noopener">signal-cli</a> and register this machine as a linked device (or primary) for your Signal number. ' +
          'The daemon must be able to run <code>signal-cli -a +YOURNUMBER jsonRpc</code> on this host.',
        link: { url: 'https://github.com/AsamK/signal-cli', label: 'signal-cli on GitHub' },
      },
      {
        title: 'Credentials',
        instructions:
          'Set <strong>SIGNAL_PHONE_NUMBER</strong> (E.164). Optionally set <strong>SIGNAL_CLI_PATH</strong> if <code>signal-cli</code> is not on PATH, and <strong>SIGNAL_CLI_CONFIG</strong> if you use a custom <code>--config</code> directory.',
        field: 'SIGNAL_PHONE_NUMBER',
        fieldLabel: 'Signal number (E.164)',
      },
      {
        title: 'Start Signal',
        instructions:
          'Save tokens → <strong>Start Signal</strong> on the card. Inbound messages arrive over JSON-RPC; replies use <code>signal-cli send</code>. Logs: <code>tail -f .vodou/workspace/channels-signal.log</code>',
        action: 'start',
      },
      {
        title: 'Allowlist (optional)',
        instructions:
          'When restricted, add sender phone digits (country code + number, no spaces) and/or group id strings from the log. ' +
          'Easiest: start the channel, message yourself once, then grep <code>channels-signal.log</code> for the <code>DENY sender=</code> line and add the id it prints.',
      },
    ],
  },
  whatsapp: {
    label: 'WhatsApp', icon: CHANNEL_ICONS.whatsapp,
    setup: [
      { title: 'Optional: Pair by code', instructions: 'If QR fails, enter your phone number with country code (digits only, e.g. 15551234567). We will request a WhatsApp pairing code you can type on your phone.', field: 'WHATSAPP_PHONE_NUMBER', fieldLabel: 'Phone Number (E.164 digits)', optional: true },
      { title: 'Start WhatsApp channel', instructions: 'No API key needed. Click the button below to start the WhatsApp service. A QR code will appear right below in the "Pair your phone" section.', action: 'start' },
      { title: 'Scan QR code', instructions: 'On your phone: open <strong>WhatsApp</strong> > <strong>Settings</strong> > <strong>Linked Devices</strong> > <strong>Link a Device</strong>. Scan the QR code shown below. Once paired, this step completes automatically.' },
      { title: 'Done', instructions: 'WhatsApp is connected. Only <strong>private (1:1)</strong> chats count: messages <strong>you</strong> send go to Vodou. <strong>Group chats never</strong> trigger Vodou (even your own messages there). Other people\'s DMs are ignored. Session persists across restarts — no need to re-scan.' },
      {
        title: 'Allowlist heads-up',
        instructions:
          'WhatsApp\'s allowlist works <strong>differently</strong> from the other channels. The bridge forwards only <em>your own</em> messages (Vodou replies on your behalf), so the allowlist is <strong>the contacts whose conversations Vodou should respond in</strong> — NOT your own number. ' +
          'Add the digits-only phone of each recipient (with country code). Leave mode off if you want Vodou in every chat you type in.',
      },
    ],
  },
  voice: { label: 'Voice', icon: CHANNEL_ICONS.voice, setup: [] },
  web: { label: 'Web', icon: CHANNEL_ICONS.web, setup: [] },
  imessage: {
    label: 'iMessage', icon: CHANNEL_ICONS.imessage,
    setup: [
      {
        title: 'Grant Full Disk Access to Node',
        instructions:
          'Vodou reads incoming iMessages from <code>~/Library/Messages/chat.db</code> — macOS requires ' +
          '<strong>Full Disk Access</strong>. See the <strong>exact Node path</strong> for your machine in the ' +
          '"Permissions" panel below (e.g. <code>/usr/local/bin/node</code>).<br><br>' +
          '<strong>Easiest method — drag &amp; drop:</strong><br>' +
          '1. Click <strong>Open System Settings</strong> (button below). This opens Full Disk Access.<br>' +
          '2. In a new <strong>Finder</strong> window, press <strong>⌘⇧G</strong>, paste the folder part of the Node path ' +
          '(e.g. <code>/usr/local/bin</code>), click <strong>Go</strong>.<br>' +
          '3. You\'ll see <strong>node</strong> in that Finder window.<br>' +
          '4. <strong>Drag <code>node</code> directly from the Finder window onto the Full Disk Access list.</strong> ' +
          'macOS will add it and toggle it ON.<br><br>' +
          '<strong>If the + button dialog won\'t let you select Node:</strong> that\'s a macOS Sequoia/Sonoma quirk with ' +
          'command-line binaries. The drag-and-drop method above bypasses it. You may also need to press <strong>⌘⇧.</strong> ' +
          '(period) in Finder to show hidden folders like <code>/usr</code>.<br><br>' +
          '<strong>Why Node, not vodou-core?</strong> macOS grants Full Disk Access to whichever process ' +
          'actually opens the file. The gateway and iMessage channel both run under Node, so Node is what needs the grant.',
        action: 'open-fda-settings',
      },
      {
        title: 'Start iMessage channel',
        instructions:
          'Click Start below. If the permission is missing, the status panel will tell you ' +
          'exactly what to fix; click Refresh to re-check once you grant it.',
        action: 'start',
      },
      {
        title: 'Approve Messages automation',
        instructions:
          'The first message Vodou sends will trigger a macOS prompt asking whether ' +
          '<strong>vodou-core</strong> can control <strong>Messages</strong>. Click <strong>OK</strong>. ' +
          '(If you dismiss it by accident, grant via System Settings → Privacy & Security → Automation.)',
      },
      {
        title: 'Done',
        instructions:
          'iMessage is connected. By default Vodou listens to <strong>all</strong> incoming iMessages. ' +
          'Use the <strong>Allowed senders</strong> panel below to restrict to specific contacts — ' +
          'one-click import reads your most-frequent iMessage contacts so you can tick the ones Vodou should see.',
      },
      {
        title: 'Test Vodou by messaging yourself',
        instructions:
          'Apple lets you <strong>iMessage your own phone number</strong> — this is the simplest end-to-end test, no second person or device needed.<br><br>' +
          '<strong>How:</strong><br>' +
          '1. In the <strong>Allowed senders</strong> panel below, set mode <strong>On</strong> and add your own phone number (with country code, e.g. <code>+15551234567</code>). Anyone who has your number can iMessage you, so an empty list means anyone who does gets your agent and your tools — the channel will refuse to start that way.<br>' +
          '2. Open <strong>Messages</strong> on this Mac → click <strong>New Message</strong> (pencil icon, top-right) → in the "To:" field type your own phone number → press Return.<br>' +
          '3. Type any message (e.g. <code>Hey Vodou</code>) → hit send.<br>' +
          '4. Vodou will reply in that same thread within a few seconds.<br><br>' +
          '<strong>If it doesn\'t reply:</strong> tail the log with ' +
          '<code>tail -f .vodou/workspace/channels-imessage.log</code> and watch for the <code>[iMessage DIAG]</code> lines as you send. The log shows which contact was detected and whether the allowlist passed.<br><br>' +
          '<em>Tip:</em> on iPhone, the "Notes to Self" shortcut is the same thing — open Messages → new message → your number → send.',
      },
    ],
  },
};

/** Sidebar + card order for messaging connectors (matches #/messaging grid). */
const CHANNELS_SIDEBAR_ORDER = ['telegram', 'slack', 'discord', 'teams', 'googlechat', 'signal', 'whatsapp', 'imessage', 'voice', 'web']
  // iMessage reads ~/Library/Messages/chat.db via Full Disk Access — macOS only.
  // Don't render the card (or its FDA wizard) on Windows/Linux at all.
  .filter((c) => c !== 'imessage' || (window.VODOU_OS || 'mac') === 'mac');

const ChannelsView = {
  statuses: [],
  creds: {},
  standalone: { running: false, pid: null },
  // Cached snapshots for hashchange-driven sidebar re-renders (avoids a
  // refetch every navigation). Populated by render() and _refreshSidebar().
  _lastStatuses: [],
  _lastStandalone: { running: false, channels: [], perChannel: {} },

  // Shared escaper — safe.js loads first, so VodouSafe is always present.
  _esc(s) {
    return window.VodouSafe.escapeHtml(s);
  },

  /** Standalone Vodou-channels child is up for this messaging type (same rules as channel cards). */
  _standaloneMessagingProcessUp(type, standalone) {
    const st = standalone !== undefined && standalone !== null ? standalone : this.standalone;
    if (!st || !st.running) return false;
    const chs = st.channels || [];
    if (type === 'telegram') {
      return !chs.length || chs.includes('telegram');
    }
    return chs.includes(type);
  },

  /**
   * "Connected" for UI: MCP says connected, or standalone is up (except WhatsApp,
   * where we require MCP/merged connected so QR-waiting does not look live).
   */
  _channelStatusConnected(s) {
    if (!s) return false;
    const c = s.connected;
    if (c === true || c === 1) return true;
    if (typeof c === 'string' && /^(1|true|yes)$/i.test(c.trim())) return true;
    return false;
  },

  _effectiveChannelConnected(type, status, standalone) {
    const st = standalone !== undefined && standalone !== null ? standalone : this.standalone;
    const s = status || { connected: false };
    if (this._channelStatusConnected(s)) return true;
    if (type === 'whatsapp') return false;
    return this._standaloneMessagingProcessUp(type, st);
  },

  async render(container) {
    container.appendChild(Components.pageHeader('Messaging', `Connect Telegram, Slack, Discord, Teams, Google Chat, Signal, WhatsApp, ${(window.VODOU_OS || 'mac') === 'mac' ? 'iMessage, ' : ''}Voice, and Web. Vodou can receive and send messages from here.`));
    container.appendChild(Components.loading());

    try {
      const [statusRes, standaloneRes, credsRes] = await Promise.all([
        API.get('/api/channels/status').catch(() => ({ statuses: [] })),
        API.get('/api/channels/standalone/status').catch(() => ({ running: false })),
        API.get('/api/channels/credentials?reveal=1').catch(() => ({ channels: {} })),
      ]);
      this.creds = credsRes.channels || {};
      this.statuses = statusRes.statuses || (statusRes.status ? [statusRes.status] : []);
      // If MCP returned no statuses, seed with defaults so cards always render
      if (this.statuses.length === 0) {
        this.statuses = ['telegram','slack','discord','teams','googlechat','signal','whatsapp','imessage','voice','web'].map(ch => ({ channel: ch, connected: false, error: null }));
      }
      this.standalone = { running: !!standaloneRes.running, pid: standaloneRes.pid || null, channels: standaloneRes.channels || [], perChannel: standaloneRes.perChannel || {} };
      // Keep the left-nav channels list in sync with what we just fetched.
      this._lastStatuses = this.statuses;
      this._lastStandalone = {
        running: this.standalone.running,
        channels: this.standalone.channels || [],
        perChannel: this.standalone.perChannel || {},
      };
      this.renderSidebarChannels(this._lastStatuses, this._lastStandalone);
      container.innerHTML = '';

      // Header — same shape apps.js uses. Title + subtitle only.
      // Per-channel Start/Disconnect lives on each card; no bulk "Start all"
      // button in the header (noise, unused once any channel is running).
      // Status auto-refreshes every 8s via _primeChannelsSidebar; the explicit
      // "Refresh" button is redundant and removed here.
      const headerWrap = document.createElement('div');
      headerWrap.className = 'channels-header';
      headerWrap.innerHTML = `
        <div>
          <div class="page-title">Messaging</div>
          <div class="page-subtitle">Slack, Telegram, Discord, Microsoft Teams, Google Chat, Signal, WhatsApp, iMessage, and Voice — the places Vodou can receive messages and reply on your behalf. Each card has setup, API tokens, and allowed senders.</div>
        </div>`;
      container.appendChild(headerWrap);

      const grid = document.createElement('div');
      grid.className = 'channel-grid';

      const order = CHANNELS_SIDEBAR_ORDER;
      for (const type of order) {
        const meta = CHANNEL_META[type];
        const status = this.statuses.find(s => s.channel === type) || { channel: type, connected: false, error: null };
        grid.appendChild(this._card(type, meta, status, container));
      }
      container.appendChild(grid);

      // Community Channels section — dynamic packages from ~/.vodou/channels/
      await this._renderCommunitySection(container);

      this._updateBadge();
    } catch (err) {
      container.innerHTML = '';
      container.appendChild(Components.errorState(
        'Messaging connectors unavailable. Connect Vodou-channels under MCP Servers and set VODOU_TOKEN / VODOU_USER_ID in your project .env.'
      ));
      const row = document.createElement('div');
      row.className = 'flex-center flex-wrap gap-2 channels-error-actions';
      const startBg = document.createElement('button');
      startBg.className = 'btn btn-primary';
      startBg.textContent = 'Start Telegram, Slack, Discord';
      startBg.title =
        'Start standalone messaging (Telegram, Slack, Discord) without MCP. Useful when the status API fails but you only need the messaging process.';
      startBg.addEventListener('click', async () => {
        startBg.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', {
            channels: ['telegram', 'slack', 'discord'],
          });
          Components.toast(r.message || 'Started', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try {
            const j = JSON.parse(raw);
            if (j && typeof j.error === 'string') msg = j.error;
          } catch (_) {}
          Components.toast(msg, 'error');
        }
        startBg.disabled = false;
      });
      row.appendChild(startBg);
      container.appendChild(row);
    }
  },

  /** Toggle a credential input between text and password. Button label flips
   *  between "Hide" and "Show". Wired via inline onclick in _credentialPanel. */
  _toggleCredVisibility(inputId, btn) {
    const input = document.getElementById(inputId);
    if (!input) return;
    if (input.type === 'password') {
      input.type = 'text';
      if (btn) btn.textContent = 'Hide';
    } else {
      input.type = 'password';
      if (btn) btn.textContent = 'Show';
    }
  },

  /** Disconnect a single channel's standalone process via the channels API.
   *  Called from the modal's Disconnect button. Re-renders the Messaging grid
   *  and refreshes the sidebar so the nav item disappears instantly. */
  async _disconnectChannel(type, sheet) {
    if (!confirm(`Disconnect ${(CHANNEL_META[type] && CHANNEL_META[type].label) || type}? (Credentials stay saved.)`)) return;
    try {
      const r = await API.post('/api/channels/standalone/stop', { channels: [type] });
      if (window.Components && Components.toast) {
        Components.toast((r && r.message) || `${type} disconnected`, 'success');
      }
      if (sheet && typeof sheet.close === 'function') sheet.close();
      await this._refreshSidebar();
      const container = document.getElementById('main-content');
      if (container && (location.hash || '').startsWith('#/messaging')) {
        this.render(container);
      }
    } catch (e) {
      if (window.Components && Components.toast) {
        Components.toast('Disconnect failed: ' + (e.message || e), 'error');
      }
    }
  },

  _card(type, meta, status, container) {
    const card = document.createElement('div');
    card.className = 'detail-card channels-channel-card';
    card.classList.add('channels-channel-card');

    const main = document.createElement('div');
    main.className = 'channels-card-main';
    main.classList.add('channels-card-main');

    const footer = document.createElement('div');
    footer.className = 'channels-card-footer';
    footer.classList.add('channels-card-footer');

    const header = document.createElement('div');
    header.className = 'channels-card-header';
    header.innerHTML = `<span class="channels-card-icon">${meta.icon}</span><strong class="channels-card-title">${meta.label}</strong>`;
    main.appendChild(header);

    const standaloneRunning = this._standaloneMessagingProcessUp(type, this.standalone);
    const effectiveConnected = this._effectiveChannelConnected(type, status, this.standalone);

    // State row — rendered at the bottom of the card as a pill footer (matches Apps).
    const state = document.createElement('div');
    state.className = 'channels-card-state channels-card-meta-footer';
    if (effectiveConnected) {
      card.classList.add('is-connected');
      if (status.warning) {
        state.innerHTML = `<span class="status-dot-indicator status-warn channels-state-dot"></span> Connected <span class="channels-warning-hint" title="${this._esc(status.warning)}">⚠ permissions needed</span>`;
      } else {
        state.innerHTML = '<span class="status-dot-indicator status-ok channels-state-dot"></span> Connected';
      }
    } else if (standaloneRunning && type === 'whatsapp') {
      card.classList.add('is-idle');
      state.innerHTML = '<span class="status-dot-indicator status-warn channels-state-dot"></span> Waiting for QR scan...';
    } else if (status.error) {
      card.classList.add('is-error');
      state.innerHTML = `<span class="status-dot-indicator status-err channels-state-dot"></span> ${status.error}`;
    } else {
      card.classList.add('is-idle');
      state.innerHTML = '<span class="status-dot-indicator status-warn channels-state-dot"></span> Disconnected';
    }

    const actions = document.createElement('div');
    actions.className = 'channels-card-actions';
    actions.className = 'channels-card-actions';

    // "Settings & setup" + API tokens + Advanced all live in a modal sheet now —
    // keeps the card minimal (logo, name, primary action, details link, status pill).

    if ((type === 'telegram' || type === 'slack' || type === 'discord' || type === 'whatsapp' || type === 'imessage' || type === 'teams' || type === 'googlechat' || type === 'signal') && standaloneRunning) {
      const disconnectBtn = document.createElement('button');
      disconnectBtn.className = 'btn btn-danger';
      disconnectBtn.textContent = 'Disconnect';
      disconnectBtn.title = 'Disconnect this channel (other channels keep running).';
      disconnectBtn.addEventListener('click', async () => {
        disconnectBtn.disabled = true;
        try {
          await API.post('/api/channels/standalone/stop', { channels: [type] });
          Components.toast(meta.label + ' disconnected', 'success');
          await this.render(container);
        } catch (e) {
          Components.toast((e.message || e) + '', 'error');
        }
        disconnectBtn.disabled = false;
      });
      actions.appendChild(disconnectBtn);
    } else if (type === 'telegram' && !effectiveConnected) {
      const startBtn = document.createElement('button');
      startBtn.className = 'btn btn-primary';
      startBtn.textContent = 'Start ' + meta.label;
      startBtn.title = 'Run Telegram in a background channel process. Disconnect on this card stops it.';
      startBtn.addEventListener('click', async () => {
        startBtn.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['telegram'] });
          Components.toast(r.message || 'Standalone started', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startBtn.disabled = false;
      });
      actions.appendChild(startBtn);
    } else if (type === 'slack' && !effectiveConnected) {
      const startSlack = document.createElement('button');
      startSlack.className = 'btn btn-primary';
      startSlack.textContent = 'Start ' + meta.label;
      startSlack.title = 'Run Slack in a background channel process. Disconnect on this card stops it.';
      startSlack.addEventListener('click', async () => {
        startSlack.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['slack'] });
          Components.toast(r.message || 'Standalone started', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startSlack.disabled = false;
      });
      actions.appendChild(startSlack);
    } else if (type === 'discord' && !effectiveConnected) {
      const startDiscord = document.createElement('button');
      startDiscord.className = 'btn btn-primary';
      startDiscord.textContent = 'Start ' + meta.label;
      startDiscord.title = 'Run Discord in a background channel process. Disconnect on this card stops it.';
      startDiscord.addEventListener('click', async () => {
        startDiscord.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['discord'] });
          Components.toast(r.message || 'Standalone started', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startDiscord.disabled = false;
      });
      actions.appendChild(startDiscord);
    } else if (type === 'teams' && !effectiveConnected) {
      const startTeams = document.createElement('button');
      startTeams.className = 'btn btn-primary';
      startTeams.textContent = 'Start ' + meta.label;
      startTeams.title = 'Run Microsoft Teams bot endpoint (HTTP /api/messages) in a background process.';
      startTeams.addEventListener('click', async () => {
        startTeams.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['teams'] });
          Components.toast(r.message || 'Teams channel starting…', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startTeams.disabled = false;
      });
      actions.appendChild(startTeams);
    } else if (type === 'googlechat' && !effectiveConnected) {
      const startGc = document.createElement('button');
      startGc.className = 'btn btn-primary';
      startGc.textContent = 'Start ' + meta.label;
      startGc.title = 'Run Google Chat HTTP endpoint (/api/googlechat) in a background process.';
      startGc.addEventListener('click', async () => {
        startGc.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['googlechat'] });
          Components.toast(r.message || 'Google Chat channel starting…', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startGc.disabled = false;
      });
      actions.appendChild(startGc);
    } else if (type === 'signal' && !effectiveConnected) {
      const startSig = document.createElement('button');
      startSig.className = 'btn btn-primary';
      startSig.textContent = 'Start ' + meta.label;
      startSig.title = 'Run Signal (signal-cli jsonRpc) in a background process.';
      startSig.addEventListener('click', async () => {
        startSig.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['signal'] });
          Components.toast(r.message || 'Signal channel starting…', 'success');
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        startSig.disabled = false;
      });
      actions.appendChild(startSig);
    } else if (type === 'whatsapp' && !effectiveConnected) {
      const startWA = document.createElement('button');
      startWA.className = 'btn btn-primary';
      startWA.textContent = 'Start ' + meta.label;
      startWA.title = 'Start WhatsApp channel. A QR code will appear below for pairing.';
      startWA.addEventListener('click', async () => {
        startWA.disabled = true;
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['whatsapp'] });
          Components.toast(r.message || 'WhatsApp starting — QR code loading...', 'success');
          // Wait a moment for the process to generate the QR, then re-render
          setTimeout(() => this.render(container), 3000);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
          startWA.disabled = false;
        }
      });
      actions.appendChild(startWA);
    } else if (type === 'imessage' && !effectiveConnected) {
      const startIM = document.createElement('button');
      startIM.className = 'btn btn-primary';
      startIM.textContent = 'Start ' + meta.label;
      startIM.title = 'Start iMessage channel. Requires Full Disk Access already granted to Node.';
      startIM.addEventListener('click', async () => {
        startIM.disabled = true;
        startIM.textContent = 'Starting...';
        try {
          const r = await API.post('/api/channels/standalone/start', { channels: ['imessage'] });
          Components.toast(r.message || 'iMessage channel starting…', 'success');
          setTimeout(() => this.render(container), 1500);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
          startIM.disabled = false;
          startIM.textContent = 'Start ' + meta.label;
        }
      });
      actions.appendChild(startIM);
    }

    const toggleBtn = document.createElement('button');
    toggleBtn.className = effectiveConnected ? 'btn btn-danger' : 'btn btn-primary';
    toggleBtn.textContent = effectiveConnected ? 'Disconnect' : 'Connect';
    const messaging = type === 'telegram' || type === 'slack' || type === 'discord' || type === 'whatsapp' || type === 'imessage' || type === 'teams' || type === 'googlechat' || type === 'signal';
    const hideToggle =
      (messaging && standaloneRunning) ||
      (messaging && !effectiveConnected);
    if (!hideToggle) {
      toggleBtn.addEventListener('click', async () => {
        toggleBtn.disabled = true;
        try {
          if (effectiveConnected) {
            await API.post('/api/channels/disconnect', { channels: [type] });
            Components.toast(`${meta.label} disconnected`, 'success');
          } else {
            await API.post('/api/channels/connect', { channels: [type] });
            Components.toast(`${meta.label} connected`, 'success');
          }
          await this.render(container);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
          Components.toast(msg, 'error');
        }
        toggleBtn.disabled = false;
      });
      actions.appendChild(toggleBtn);
    }

    // "Details" link — opens a modal with Setup, API tokens, Advanced (+ QR for WhatsApp).
    const detailsLink = document.createElement('button');
    detailsLink.type = 'button';
    detailsLink.className = 'card-details-link';
    detailsLink.textContent = effectiveConnected ? 'Details →' : (meta.setup && meta.setup.length ? 'Setup & tokens →' : 'Details →');
    detailsLink.addEventListener('click', () => this._openChannelModal(type, meta, status, effectiveConnected, standaloneRunning, container));
    actions.appendChild(detailsLink);

    main.appendChild(actions);

    card.appendChild(main);
    card.appendChild(state);

    // Unused here — kept to avoid side-effects on legacy CSS dependent on the empty node.
    void footer;

    return card;
  },

  /**
   * Build a collapsible sheet section matching Apps' `<details>` pattern.
   * Returns the outer section node (ready to append to sheet.body) AND the
   * details node (where content goes — any appendChild into it lands inside).
   */
  _collapsibleSection(labelText, { openByDefault = false } = {}) {
    const section = document.createElement('div');
    section.className = 'sheet-section';
    const details = document.createElement('details');
    details.className = 'sw-setup-steps-wrap sheet-section-collapsible';
    if (openByDefault) details.setAttribute('open', '');
    const summary = document.createElement('summary');
    summary.className = 'sw-setup-steps-summary';
    summary.textContent = labelText;
    details.appendChild(summary);
    section.appendChild(details);
    return { section, body: details };
  },

  /**
   * Open the per-channel sheet modal. Houses everything that used to live on the card:
   * setup wizard, API tokens panel, Advanced (WhatsApp reset session + log), voice panel,
   * WhatsApp QR code while pairing.
   */
  async _openChannelModal(type, meta, status, effectiveConnected, standaloneRunning, container) {
    const statusLabel = status.connected
      ? 'Connected'
      : standaloneRunning && type === 'whatsapp'
        ? 'Waiting for QR scan…'
        : standaloneRunning
          ? 'Connected'
          : status.error
            ? 'Error'
            : 'Not connected';
    const statusClass = status.connected || (standaloneRunning && type !== 'whatsapp')
      ? 'sheet-sub-ok'
      : 'sheet-sub-muted';

    const sheet = Components.openModal({
      iconHtml: meta.icon,
      title: meta.label,
      subtitle: `Channel · <span class="${statusClass}">${statusLabel}</span>`,
    });

    if (effectiveConnected) {
      const actionsWrap = document.createElement('div');
      actionsWrap.className = 'modal-sheet-header-actions';
      const disconnectHdr = document.createElement('button');
      disconnectHdr.type = 'button';
      disconnectHdr.className = 'btn btn-danger btn-sm';
      disconnectHdr.textContent = 'Disconnect';
      disconnectHdr.title = 'Stop this channel. Tokens stay saved so you can reconnect later.';
      disconnectHdr.addEventListener('click', () => this._disconnectChannel(type, sheet));
      actionsWrap.appendChild(disconnectHdr);
      const closeBtn = sheet.header.querySelector('.modal-sheet-close');
      if (closeBtn) sheet.header.insertBefore(actionsWrap, closeBtn);
    }

    // Setup section — always render when the provider has a setup walkthrough.
    // Auto-open when disconnected (first-time setup); collapsed when connected
    // so users can recall/troubleshoot/share instructions from a working install.
    // Matches the Apps "Setup prerequisites (recall)" pattern
    // (apps.js).
    if (meta.setup && meta.setup.length > 0) {
      const { section, body } = this._collapsibleSection(
        effectiveConnected ? 'Setup instructions (recall)' : 'Setup',
        { openByDefault: !effectiveConnected }
      );
      body.appendChild(this._buildSetupWizard(type, meta, container));
      sheet.body.appendChild(section);
    }

    // Tokens — always expanded: disconnected users need fields; connected users
    // manage keys without an extra click (setup section collapses instead).
    if (type === 'telegram' || type === 'slack' || type === 'discord' || type === 'whatsapp' || type === 'imessage' || type === 'teams' || type === 'googlechat' || type === 'signal') {
      const tokens = this._collapsibleSection('Tokens', { openByDefault: true });
      tokens.body.appendChild(this._credentialPanel(type));
      sheet.body.appendChild(tokens.section);
    }

    // Voice panel for the voice channel.
    if (type === 'voice') {
      const s = document.createElement('div');
      s.className = 'sheet-section';
      const l = document.createElement('div');
      l.className = 'sheet-section-label';
      l.textContent = 'Voice';
      s.appendChild(l);
      s.appendChild(this._voicePanel());
      sheet.body.appendChild(s);
    }

    // iMessage — permissions panel + allowed senders list.
    // Rendered whether connected or not: permissions section helps users fix
    // Full Disk Access without closing the modal, and the allowlist is useful
    // to edit live while the channel is running. Auto-open the panels when
    // disconnected (first-time setup); collapsed when connected so the sheet
    // foregrounds Tokens + Allowed senders.
    if (type === 'imessage') {
      const perm = this._collapsibleSection('Permissions', { openByDefault: !effectiveConnected });
      sheet.body.appendChild(perm.section);
      this._loadIMessagePanel(perm.body);

      const allow = this._collapsibleSection('Allowed senders', { openByDefault: true });
      sheet.body.appendChild(allow.section);
      this._loadIMessageAllowlist(allow.body);
    }

    // Apple-style per-sender allowlist for the other messaging channels.
    // Same on-disk format as iMessage — only the placeholder + mode copy
    // differs. Off by default (allow everyone) so upgrades don't break
    // existing behavior; flip mode=on to restrict.
    const ALLOWLIST_CONFIGS = {
      whatsapp: {
        channelLabel: 'WhatsApp',
        idPlaceholder: 'Contact\'s phone (e.g. 35352312078561)',
        modeText:
          '<strong>Only let Vodou respond in conversations with allowed contacts.</strong> ' +
          'WhatsApp is different from iMessage/Slack/Discord: the bridge only forwards messages <em>you send from your paired phone</em>, and Vodou replies on your behalf to whoever you were messaging. ' +
          'Leave off to let Vodou reply in every chat you type in.',
        emptyText:
          'Add the <strong>phone number of the contact</strong> (digits-only, with country code — e.g. <code>35352312078561</code> for Ireland, <code>15551234567</code> for US). ' +
          '<em>Don\'t add your own number</em> — your paired phone is the sender, the allowlist is the set of recipients whose conversations Vodou should respond in. ' +
          'Trick: send a test message, then grep <code>channels-whatsapp.log</code> for the number the bridge logged — that\'s what to paste here.',
      },
      slack: {
        channelLabel: 'Slack',
        idPlaceholder: 'Slack channel ID (C01…), user ID (U01…), or bot user ID',
        modeText: '<strong>Only reply in allowed Slack channels / DMs.</strong> When off, Vodou responds in every channel it is invited to.',
        emptyText:
          'Add the <strong>channel ID</strong> where conversations happen (right-click channel → View details → bottom of About tab, or the tail of the channel URL) ' +
          'AND your <strong>bot\'s user ID</strong> so @mentions route through. Plain user IDs (`U01…`) of humans you want to allow also work.',
      },
      discord: {
        channelLabel: 'Discord',
        idPlaceholder: 'Discord user ID, username, or channel ID',
        modeText: '<strong>Only reply to allowed Discord users / channels.</strong> When off, Vodou replies to every non-bot message.',
        emptyText:
          'Add the <strong>sender\'s</strong> Discord user ID, @username, or the channel ID where conversations happen. ' +
          '<em>Don\'t add your bot\'s own ID</em> — the bot is the recipient; the allowlist is for people sending TO it.',
      },
      telegram: {
        channelLabel: 'Telegram',
        idPlaceholder: 'Your chat ID or @username (NOT the bot\'s)',
        modeText: '<strong>Only reply to allowed Telegram chats.</strong> When off, Vodou replies in every chat the bot is added to.',
        emptyText:
          'Add <strong>your own</strong> numeric chat ID or @username — <em>not</em> the bot\'s. ' +
          'The bot is the recipient; the allowlist is the list of people who can talk TO it. ' +
          'Message your bot once with mode=off to see your chat ID logged in channels-telegram.log.',
      },
      teams: {
        channelLabel: 'Microsoft Teams',
        idPlaceholder: 'AAD user id, conversation id, or tenant id (from log)',
        modeText: '<strong>Only reply in allowed Teams chats.</strong> When off, Vodou replies to every chat where the bot is installed.',
        emptyText:
          'Add the <strong>sender\'s Azure AD object id</strong> and/or the <strong>conversation id</strong> (long string from Teams). ' +
          'Tip: send one message in Teams, then grep <code>channels-teams.log</code> for the <code>DENY sender=</code> line.',
      },
      googlechat: {
        channelLabel: 'Google Chat',
        idPlaceholder: 'users/1234567890 or display name (from log)',
        modeText: '<strong>Only reply to allowed Google Chat users.</strong> When off, Vodou replies in every space/DM where the app is added.',
        emptyText:
          'Add <strong>users/…</strong> resource names or display names logged on inbound messages. ' +
          'Tip: @mention the bot once, then grep <code>channels-googlechat.log</code> for the <code>DENY sender=</code> line.',
      },
      signal: {
        channelLabel: 'Signal',
        idPlaceholder: 'Phone digits (country code + number) or group id from log',
        modeText: '<strong>Only reply to allowed Signal senders or groups.</strong> When off, every inbound Signal message is processed.',
        emptyText:
          'Add the sender\'s <strong>phone as digits only</strong> (e.g. <code>15551234567</code>) and/or the <strong>group id</strong> string. ' +
          'Tip: send a test message, then grep <code>channels-signal.log</code> for the <code>DENY sender=</code> line.',
      },
    };
    if (ALLOWLIST_CONFIGS[type]) {
      const allow = this._collapsibleSection('Allowed senders', { openByDefault: true });
      sheet.body.appendChild(allow.section);
      this._loadChannelAllowlist(allow.body, type, ALLOWLIST_CONFIGS[type]);
    }

    // WhatsApp QR while pairing.
    // Always render the panel when not connected — the QR loader polls
    // until the WhatsApp bridge writes qr.txt. Requiring standaloneRunning
    // here was the bug: users clicked Start inside the setup wizard, the
    // process spawned but this modal never re-rendered, so the QR section
    // never existed to populate. Now it shows up whether the bridge is
    // already up or the user just clicked Start seconds ago.
    if (type === 'whatsapp' && !effectiveConnected) {
      const s = document.createElement('div');
      s.className = 'sheet-section';
      const l = document.createElement('div');
      l.className = 'sheet-section-label';
      l.textContent = 'Pair your phone';
      s.appendChild(l);
      sheet.body.appendChild(s);
      this._loadWhatsAppQR(s, container, sheet);
    }

    // WhatsApp Advanced — Reset session (recovery action).
    // Always collapsed by default; it's a destructive action users shouldn't hit by accident.
    if (type === 'whatsapp') {
      const adv = this._collapsibleSection('Advanced', { openByDefault: false });
      sheet.body.appendChild(adv.section);
      const s = adv.body;

      const hint = document.createElement('div');
      hint.className = 'sheet-empty';
      hint.style.cssText = 'font-style:normal;margin-bottom:8px;';
      hint.textContent =
        'Only use this if you need to re-pair your WhatsApp account with a different phone, or your current pairing is stuck.';
      s.appendChild(hint);

      const waLogWrap = document.createElement('div');
      waLogWrap.className = 'wa-session-log channels-wa-log';

      const resetWa = document.createElement('button');
      resetWa.className = 'btn btn-sm btn-ghost-danger';
      resetWa.textContent = 'Reset WhatsApp Session';
      resetWa.title = 'Stop WhatsApp, delete saved session, restart — shows last log lines below.';
      resetWa.addEventListener('click', async () => {
        resetWa.disabled = true;
        waLogWrap.classList.add('channels-wa-log-visible');
        waLogWrap.innerHTML = '<div class="channels-wa-log-muted">Resetting…</div>';
        try {
          const r = await API.post('/api/channels/whatsapp/reset', {});
          Components.toast(r.message || 'WhatsApp reset', 'success');
          waLogWrap.innerHTML = '';
          const hd = document.createElement('div');
          hd.className = 'channels-wa-log-title';
          hd.textContent = 'Recent log (channels-whatsapp.log)';
          waLogWrap.appendChild(hd);
          const pre = document.createElement('pre');
          pre.className = 'channels-wa-log-pre';
          pre.textContent = r.logTail || '(no lines yet)';
          waLogWrap.appendChild(pre);
          setTimeout(() => { sheet.close(); this.render(container); }, 1200);
        } catch (e) {
          const raw = (e.message || e) + '';
          let msg = raw;
          try {
            const j = JSON.parse(raw);
            if (j && typeof j.error === 'string') msg = j.error;
            if (j && typeof j.logTail === 'string' && j.logTail) {
              waLogWrap.innerHTML = '';
              const hd = document.createElement('div');
              hd.className = 'channels-wa-log-title channels-wa-log-title-error';
              hd.textContent = 'Error — log tail';
              waLogWrap.appendChild(hd);
              const pre = document.createElement('pre');
              pre.className = 'channels-wa-log-pre';
              pre.textContent = msg + '\n\n' + j.logTail;
              waLogWrap.appendChild(pre);
            } else {
              waLogWrap.innerHTML = `<div class="channels-wa-log-error">${msg}</div>`;
            }
          } catch (_) {
            waLogWrap.innerHTML = `<div class="channels-wa-log-error">${msg}</div>`;
          }
          Components.toast(msg, 'error');
        }
        resetWa.disabled = false;
      });

      s.appendChild(resetWa);
      s.appendChild(waLogWrap);
      // adv.section already appended to sheet.body above — `s` is the details body.
    }

    const typesWithCredentialTest = ['telegram', 'slack', 'discord', 'imessage', 'teams', 'googlechat', 'signal'];
    if (typesWithCredentialTest.includes(type)) {
      const foot = sheet.footer;
      foot.classList.add('channels-modal-test-footer');
      const row = document.createElement('div');
      row.className = 'channels-modal-footer-test';
      const testBtn = document.createElement('button');
      testBtn.type = 'button';
      testBtn.className = 'btn btn-secondary';
      testBtn.textContent = 'Test Connection';
      testBtn.addEventListener('click', () => this._testChannel(type));
      const resultDiv = document.createElement('div');
      resultDiv.id = 'cred-test-' + type;
      resultDiv.className = 'provider-test-result channels-modal-test-result';
      row.appendChild(testBtn);
      row.appendChild(resultDiv);
      foot.appendChild(row);
    }

    return sheet;
  },

  async _loadWhatsAppQR(mainEl, container, sheet) {
    const wrap = document.createElement('div');
    wrap.className = 'channels-qr-wrap';
    wrap.innerHTML = '<div class="channels-qr-muted">Loading QR code…</div>';
    mainEl.appendChild(wrap);

    // Clear any prior poll when we (re)enter this panel.
    if (this._whatsappQrPoll) {
      clearInterval(this._whatsappQrPoll);
      this._whatsappQrPoll = null;
    }
    // Stop polling when the modal closes (prevents background network calls
    // after the user navigates away).
    if (sheet && typeof sheet.onClose === 'function') {
      sheet.onClose(() => {
        if (this._whatsappQrPoll) { clearInterval(this._whatsappQrPoll); this._whatsappQrPoll = null; }
      });
    }

    const renderCycle = async () => {
      try {
        const res = await API.get('/api/channels/whatsapp/qr');
        this._renderWhatsAppQrResponse(wrap, res, container);
        // Stop polling once paired or QR fetched (QR itself doesn't change
        // until it expires; the backend refreshes qr.txt when that happens).
        if (res.paired) {
          if (this._whatsappQrPoll) { clearInterval(this._whatsappQrPoll); this._whatsappQrPoll = null; }
        }
      } catch {
        // silent retry on the next tick; surface only if we've never shown a QR
        if (!wrap.querySelector('.channels-qr-image')) {
          wrap.innerHTML = '<div class="channels-qr-muted">Waiting for WhatsApp bridge to start writing QR…</div>';
        }
      }
    };

    // First render immediately, then poll every 2s until QR appears or user pairs.
    // The 2s cadence matches how fast whatsapp-web.js rotates QR codes.
    await renderCycle();
    this._whatsappQrPoll = setInterval(renderCycle, 2000);
  },

  /** Render one response from /api/channels/whatsapp/qr into the panel. */
  _renderWhatsAppQrResponse(wrap, res, container) {
    if (res.paired) {
      wrap.innerHTML = '';
      const ok = document.createElement('div');
      ok.className = 'channels-qr-ok';
      ok.textContent = 'Linked and ready';
      wrap.appendChild(ok);
      const hint = document.createElement('div');
      hint.className = 'channels-qr-hint';
      hint.textContent = res.message || 'Session is active. Refresh status so the card shows Connected.';
      wrap.appendChild(hint);
      const ref = document.createElement('button');
      ref.className = 'btn btn-primary';
      ref.classList.add('channels-qr-btn');
      ref.textContent = 'Refresh status';
      ref.addEventListener('click', () => this.render(container));
      wrap.appendChild(ref);
      setTimeout(() => this.render(container), 600);
      return;
    }
    if (res.qr) {
      wrap.innerHTML = '';
      const label = document.createElement('div');
      label.className = 'channels-qr-title';
      label.textContent = 'Scan with WhatsApp to pair';
      wrap.appendChild(label);

      const hint = document.createElement('div');
      hint.className = 'channels-qr-hint channels-qr-hint-lg';
      hint.textContent = 'WhatsApp > Settings > Linked Devices > Link a Device';
      wrap.appendChild(hint);

      const qrImg = document.createElement('img');
      qrImg.src = 'https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=' + encodeURIComponent(res.qr);
      qrImg.alt = 'WhatsApp QR Code';
      qrImg.className = 'channels-qr-image';
      wrap.appendChild(qrImg);

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'btn btn-secondary';
      refreshBtn.classList.add('channels-qr-btn', 'channels-qr-btn-top');
      refreshBtn.textContent = 'Refresh QR';
      refreshBtn.addEventListener('click', () => this.render(container));
      wrap.appendChild(document.createElement('br'));
      wrap.appendChild(refreshBtn);
      return;
    }
    // No QR yet — either the bridge hasn't started or session is restoring.
    // Keep polling; just update the status line so the user sees progress.
    wrap.innerHTML = `<div class="channels-qr-muted">${res.message || 'Waiting for QR or session restore…'}</div>`;
    if (res.pairingCode) {
      const pairWrap = document.createElement('div');
      pairWrap.className = 'channels-pair-wrap';
      const pairTitle = document.createElement('div');
      pairTitle.className = 'channels-pair-title';
      pairTitle.textContent = 'Pairing code (WhatsApp > Linked Devices > Link with phone number):';
      const pairCode = document.createElement('div');
      pairCode.className = 'channels-pair-code';
      pairCode.textContent = res.pairingCode;
      pairWrap.appendChild(pairTitle);
      pairWrap.appendChild(pairCode);
      wrap.appendChild(pairWrap);
    }
  },

  /** iMessage permissions — Full Disk Access live probe + re-check. */
  async _loadIMessagePanel(mainEl) {
    const wrap = document.createElement('div');
    wrap.className = 'channels-qr-wrap';
    wrap.innerHTML = '<div class="channels-qr-muted">Checking permissions…</div>';
    mainEl.appendChild(wrap);
    try {
      const p = await API.get('/api/channels/imessage/permissions');
      if (p.platform !== 'darwin') {
        wrap.innerHTML = '<div class="channels-qr-muted">iMessage is macOS only.</div>';
        return;
      }
      const row = (label, status, hint) => {
        const r = document.createElement('div');
        r.className = 'channels-qr-hint';
        r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;';
        const left = document.createElement('span');
        left.innerHTML = `<strong>${label}:</strong>`;
        const right = document.createElement('span');
        const statusColor = status === 'granted' ? 'var(--accent, #10b981)' : (status === 'missing' ? '#dc2626' : '#6b7280');
        right.style.cssText = `color:${statusColor};font-weight:600;`;
        right.textContent = status;
        r.appendChild(left);
        r.appendChild(right);
        const h = document.createElement('div');
        h.className = 'channels-qr-hint';
        h.style.cssText = 'font-size:0.85em;color:#6b7280;margin-top:-4px;margin-bottom:6px;';
        h.textContent = hint;
        wrap.appendChild(r);
        wrap.appendChild(h);
      };
      wrap.innerHTML = '';
      row('chat.db exists', p.chatDbExists ? 'granted' : 'missing',
        p.chatDbExists ? p.chatDbPath : 'Messages.app not set up — sign in at Messages → Settings → iMessage.');
      // FDA is governed by the macOS TCC "responsible process" attribute
      // (inherited at fork time) — usually the .app at the top of the
      // launch chain, NOT the node binary. The server classifies which of
      // {app-bundle, terminal, ide, launchd, unknown} we're in and returns
      // tailored grantTargets + warning + cta; we render those instead of
      // the old one-size-fits-all "drag node" copy.
      const nodePath = p.nodeBinaryPath || '/usr/local/bin/node';
      const ctxLabel = {
        'app-bundle': 'App bundle',
        'terminal':   'Terminal',
        'ide':        'IDE / dev tool',
        'launchd':    'launchd',
        'unknown':    'Unknown',
      }[p.context] || 'Unknown';
      const buildFdaHint = () => {
        if (p.fullDiskAccess === 'granted') return 'Vodou can read incoming iMessages.';
        const parts = [];
        parts.push(
          '<div style="font-size:0.8em;color:#6b7280;margin-bottom:6px;">' +
          'Detected launch context: <strong>' + this._esc(ctxLabel) + '</strong>' +
          (p.responsibleApp?.name ? ' (' + this._esc(p.responsibleApp.name) + ')' : '') +
          '</div>'
        );
        if (p.context === 'ide' && p.warning) {
          parts.push(
            '<div style="border-left:3px solid #f59e0b;padding:6px 10px;background:rgba(245,158,11,0.08);margin-bottom:8px;font-size:0.85em;">' +
            '<strong>⚠ ' + this._esc(p.warning) + '</strong>' +
            '</div>'
          );
          if (p.cta?.cmd) {
            parts.push(
              '<strong>' + this._esc(p.cta.text || 'Run in Terminal.app:') + '</strong><br>' +
              '<pre style="font-size:0.8em;background:#0b0f17;color:#e2e8f0;padding:8px 10px;border-radius:6px;overflow:auto;margin:6px 0;">' +
              this._esc(p.cta.cmd) +
              '</pre>'
            );
          }
        }
        const targets = Array.isArray(p.grantTargets) ? p.grantTargets : [];
        const primary = targets.filter(t => t.primary !== false);
        const secondary = targets.filter(t => t.primary === false);
        const renderTarget = (t, isPrimary) => {
          const folder = t.path.substring(0, t.path.lastIndexOf('/')) || '/';
          return (
            '<div style="margin:8px 0;padding:6px 10px;border:1px solid ' +
            (isPrimary ? 'rgba(16,185,129,0.4)' : 'rgba(107,114,128,0.3)') +
            ';border-radius:6px;">' +
            '<div style="font-size:0.75em;color:#6b7280;margin-bottom:2px;">' +
            (isPrimary ? '<strong style="color:var(--accent, #10b981);">PRIMARY</strong>' : 'Optional') +
            '</div>' +
            '<code style="font-size:0.85em;word-break:break-all;">' + this._esc(t.path) + '</code>' +
            '<div style="font-size:0.8em;color:#6b7280;margin-top:4px;">' + this._esc(t.why) + '</div>' +
            '<div style="font-size:0.75em;color:#6b7280;margin-top:4px;">Finder shortcut: ⌘⇧G → <code>' + this._esc(folder) + '</code></div>' +
            '</div>'
          );
        };
        if (primary.length || secondary.length) {
          parts.push('<strong>Grant Full Disk Access to:</strong>');
          primary.forEach(t => parts.push(renderTarget(t, true)));
          secondary.forEach(t => parts.push(renderTarget(t, false)));
        }
        parts.push(
          '<small><em>Drag-and-drop tip:</em> macOS Sequoia/Sonoma often refuses to select bundled binaries via the + button. ' +
          'In Finder, ⌘⇧G to the folder above, then drag the target onto the FDA list. ⌘⇧. shows hidden folders.</small>'
        );
        return parts.join('');
      };
      const fdaHint = buildFdaHint();
      const fdaRow = document.createElement('div');
      fdaRow.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:6px 0;';
      const fdaLeft = document.createElement('span');
      fdaLeft.innerHTML = '<strong>Full Disk Access:</strong>';
      const fdaRight = document.createElement('span');
      const fdaColor = p.fullDiskAccess === 'granted' ? 'var(--accent, #10b981)' : '#dc2626';
      fdaRight.style.cssText = `color:${fdaColor};font-weight:600;`;
      fdaRight.textContent = p.fullDiskAccess;
      fdaRow.appendChild(fdaLeft);
      fdaRow.appendChild(fdaRight);
      const fdaHintEl = document.createElement('div');
      fdaHintEl.className = 'channels-qr-hint';
      fdaHintEl.style.cssText = 'font-size:0.85em;color:#6b7280;margin-top:-4px;margin-bottom:6px;';
      fdaHintEl.innerHTML = fdaHint;
      wrap.appendChild(fdaRow);
      wrap.appendChild(fdaHintEl);

      row('Automation → Messages', p.automationMessages,
        'Unknown until first outbound send. macOS will prompt automatically.');

      const row2 = document.createElement('div');
      row2.style.cssText = 'display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;';

      // When both gates are green, show Start inline right in the permissions
      // panel. This is the terminal action for setup — no need to scroll or
      // hunt for the card-level Start button. Automation status stays 'unknown'
      // until first send, which is fine: reading doesn't need Automation.
      const readyToStart = p.fullDiskAccess === 'granted' && p.chatDbExists;
      // Look up whether the channel is already running so we don't show Start
      // on top of a running process.
      const imessageStatus = (this.statuses || []).find(s => s.channel === 'imessage');
      const alreadyRunning = this.standalone?.channels?.includes?.('imessage') ||
                             !!(imessageStatus && imessageStatus.connected);
      if (readyToStart && !alreadyRunning) {
        const startHere = document.createElement('button');
        startHere.className = 'btn btn-primary';
        startHere.textContent = '🚀 Start iMessage';
        startHere.title = 'Permissions look good — start the iMessage channel now.';
        startHere.addEventListener('click', async () => {
          startHere.disabled = true;
          startHere.textContent = 'Starting…';
          try {
            const r = await API.post('/api/channels/standalone/start', { channels: ['imessage'] });
            Components.toast(r.message || 'iMessage channel starting…', 'success');
            // Give the channel ~1.2s to spawn, then re-render the channels
            // view. Next time this modal opens (either because the user
            // re-opens it or because the view re-renders while open), the
            // wizard will see `standaloneRunning` is true and auto-advance
            // to step 3 (Approve Automation), the card-level Disconnect
            // button will appear, and this Start button is replaced by the
            // "Running" badge above.
            setTimeout(() => {
              const route = location.hash;
              this.render(document.querySelector('main') || document.body);
              if (route.startsWith('#/messaging')) location.hash = route;
            }, 1200);
          } catch (e) {
            const raw = (e.message || e) + '';
            let msg = raw;
            try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
            Components.toast(msg, 'error');
            startHere.disabled = false;
            startHere.textContent = '🚀 Start iMessage';
          }
        });
        row2.appendChild(startHere);
      } else if (alreadyRunning) {
        const runningBadge = document.createElement('span');
        runningBadge.style.cssText = 'display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:6px;background:rgba(16,185,129,0.12);color:var(--accent, #10b981);font-weight:600;';
        runningBadge.innerHTML = '● Running — iMessage channel is live';
        row2.appendChild(runningBadge);
      }

      const openBtn = document.createElement('button');
      openBtn.className = readyToStart ? 'btn btn-secondary' : 'btn btn-primary';
      openBtn.textContent = 'Open System Settings';
      openBtn.addEventListener('click', () => { location.href = p.settingsUrl || 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles'; });
      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'btn btn-secondary';
      refreshBtn.textContent = 'Re-check';
      refreshBtn.addEventListener('click', () => this._loadIMessagePanel(mainEl.replaceChild(document.createElement('div'), wrap) && mainEl));
      // "Test FDA now" — forks a fresh child node process to probe chat.db
      // without needing a service restart. Lets the user verify a grant
      // immediately after toggling it in System Settings.
      const testBtn = document.createElement('button');
      testBtn.className = 'btn btn-secondary';
      testBtn.textContent = 'Test FDA now';
      testBtn.title = 'Forks a fresh child process to test FDA without restarting services.';
      testBtn.addEventListener('click', async () => {
        testBtn.disabled = true;
        const orig = testBtn.textContent;
        testBtn.textContent = 'Testing…';
        try {
          const r = await API.post('/api/channels/imessage/permissions/test', {});
          if (r.ok) {
            Components.toast('FDA test passed — fresh process can read chat.db. Refreshing…', 'success');
            setTimeout(() => this._loadIMessagePanel(mainEl.replaceChild(document.createElement('div'), wrap) && mainEl), 600);
          } else {
            const detail = r.errno ? ' (' + r.errno + ')' : '';
            const ctx = r.context ? ' [context: ' + r.context + ']' : '';
            Components.toast('FDA test failed' + detail + ctx + ' — see panel below for next steps.', 'error');
          }
        } catch (e) {
          Components.toast('Test endpoint error: ' + (e.message || e), 'error');
        } finally {
          testBtn.disabled = false;
          testBtn.textContent = orig;
        }
      });
      row2.appendChild(openBtn);
      row2.appendChild(testBtn);
      row2.appendChild(refreshBtn);
      wrap.appendChild(row2);
    } catch (e) {
      wrap.innerHTML = `<div class="channels-qr-muted">Could not probe permissions: ${this._esc?.(e.message) || 'unknown error'}</div>`;
    }
  },

  /** iMessage allowed senders — list, mode toggle, add/remove, top-senders import. */
  async _loadIMessageAllowlist(mainEl) {
    return this._loadChannelAllowlist(mainEl, 'imessage', {
      channelLabel: 'iMessage',
      idPlaceholder: 'Phone (+15551234567) or email',
      modeText: '<strong>Only reply to messages from allowed senders.</strong> When off, Vodou listens to every inbound iMessage.',
      emptyText:
        '<strong>Who should Vodou answer for you?</strong> Add their phone (with country code) or email.<br><br>' +
        '<strong>Quick self-test:</strong> add <em>your own</em> number and text yourself from Messages (New Message → your number → send). Vodou replies in the same thread. Apple lets you message your own number — simplest way to smoke-test without involving anyone else.<br><br>' +
        'Or click <em>Import top senders</em> to one-click pick from your most-frequent contacts.',
      importButtonLabel: 'Import top senders from Messages',
      importUrl: '/api/channels/imessage/allowlist/top?limit=20',
    });
  },

  /**
   * Generic Apple-style allowlist panel. Used by iMessage, WhatsApp, Slack,
   * Discord, Telegram, Microsoft Teams, and Google Chat — the on-disk format
   * + gateway endpoints are identical; only placeholder copy and optional
   * top-senders import differ.
   */
  async _loadChannelAllowlist(mainEl, channel, opts) {
    opts = opts || {};
    const channelLabel = opts.channelLabel || channel;
    const idPlaceholder = opts.idPlaceholder || 'Sender ID';
    const modeText = opts.modeText ||
      `<strong>Only read messages from allowed senders below.</strong> When off, Vodou forwards every incoming ${channelLabel} message.`;
    const emptyText = opts.emptyText || 'No allowed senders yet. Add one below.';
    const importUrl = opts.importUrl || null;
    const importButtonLabel = opts.importButtonLabel || 'Import recent senders';

    const wrap = document.createElement('div');
    wrap.className = 'channels-qr-wrap';
    wrap.innerHTML = '<div class="channels-qr-muted">Loading…</div>';
    mainEl.appendChild(wrap);

    const render = async () => {
      let cfg;
      try {
        cfg = await API.get(`/api/channels/${channel}/allowlist`);
      } catch (e) {
        wrap.innerHTML = `<div class="channels-qr-muted">Could not load allowlist.</div>`;
        return;
      }
      wrap.innerHTML = '';

      // Mode toggle
      const modeWrap = document.createElement('div');
      modeWrap.style.cssText = 'margin-bottom:10px;';
      const modeLabel = document.createElement('label');
      modeLabel.style.cssText = 'display:flex;align-items:center;gap:8px;cursor:pointer;';
      const modeCheck = document.createElement('input');
      modeCheck.type = 'checkbox';
      modeCheck.checked = cfg.mode === 'on';
      modeCheck.addEventListener('change', async () => {
        try {
          await API.post(`/api/channels/${channel}/allowlist/mode`, { mode: modeCheck.checked ? 'on' : 'off' });
          render();
        } catch (e) {
          modeCheck.checked = !modeCheck.checked;
          Components.toast('Failed to save: ' + (e.message || e), 'error');
        }
      });
      const modeTextSpan = document.createElement('span');
      modeTextSpan.innerHTML = modeText;
      modeLabel.appendChild(modeCheck);
      modeLabel.appendChild(modeTextSpan);
      modeWrap.appendChild(modeLabel);
      wrap.appendChild(modeWrap);

      // Sender list
      if (cfg.senders && cfg.senders.length > 0) {
        const list = document.createElement('div');
        list.style.cssText = 'margin-bottom:10px;';
        for (const s of cfg.senders) {
          const r = document.createElement('div');
          r.style.cssText = 'display:flex;justify-content:space-between;align-items:center;padding:4px 0;border-bottom:1px solid rgba(255,255,255,0.06);';
          const left = document.createElement('span');
          left.innerHTML = `<code>${this._esc(s.id)}</code>${s.name ? ' — ' + this._esc(s.name) : ''}`;
          const rem = document.createElement('button');
          rem.className = 'btn btn-secondary';
          rem.style.cssText = 'padding:2px 8px;font-size:0.85em;';
          rem.textContent = 'Remove';
          rem.addEventListener('click', async () => {
            try {
              await API.post(`/api/channels/${channel}/allowlist/remove`, { id: s.id });
              render();
            } catch (e) { Components.toast('Remove failed: ' + (e.message || e), 'error'); }
          });
          r.appendChild(left);
          r.appendChild(rem);
          list.appendChild(r);
        }
        wrap.appendChild(list);
      } else {
        const empty = document.createElement('div');
        empty.className = 'channels-qr-muted';
        empty.style.cssText = 'margin-bottom:10px;';
        // emptyText contains <strong>/<em> markup — render as HTML, not plain text.
        // Safe: this string is hardcoded in ALLOWLIST_CONFIGS, not user input.
        empty.innerHTML = emptyText;
        wrap.appendChild(empty);
      }

      // Add sender form
      const addWrap = document.createElement('div');
      addWrap.style.cssText = 'display:flex;gap:6px;margin-bottom:10px;';
      const idIn = document.createElement('input');
      idIn.placeholder = idPlaceholder;
      idIn.className = 'settings-input';
      idIn.style.cssText = 'flex:1;';
      const nameIn = document.createElement('input');
      nameIn.placeholder = 'Display name (optional)';
      nameIn.className = 'settings-input';
      nameIn.style.cssText = 'flex:1;';
      const addBtn = document.createElement('button');
      addBtn.className = 'btn btn-primary';
      addBtn.textContent = 'Add';
      addBtn.addEventListener('click', async () => {
        const id = idIn.value.trim();
        if (!id) return;
        try {
          await API.post(`/api/channels/${channel}/allowlist/add`, { id, name: nameIn.value.trim() || undefined });
          idIn.value = ''; nameIn.value = '';
          render();
        } catch (e) { Components.toast('Add failed: ' + (e.message || e), 'error'); }
      });
      addWrap.appendChild(idIn);
      addWrap.appendChild(nameIn);
      addWrap.appendChild(addBtn);
      wrap.appendChild(addWrap);

      // Optional top-senders import (iMessage-only today; opt-in per channel)
      if (importUrl) {
        const importBtn = document.createElement('button');
        importBtn.className = 'btn btn-secondary';
        importBtn.textContent = importButtonLabel;
        importBtn.addEventListener('click', async () => {
          importBtn.disabled = true;
          importBtn.textContent = 'Loading…';
          try {
            const { senders } = await API.get(importUrl);
            if (!senders || senders.length === 0) {
              Components.toast('No recent senders found.', 'warn');
              return;
            }
            this._showImportPicker(senders, channel, () => render());
          } catch (e) {
            Components.toast('Import failed: ' + (e.message || e), 'error');
          } finally {
            importBtn.disabled = false;
            importBtn.textContent = importButtonLabel;
          }
        });
        wrap.appendChild(importBtn);
      }
    };

    render();
  },

  /** Modal picker for top-sender import. Shows checkboxes for N senders. */
  _showImportPicker(senders, channel, onDone) {
    // Back-compat: old call signature was (senders, onDone) with channel
    // assumed to be imessage. Detect and coerce.
    if (typeof channel === 'function' && onDone === undefined) {
      onDone = channel;
      channel = 'imessage';
    }
    const iconHtml = (CHANNEL_ICONS && CHANNEL_ICONS[channel]) || CHANNEL_ICONS.imessage;
    const label = channel.charAt(0).toUpperCase() + channel.slice(1);
    const sheet = Components.openModal({
      iconHtml,
      title: `Import ${label} contacts`,
      subtitle: `Top ${senders.length} senders from the last 6 months`,
    });
    const picks = new Set();
    const list = document.createElement('div');
    list.style.cssText = 'max-height:400px;overflow-y:auto;padding:6px 0;';
    for (const s of senders) {
      const row = document.createElement('label');
      row.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 0;cursor:pointer;border-bottom:1px solid rgba(255,255,255,0.06);';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.addEventListener('change', () => {
        if (cb.checked) picks.add(s.sender_id); else picks.delete(s.sender_id);
      });
      const info = document.createElement('span');
      info.innerHTML = `<code>${this._esc(s.sender_id)}</code> <span style="color:#6b7280">— ${s.n} messages</span>`;
      row.appendChild(cb);
      row.appendChild(info);
      list.appendChild(row);
    }
    sheet.body.appendChild(list);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;';
    const cancel = document.createElement('button');
    cancel.className = 'btn btn-secondary';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => sheet.close());
    const confirm = document.createElement('button');
    confirm.className = 'btn btn-primary';
    confirm.textContent = 'Add selected';
    confirm.addEventListener('click', async () => {
      confirm.disabled = true;
      for (const id of picks) {
        try { await API.post(`/api/channels/${channel}/allowlist/add`, { id }); } catch {}
      }
      sheet.close();
      onDone?.();
    });
    actions.appendChild(cancel);
    actions.appendChild(confirm);
    sheet.body.appendChild(actions);
  },

  _buildSetupWizard(type, meta, container) {
    const wizard = document.createElement('div');
    wizard.className = 'setup-wizard';
    wizard.classList.add('channels-wizard');

    const title = document.createElement('div');
    title.className = 'channels-wizard-title';
    title.textContent = meta.label + ' settings';
    wizard.appendChild(title);

    const steps = meta.setup;
    let currentStep = 0;
    const pendingCreds = {};

    // iMessage: auto-advance the wizard based on live state.
    //   - Channel already running  → jump to step 3 (Approve Automation)
    //     because Start is done + Disconnect lives on the card/panel now.
    //   - FDA granted, not running → jump to step 2 (Start iMessage)
    //   - Neither                   → stay on step 1 (Grant FDA)
    // Completed steps collapse to their "done" state automatically.
    if (type === 'imessage') {
      const imessageStatus = (this.statuses || []).find(s => s.channel === 'imessage');
      const alreadyRunning = this.standalone?.channels?.includes?.('imessage') ||
                             !!(imessageStatus && imessageStatus.connected);
      if (alreadyRunning) {
        currentStep = 2; // "Approve Messages automation" — Start is behind us
      } else {
        API.get('/api/channels/imessage/permissions').then(p => {
          if (p && p.fullDiskAccess === 'granted' && p.chatDbExists) {
            if (currentStep === 0) {
              currentStep = 1;
              renderStep();
            }
          }
        }).catch(() => { /* leave on step 1 */ });
      }
    }

    const renderStep = () => {
      const old = wizard.querySelector('.wizard-steps');
      if (old) old.remove();
      const sc = document.createElement('div');
      sc.className = 'wizard-steps';

      for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const isActive = i === currentStep;
        const isDone = i < currentStep;

        const row = document.createElement('div');
        row.className = 'channels-wizard-step-row';
        row.classList.add(isDone ? 'is-done' : isActive ? 'is-active' : 'is-pending');
        row.classList.add(i < steps.length - 1 ? 'channels-wizard-step-row-gap' : 'channels-wizard-step-row-last');

        const num = document.createElement('div');
        num.className = 'channels-wizard-step-num';
        num.classList.add(isDone ? 'is-done' : isActive ? 'is-active' : 'is-pending');
        num.textContent = isDone ? '\u2713' : (i + 1);
        row.appendChild(num);

        const content = document.createElement('div');
        content.className = 'channels-wizard-step-content';

        const stepTitle = document.createElement('div');
        stepTitle.className = 'channels-wizard-step-title';
        stepTitle.textContent = step.title;
        content.appendChild(stepTitle);

        if (isActive) {
          const desc = document.createElement('div');
          desc.className = 'channels-wizard-step-desc';
          desc.innerHTML = step.instructions;
          content.appendChild(desc);

          if (step.link) {
            const linkBtn = document.createElement('a');
            linkBtn.href = step.link.url;
            linkBtn.target = '_blank';
            linkBtn.rel = 'noopener';
            linkBtn.className = 'btn btn-secondary';
            linkBtn.classList.add('channels-wizard-link-btn');
            linkBtn.textContent = step.link.label + ' \u2197';
            content.appendChild(linkBtn);
          }

          if (step.field) {
            const fieldWrap = document.createElement('div');
            fieldWrap.className = 'channels-wizard-field-wrap';
            const label = document.createElement('label');
            label.className = 'channels-wizard-field-label';
            label.textContent = step.fieldLabel || step.field;
            const input = document.createElement('input');
            input.type = 'password';
            input.placeholder = step.fieldLabel || step.field;
            input.className = 'settings-input channels-wizard-field-input';
            input.value = pendingCreds[step.field] || '';
            input.addEventListener('input', () => { pendingCreds[step.field] = input.value; });
            fieldWrap.appendChild(label);
            fieldWrap.appendChild(input);
            content.appendChild(fieldWrap);
          }

          const btnRow = document.createElement('div');
          btnRow.className = 'channels-wizard-btn-row';

          // Open Full Disk Access pane in System Settings (iMessage step 1)
          if (step.action === 'open-fda-settings') {
            const openBtn = document.createElement('button');
            openBtn.className = 'btn btn-primary channels-wizard-btn-primary';
            openBtn.textContent = 'Open System Settings';
            openBtn.addEventListener('click', () => {
              // macOS URL scheme: opens directly to Privacy & Security → Full Disk Access
              location.href = 'x-apple.systempreferences:com.apple.preference.security?Privacy_AllFiles';
            });
            btnRow.appendChild(openBtn);

            const refreshBtn = document.createElement('button');
            refreshBtn.className = 'btn btn-secondary';
            refreshBtn.textContent = 'Re-check permission';
            refreshBtn.addEventListener('click', async () => {
              try {
                const p = await API.get('/api/channels/imessage/permissions');
                if (p.fullDiskAccess === 'granted') {
                  Components.toast('Full Disk Access granted — continue to next step.', 'success');
                } else {
                  Components.toast('Still not granted. Check System Settings and toggle ON, then try again.', 'warn');
                }
              } catch (e) {
                Components.toast('Could not probe permission: ' + (e.message || e), 'error');
              }
            });
            btnRow.appendChild(refreshBtn);
          }

          if (step.action === 'start') {
            const startBtn = document.createElement('button');
            startBtn.className = 'btn btn-primary channels-wizard-btn-primary';
            startBtn.textContent = 'Start ' + meta.label;
            startBtn.addEventListener('click', async () => {
              startBtn.disabled = true;
              startBtn.textContent = 'Saving...';
              if (Object.keys(pendingCreds).length > 0) {
                try {
                  await API.post('/api/channels/credentials', { channel: type, credentials: pendingCreds });
                } catch (e) {
                  Components.toast('Failed to save: ' + (e.message || e), 'error');
                  startBtn.disabled = false;
                  startBtn.textContent = 'Start ' + meta.label;
                  return;
                }
              }
              startBtn.textContent = 'Starting...';
              try {
                const r = await API.post('/api/channels/standalone/start', { channels: [type] });
                Components.toast(r.message || meta.label + ' started', 'success');
                await this.render(container);
              } catch (e) {
                const raw = (e.message || e) + '';
                let msg = raw;
                try { const j = JSON.parse(raw); if (j && typeof j.error === 'string') msg = j.error; } catch (_) {}
                Components.toast(msg, 'error');
              }
              startBtn.disabled = false;
              startBtn.textContent = 'Start ' + meta.label;
            });
            btnRow.appendChild(startBtn);
          }

          if (!step.action && i < steps.length - 1) {
            const nextBtn = document.createElement('button');
            nextBtn.className = 'btn btn-primary channels-wizard-btn-primary';
            nextBtn.textContent = (step.field && !step.optional) ? 'Save & Next' : 'Next';
            nextBtn.addEventListener('click', async () => {
              if (step.field && pendingCreds[step.field]) {
                try {
                  await API.post('/api/channels/credentials', { channel: type, credentials: { [step.field]: pendingCreds[step.field] } });
                  Components.toast('Saved ' + (step.fieldLabel || step.field), 'success');
                } catch (e) {
                  Components.toast('Save failed: ' + (e.message || e), 'error');
                  return;
                }
              }
              currentStep++;
              renderStep();
            });
            btnRow.appendChild(nextBtn);
          }

          if (step.optional && i < steps.length - 1) {
            const skipBtn = document.createElement('button');
            skipBtn.className = 'btn btn-secondary channels-wizard-btn-secondary';
            skipBtn.textContent = 'Skip';
            skipBtn.addEventListener('click', () => { currentStep++; renderStep(); });
            btnRow.appendChild(skipBtn);
          }

          if (i > 0) {
            const backBtn = document.createElement('button');
            backBtn.className = 'btn btn-secondary channels-wizard-btn-secondary';
            backBtn.textContent = 'Back';
            backBtn.addEventListener('click', () => { currentStep--; renderStep(); });
            btnRow.appendChild(backBtn);
          }

          if (btnRow.children.length > 0) content.appendChild(btnRow);
        }

        row.appendChild(content);
        sc.appendChild(row);
      }
      wizard.appendChild(sc);
    };

    renderStep();
    return wizard;
  },

  _credentialPanel(channel) {
    const wrap = document.createElement('div');
    wrap.className = 'channels-card-creds';
    wrap.dataset.channel = channel;

    const channelMeta = {
      telegram: { setupUrl: 'https://core.telegram.org/bots#botfather', setupLabel: 'Create bot with @BotFather' },
      slack: { setupUrl: 'https://api.slack.com/apps', setupLabel: 'Create app at api.slack.com' },
      discord: { setupUrl: 'https://discord.com/developers/applications', setupLabel: 'Discord Developer Portal' },
      teams: { setupUrl: 'https://portal.azure.com/#create/Microsoft.AzureBot', setupLabel: 'Azure Portal — create Azure Bot' },
      googlechat: { setupUrl: 'https://console.cloud.google.com/apis/library/chat.googleapis.com', setupLabel: 'Google Cloud — Chat API' },
      signal: { setupUrl: 'https://github.com/AsamK/signal-cli', setupLabel: 'signal-cli — install & register' },
      whatsapp: {
        // Old path (/general/download-and-installation/...) 404s — WhatsApp
        // restructured their FAQ to numeric article IDs. This ID points to
        // "About Linked Devices" which has been stable. If it ever 404s
        // again, fall back to the domain root: https://faq.whatsapp.com/
        setupUrl: 'https://faq.whatsapp.com/1317564962315842',
        setupLabel: 'WhatsApp — link a device',
      },
    };
    const meta = channelMeta[channel];
    if (!meta) return wrap;
    const channelCreds = this.creds[channel] || {};
    const hasAnyCred = Object.values(channelCreds).some(c => c && c.masked);
    const statusClass = hasAnyCred ? 'status-configured' : 'status-unconfigured';

    const inner = document.createElement('div');
    inner.className = 'provider-card';
    inner.classList.add('channels-provider-card');

    // Tokens render with the saved value pre-populated — user can SEE what's
    // configured AND edit in place. Default to type="text" since we fetched
    // with ?reveal=1; the "Hide" toggle switches to type="password" for
    // screen-share situations. Helper text below shows the masked form as a
    // visual "last saved" confirmation.
    const fieldsHtml = Object.entries(channelCreds).length
      ? Object.entries(channelCreds)
          .map(
            ([key, info]) => {
              const rawValue = (info.value && info.value !== info.masked) ? info.value : (info.value || '');
              const hasSaved = !!(info.masked && info.masked !== '');
              return `
            <div class="provider-field">
              <label>${info.label}</label>
              <div class="provider-field-input-row" style="display:flex;gap:6px;align-items:center;">
                <input type="text" id="cred-${channel}-${key}" placeholder="${info.label}" value="${this._esc(rawValue)}" class="settings-input" autocomplete="off" spellcheck="false" style="flex:1;">
                <button type="button" class="btn btn-secondary btn-sm" onclick="ChannelsView._toggleCredVisibility('cred-${channel}-${key}', this)" style="padding:4px 10px;font-size:11px;">Hide</button>
              </div>
              <small class="text-muted-color">${hasSaved ? 'Saved · ' + this._esc(info.masked) : 'Not set'}</small>
            </div>
          `;
            }
          )
          .join('')
      : `<div class="channels-creds-empty">No credential fields returned. Open Settings on this card or check the messaging service.</div>`;

    inner.innerHTML = `
      <div class="provider-header channels-provider-header" onclick="this.parentElement.classList.toggle('expanded')">
        <div class="provider-radio"><span class="status-dot ${statusClass}"></span></div>
        <div class="provider-info">
          <div class="provider-name">Tokens ${hasAnyCred ? '<span class="provider-status-badge status-configured">Configured</span>' : ''}</div>
          <div class="provider-desc"><a href="${meta.setupUrl}" target="_blank" rel="noopener" class="provider-key-link">${meta.setupLabel} ↗</a></div>
        </div>
      </div>
      <div class="provider-body" id="cred-body-${channel}">
        ${fieldsHtml}
        <div class="provider-actions">
          <button type="button" class="btn btn-primary" onclick="ChannelsView._saveCredentials('${channel}')">Save</button>
        </div>
      </div>
    `;
    wrap.appendChild(inner);
    const pi = inner.querySelector('.provider-info');
    if (pi) pi.classList.add('channels-provider-info');
    return wrap;
  },

  async _testChannel(channel) {
    const resultEl = document.getElementById('cred-test-' + channel);
    if (!resultEl) return;
    resultEl.innerHTML = '<span class="text-muted-color text-sm">Testing...</span>';

    try {
      const result = await API.post('/api/channels/credentials/test', { channel });
      if (result.success) {
        resultEl.innerHTML = `<span class="status-ok-text">Connected! ${result.info || ''}</span>`;
      } else {
        resultEl.innerHTML = `<span class="status-error-text">Failed: ${result.error}</span>`;
      }
    } catch (err) {
      resultEl.innerHTML = `<span class="status-error-text">Error: ${err.message}</span>`;
    }
  },

  async _saveCredentials(channel) {
    const card = document.querySelector(`[data-channel="${channel}"]`);
    const btn = card?.querySelector('.btn-primary');
    if (btn) { btn.textContent = 'Saving...'; btn.disabled = true; }

    const inputs = card?.querySelectorAll(`input[id^="cred-${channel}-"]`) || [];
    const credentials = {};
    for (const input of inputs) {
      if (input.value) {
        // Extract key name from id: cred-telegram-TELEGRAM_BOT_TOKEN → TELEGRAM_BOT_TOKEN
        const key = input.id.replace('cred-' + channel + '-', '');
        credentials[key] = input.value;
      }
    }

    if (Object.keys(credentials).length === 0) {
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
      const resultEl = document.getElementById('cred-test-' + channel);
      if (resultEl) resultEl.innerHTML = '<span class="status-warn-text">Enter at least one credential</span>';
      return;
    }

    try {
      await API.post('/api/channels/credentials', { channel, credentials });
      if (btn) { btn.textContent = 'Saved!'; btn.className = 'btn btn-success'; }
      setTimeout(() => {
        if (btn) { btn.textContent = 'Save'; btn.className = 'btn btn-primary'; btn.disabled = false; }
      }, 1500);
    } catch (err) {
      if (btn) { btn.textContent = 'Save'; btn.disabled = false; }
      const resultEl = document.getElementById('cred-test-' + channel);
      if (resultEl) resultEl.innerHTML = `<span class="status-error-text">Save failed: ${err.message}</span>`;
    }
  },

  _voicePanel() {
    const wrap = document.createElement('div');
    wrap.className = 'channels-voice-panel';
    const sub = document.createElement('div');
    sub.className = 'channels-voice-sub';
    sub.textContent = 'Text-to-speech on this machine';
    wrap.appendChild(sub);
    const row = document.createElement('div');
    row.className = 'flex-center flex-wrap gap-2';
    const input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'Text to speak...';
    input.id = 'channels-voice-input';
    input.className = 'channels-voice-input';
    const speakBtn = document.createElement('button');
    speakBtn.className = 'btn btn-primary';
    speakBtn.textContent = 'Speak';
    speakBtn.addEventListener('click', async () => {
      const text = input.value.trim();
      if (!text) { Components.toast('Enter text to speak', 'error'); return; }
      speakBtn.disabled = true;
      try {
        await API.post('/api/channels/voice/speak', { text });
        Components.toast('Speaking...', 'success');
      } catch (e) {
        Components.toast((e.message || e) + '', 'error');
      }
      speakBtn.disabled = false;
    });
    const stopBtn = document.createElement('button');
    stopBtn.className = 'btn btn-secondary';
    stopBtn.textContent = 'Stop';
    stopBtn.addEventListener('click', async () => {
      try {
        await API.post('/api/channels/voice/stop');
        Components.toast('Stopped', 'success');
      } catch (e) {
        Components.toast((e.message || e) + '', 'error');
      }
    });
    row.appendChild(input);
    row.appendChild(speakBtn);
    row.appendChild(stopBtn);
    wrap.appendChild(row);
    return wrap;
  },

  _updateBadge() {
    const st = this.standalone || { running: false, channels: [] };
    const connected = this.statuses.filter((s) => this._effectiveChannelConnected(s.channel, s, st)).length;
    const total = CHANNELS_SIDEBAR_ORDER.length;
    const el = document.getElementById('count-messaging');
    if (el) el.textContent = `${connected}/${total}`;
  },

  /** Public accessor so other modules (scope adapters, chat tabs) can read
   *  per-channel icon HTML without re-importing the CHANNEL_META constant. */
  getIconHtml(channel) {
    const meta = CHANNEL_META[channel];
    return meta ? meta.icon : '';
  },

  /** Public accessor for the display label. */
  getLabel(channel) {
    const meta = CHANNEL_META[channel];
    return meta ? meta.label : channel;
  },

  // ── Sidebar wiring — mirrors apps.js renderSidebarApps.
  // One nav item per connected channel. Click routes to chat view with that
  // channel's conversation tab. Gear button opens the channel details modal.

  async _refreshSidebar() {
    try {
      const [statusRes, standaloneRes] = await Promise.all([
        API.get('/api/channels/status').catch(() => ({ statuses: [] })),
        API.get('/api/channels/standalone/status').catch(() => ({ running: false, perChannel: {} })),
      ]);
      this._lastStatuses = statusRes.statuses || [];
      this._lastStandalone = {
        running: !!(standaloneRes && standaloneRes.running),
        channels: (standaloneRes && standaloneRes.channels) || [],
        perChannel: (standaloneRes && standaloneRes.perChannel) || {},
      };
      this.renderSidebarChannels(this._lastStatuses, this._lastStandalone);
    } catch {}
  },

  renderSidebarChannels(statuses, standalone) {
    const container = document.getElementById('nav-messaging-items');
    if (!container) return;
    const st = standalone || { running: false, channels: [], perChannel: {} };
    const merged = CHANNELS_SIDEBAR_ORDER.map((channel) => {
      const row = (statuses || []).find((s) => s.channel === channel);
      return row ? { ...row } : { channel, connected: false, error: null };
    });
    const eff = (s) => this._effectiveChannelConnected(s.channel, s, st);
    const connected = merged.filter((s) => eff(s));
    const disconnected = merged.filter((s) => !eff(s));

    // Highlight the row that matches #/chat?channel=X (main chat + channel tab).
    const hash = location.hash || '';
    const pathOnly = hash.split('?')[0];
    const qs = hash.indexOf('?') >= 0 ? hash.slice(hash.indexOf('?') + 1) : '';
    const urlParams = new URLSearchParams(qs);
    const activeChannel = urlParams.get('channel');
    const isWorkbench = !!activeChannel && pathOnly === '#/chat';

    const gearSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

    const connHtml = connected.map((s) => {
      const meta = CHANNEL_META[s.channel];
      if (!meta) return '';
      const label = this._esc(meta.label || s.channel);
      const isActive = s.channel === activeChannel && isWorkbench ? ' active' : '';
      return `<a class="nav-item nav-item-channel${isActive}" href="#/chat?channel=${s.channel}"
                data-channel="${s.channel}"
                title="Open ${label} conversation">
                <span class="nav-channel-icon">${meta.icon || ''}</span>
                <span>${label}</span>
                <button type="button" class="nav-item-gear" data-channel="${s.channel}" title="Manage ${label}" aria-label="Manage ${label}">${gearSvg}</button>
              </a>`;
    }).join('');

    const discHtml = disconnected.length
      ? `<details class="nav-apps-more">
        <summary class="nav-apps-more-summary">Not connected (${disconnected.length})</summary>
        <div class="nav-apps-more-list">
          ${disconnected.map((s) => {
        const meta = CHANNEL_META[s.channel];
        if (!meta) return '';
        const label = this._esc(meta.label || s.channel);
        return `<div class="nav-app-sidebar-row">
              <button type="button" class="nav-item nav-item-disconnected nav-item-messaging-disconnected" data-channel="${s.channel}" title="Open Messaging to connect ${label}">
                <span class="nav-channel-icon">${meta.icon || ''}</span>
                <span class="nav-app-name">${label}</span>
                <span class="nav-app-plus" aria-hidden="true">+</span>
              </button>
              <button type="button" class="nav-item-gear" data-channel="${s.channel}" title="Setup ${label}" aria-label="Setup ${label}">${gearSvg}</button>
            </div>`;
      }).join('')}
        </div>
      </details>`
      : '';

    container.innerHTML = connHtml + discHtml;
    this._ensureNavMessagingDelegation();
  },

  /** One delegated click handler on #nav-messaging (survives innerHTML refreshes). */
  _ensureNavMessagingDelegation() {
    const wrap = document.getElementById('nav-messaging');
    if (!wrap || wrap.dataset.chNavDelegated === '1') return;
    wrap.dataset.chNavDelegated = '1';
    wrap.addEventListener('click', (ev) => {
      const items = document.getElementById('nav-messaging-items');
      if (!items || !items.contains(ev.target)) return;
      const gear = ev.target.closest && ev.target.closest('.nav-item-gear[data-channel]');
      if (gear) {
        ev.preventDefault();
        ev.stopPropagation();
        const channel = gear.dataset.channel;
        if (channel) this._openModalByChannel(channel);
        return;
      }
      const disc = ev.target.closest && ev.target.closest('.nav-item-messaging-disconnected[data-channel]');
      if (disc) {
        ev.preventDefault();
        ev.stopPropagation();
        location.hash = '#/messaging';
      }
    });
  },

  /** Open the channel details modal given just a channel type (used by the gear
   *  button in the sidebar — we don't have the usual render-time state handy). */
  async _openModalByChannel(type) {
    const meta = CHANNEL_META[type];
    if (!meta) return;
    try {
      const [statusRes, standaloneRes, credsRes] = await Promise.all([
        API.get('/api/channels/status').catch(() => ({ statuses: [] })),
        API.get('/api/channels/standalone/status').catch(() => ({ running: false })),
        API.get('/api/channels/credentials?reveal=1').catch(() => ({ channels: {} })),
      ]);
      this.creds = credsRes.channels || this.creds || {};
      const statuses = statusRes.statuses || [];
      const status = statuses.find(s => s.channel === type) || { channel: type, connected: false };
      const st = {
        running: !!(standaloneRes && standaloneRes.running),
        channels: (standaloneRes && standaloneRes.channels) || [],
        perChannel: (standaloneRes && standaloneRes.perChannel) || {},
      };
      const effectiveConnected = this._effectiveChannelConnected(type, status, st);
      const mainContent = document.getElementById('main-content') || document.body;
      this._openChannelModal(type, meta, status, effectiveConnected, st.running, mainContent);
    } catch (e) {
      if (window.Components && Components.toast) {
        Components.toast('Could not open channel: ' + (e.message || e), 'error');
      }
    }
  },

  /** Render the Community Channels section (dynamic packages from ~/.vodou/channels/). */
  async _renderCommunitySection(container) {
    const OFFICIAL = new Set(['telegram','slack','discord','whatsapp','imessage','teams','googlechat','signal','voice','web']);
    let installed = [];
    try {
      const res = await API.get('/api/channels/installed');
      installed = (res.channels || []).filter(c => {
        const name = c.manifest && c.manifest.name;
        return name && !OFFICIAL.has(name);
      });
    } catch { return; }

    const section = document.createElement('div');
    section.className = 'channels-community-section';
    section.style.cssText = 'margin-top:2rem;';

    const heading = document.createElement('div');
    heading.innerHTML = '<h3 style="font-size:1rem;font-weight:600;margin-bottom:0.5rem;">Community Channels</h3>' +
      '<p style="color:var(--text-muted,#888);font-size:0.85rem;margin-bottom:1rem;">Install third-party channel packages from npm. Packages must match <code>@scope/channel-&lt;name&gt;</code>.</p>';
    section.appendChild(heading);

    // Install form
    const form = document.createElement('div');
    form.style.cssText = 'display:flex;gap:0.5rem;margin-bottom:1.25rem;max-width:480px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'form-control';
    input.placeholder = '@community/channel-matrix';
    input.style.flex = '1';
    const installBtn = document.createElement('button');
    installBtn.className = 'btn btn-primary';
    installBtn.textContent = 'Install';
    installBtn.style.whiteSpace = 'nowrap';
    const log = document.createElement('pre');
    log.style.cssText = 'display:none;background:var(--bg-secondary,#1a1a1a);color:var(--text-primary,#eee);font-size:0.78rem;padding:0.75rem;border-radius:6px;max-height:160px;overflow-y:auto;margin-top:0.5rem;white-space:pre-wrap;';

    installBtn.addEventListener('click', async () => {
      const pkg = input.value.trim();
      if (!pkg) return;
      if (!/^@[^/]+\/channel-/.test(pkg)) {
        Components.toast('Package must match @scope/channel-<name>', 'error');
        return;
      }
      installBtn.disabled = true;
      installBtn.textContent = 'Installing…';
      log.style.display = 'block';
      log.textContent = '';
      try {
        const resp = await fetch('/api/channels/install', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (window.__vodouToken || '') },
          body: JSON.stringify({ package: pkg }),
        });
        const reader = resp.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const parts = buf.split('\n\n');
          buf = parts.pop();
          for (const part of parts) {
            if (!part.startsWith('data: ')) continue;
            const raw = part.slice(6).trim();
            try {
              const j = JSON.parse(raw);
              if (j.done) {
                if (j.code === 0) {
                  Components.toast(pkg + ' installed', 'success');
                  await this._renderCommunitySection(container.querySelector('.channels-community-section').parentNode);
                } else {
                  Components.toast('Install failed (code ' + j.code + ')', 'error');
                }
              } else { log.textContent += raw + '\n'; log.scrollTop = log.scrollHeight; }
            } catch { log.textContent += raw + '\n'; log.scrollTop = log.scrollHeight; }
          }
        }
      } catch (e) {
        Components.toast('Install error: ' + (e.message || e), 'error');
      }
      installBtn.disabled = false;
      installBtn.textContent = 'Install';
    });

    form.appendChild(input);
    form.appendChild(installBtn);
    section.appendChild(form);
    section.appendChild(log);

    // Installed community channel cards
    if (installed.length > 0) {
      const grid = document.createElement('div');
      grid.className = 'channel-grid';
      for (const { packageName, manifest } of installed) {
        const card = document.createElement('div');
        card.className = 'channel-card';
        card.style.cssText = 'padding:1rem;border-radius:8px;background:var(--bg-secondary,#1a1a1a);';
        card.innerHTML = `
          <div style="font-weight:600;margin-bottom:0.25rem;">${this._esc(manifest.displayName || manifest.name)}</div>
          <div style="font-size:0.8rem;color:var(--text-muted,#888);margin-bottom:0.5rem;">${this._esc(packageName)} v${this._esc(manifest.version || '')}</div>
          <div style="font-size:0.82rem;color:var(--text-muted,#888);margin-bottom:0.75rem;">${this._esc(manifest.description || '')}</div>
          <button class="btn btn-sm btn-danger" data-pkg="${this._esc(packageName)}">Uninstall</button>`;
        card.querySelector('button').addEventListener('click', async (e) => {
          const pkg = e.currentTarget.dataset.pkg;
          if (!confirm('Uninstall ' + pkg + '?')) return;
          try {
            await API.delete('/api/channels/uninstall', { package: pkg });
            Components.toast(pkg + ' uninstalled', 'success');
            card.remove();
          } catch (err) {
            Components.toast('Uninstall failed: ' + (err.message || err), 'error');
          }
        });
        grid.appendChild(card);
      }
      section.appendChild(grid);
    } else {
      const empty = document.createElement('p');
      empty.style.cssText = 'color:var(--text-muted,#888);font-size:0.85rem;';
      empty.textContent = 'No community channels installed.';
      section.appendChild(empty);
    }

    // Replace existing section if re-rendering, else append
    const existing = container.querySelector('.channels-community-section');
    if (existing) existing.replaceWith(section);
    else container.appendChild(section);
  },
};

window.ChannelsView = ChannelsView;

// Prime the sidebar on page load + re-render on hash changes so the active
// highlight updates when navigating (e.g. #/chat?channel=slack → that row
// gains the `.active` class). Mirrors apps.js _primeSidebar().
function _primeChannelsSidebar() {
  if (!document.getElementById('nav-messaging-items')) return;
  ChannelsView._ensureNavMessagingDelegation();
  ChannelsView._refreshSidebar().catch(() => {});
  window.addEventListener('hashchange', () => {
    if (ChannelsView._lastStatuses) ChannelsView.renderSidebarChannels(ChannelsView._lastStatuses, ChannelsView._lastStandalone);
  });
  // Periodic refresh to catch channel connects/disconnects from other views.
  // Skip when the tab is hidden — no user value, just wasted polling/MCP calls.
  // Bumped from 8s to 12s to further reduce the Vodou-channels.channel_status
  // load that previously triggered a vodou-core spawn storm when the worker
  // socket was dead.
  setInterval(() => {
    if (typeof document !== 'undefined' && document.hidden) return;
    ChannelsView._refreshSidebar().catch(() => {});
  }, 12000);
  // Refresh once immediately when the tab becomes visible again so the user
  // sees fresh state without waiting up to 12s.
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) ChannelsView._refreshSidebar().catch(() => {});
    });
  }
}
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', _primeChannelsSidebar, { once: true });
} else {
  _primeChannelsSidebar();
}
