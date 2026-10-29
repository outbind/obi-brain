<div align="center">

# Obi's brain

**Give your AI agent a sales brain in one line.**

```
npx @outbindai/cli learn yourcompany.com
```

<img src="assets/learn.gif" alt="outbind learn turning a website into brain.md" width="760">

</div>

---

Point it at any company's website. In about 20 seconds you get `brain.md`: who they sell to, the people who buy, the problems they solve, the objections to expect and how they sound.

No account, no API key, no setup.

## Use it from your AI agent

Coding agents and AI assistants can run commands for you, so just ask:

> "Learn my company from acme.com and write me a first email to a dental clinic owner."

The agent runs `outbind learn`, reads `brain.md` and writes from it.

Prefer a chat app? Obi's brain is also an MCP server, so it works inside Claude, ChatGPT, Cursor and any app that speaks MCP. See [Use it over MCP](#use-it-over-mcp).

## Use it over MCP

The same brain runs as a remote MCP server. Connect it once and your assistant can read your brain, remember prospects and write with it in any chat.

```
https://app.outbind.ai/api/mcp
```

Sign-in is OAuth: your app opens Outbind, you sign in (or make a free account) and press Allow. No key to copy. You pick **Read only** or **Can draft and edit**.

### Claude (web, desktop and mobile)

Open [Outbind in Claude's connector directory](https://claude.ai/directory/outbind) and press **Connect**.

Or add it by hand: **Settings → Connectors → Add custom connector**, name it Outbind and paste the URL above. Then turn Outbind on in a chat's tools menu.

### ChatGPT

Open [Plugins](https://chatgpt.com/plugins), press **+** and pick **Add custom MCP server**. Paste the URL, pick OAuth and press **Create**. Then add Outbind from the **+** menu in a chat.

### Claude Code

```
claude mcp add --transport http outbind https://app.outbind.ai/api/mcp
```

Start Claude Code, type `/mcp`, pick `outbind` and choose **Authenticate**.

### Cursor

**Cursor Settings → Tools & MCP → New MCP server**, then add this to `mcp.json`:

```json
{
  "mcpServers": {
    "outbind": { "url": "https://app.outbind.ai/api/mcp" }
  }
}
```

Press **Connect** next to outbind and sign in.

### VS Code

Add this to `.vscode/mcp.json`:

```json
{
  "servers": {
    "outbind": { "type": "http", "url": "https://app.outbind.ai/api/mcp" }
  }
}
```

Press **Start** above the outbind entry and sign in.

### Other apps

Any app that can sign in to MCP servers with OAuth only needs the URL; it finds the sign-in by itself. `npx @outbindai/cli mcp` prints these steps in your terminal.

### MCP tools

All of these are on the free plan, within its limits. Writing happens on Outbind's side, with its own playbook and checks, and comes back as finished text. Nothing is ever sent.

| Tool | What it does |
| --- | --- |
| `get_brain` | Reads what Obi knows about your company: offer, ideal customer, voice and lessons |
| `create_icp` | Builds your ideal customer profile from your website and your own words |
| `save_lesson` | Teaches Obi a sales lesson it uses from the next message on |
| `remember_prospect` | Saves a note about a prospect |
| `recall_prospect` | Everything Obi remembers about a prospect: details, notes, brief, fit and history |
| `research_prospect` | Writes a brief from the prospect's company pages, public posts and news, each point with its source |
| `score_fit` | Scores a prospect against your ideal customer profile: Strong, Good or Weak, with reasons |
| `write_email` | Writes a sales email or follow-up for a prospect |
| `fix_draft` | Rewrites an email you wrote, keeping your point and your facts |
| `sort_reply` | Says what a reply means (interested, meeting, objection, referral, not now, stop, out of office) |
| `answer_reply` | Sorts a reply and writes the answer |
| `write_dm` | Writes a short LinkedIn message or connection note |
| `write_call_script` | Writes a cold call script: opener, questions, objections, close and voicemail |
| `plan_flow` | Plans a multi-step sequence as a written plan you follow |
| `verify_emails` | Checks up to 25 email addresses: Valid, Invalid, Risky or Unknown |
| `add_document` | Teaches the brain from a document you share in the chat |
| `list_documents` | Lists the documents the brain learned from |
| `remove_document` | Removes a document and what Obi learned from it |

With **Read only** access the assistant gets the reading tools (`get_brain`, `recall_prospect`, `sort_reply`, `list_documents`).

Try asking:

> "Research jane@acme.com, score her fit and write me a first email."

> "Here's what she replied. What does it mean and what should I say?"

> "Add this deck to my Outbind brain."

## Free preview vs free account

`learn` is free and reads one page. A free Outbind account grows the brain:

| | No account | Free account |
| --- | :---: | :---: |
| `brain.md` from a website | ✓ | ✓ |
| Learns from your decks, docs and notes | | ✓ |
| Remembers every prospect between sessions | | ✓ |
| Writes emails from your brain | | ✓ |
| Learns from your edits and what gets replies | | ✓ |
| Free email verifier | | ✓ |

Make one from the terminal (you type the 6-digit code from your email):

```
npx @outbindai/cli signup you@company.com
```

Or sign up at [outbind.ai](https://app.outbind.ai/sign-up?utm_source=github&utm_medium=readme&utm_campaign=obi_brain).

## Commands

```
outbind learn <website>        Any company's website -> brain.md (no account)
outbind signup <email>         Free account, from the terminal
outbind login                  Sign in with your browser
outbind docs add <file>        Teach the brain from PDF, Word, PowerPoint, text, Markdown or CSV
outbind docs                   What the brain learned
outbind tools                  The brain tools you can run
outbind run <tool> k=v         Run one
outbind mcp                    How to connect Outbind over MCP
outbind help                   Everything else
```

Needs Node 20 or newer. No dependencies.

To install it globally: `npm install -g @outbindai/cli`, then use `outbind` directly.

## Playbook

[`playbook/first-emails.md`](playbook/first-emails.md) has plain-English notes on writing first emails that get replies. Agents can read it directly.

## Privacy and safety

- This is the open-source client. The brain lives on Outbind's servers.
- It never sends emails, finds leads or spends money for you.
- `learn` reads only a site's public home page and respects its robots.txt.
- Your sign-in is saved only on your computer (`~/.config/outbind`). Remove it with `outbind logout`.

## License

[MIT](LICENSE)
